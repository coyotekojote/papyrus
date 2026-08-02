/**
 * How urgently a page needs the (single, worker-serialized) renderer's
 * attention. Ordered highest first — `"prefetch"` is not implemented by any
 * caller yet (issue #35, step 3: the idle background warm-up in
 * `PdfViewer`), but is defined here already so the ranking below never has to
 * be revisited to add it.
 */
export type RenderPriority = "visible" | "overscan" | "prefetch";

const PRIORITY_RANK: Readonly<Record<RenderPriority, number>> = {
  visible: 0,
  overscan: 1,
  prefetch: 2,
};

interface QueuedTask {
  priority: RenderPriority;
  signal: AbortSignal;
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
  /**
   * Drops this task from the queue and settles it, for as long as it is
   * still waiting to run. Replaced with a no-op the instant it starts
   * running (see {@link RenderQueue.drain}): an abort that arrives after
   * that point is entirely `run`'s own job to notice via `signal`, the same
   * way `PdfJsDocument.renderPage` reacts to it with `RenderTask.cancel()`.
   */
  onQueuedAbort: () => void;
}

/**
 * Serializes page renders behind a single slot, in priority order, so that a
 * page actually on screen never waits behind pages the reader has already
 * scrolled past.
 *
 * pdf.js's worker is itself single-threaded: every `renderPage` call this app
 * makes eventually funnels through it regardless of what this queue does. Left
 * unmanaged (the pre-#35 behaviour), a burst of page turns queues each
 * spread's renders in whatever order their `PageCanvas`es happened to mount —
 * first in, first drawn, even once the reader has moved on. Routing every
 * call through here instead means a later, higher-priority request (the
 * spread the reader is looking at *now*) always dequeues ahead of an earlier,
 * lower-priority one still waiting for its turn.
 *
 * Concurrency is fixed at 1: the point is not to parallelize renders (the
 * worker cannot anyway) but to control *which one goes next*, which only
 * matters when there is a next to choose from a queue rather than a single
 * dispatched call.
 */
export class RenderQueue {
  private readonly queue: QueuedTask[] = [];
  private draining = false;

  /**
   * Queues `run` to be called with `signal` once every higher- (or
   * equal-priority, earlier-queued) task has finished. Same-priority tasks
   * run FIFO; a higher-priority `schedule` call always dequeues ahead of a
   * lower-priority one already waiting, no matter which was queued first.
   *
   * If `signal` is already aborted, or is aborted before this task's turn
   * comes up, `run` never starts and the returned promise **resolves**
   * (never rejects) — mirroring `PdfJsDocument.renderPage`'s own early exit
   * on a pre-aborted signal, so a caller that already treats "aborted before
   * it could do anything" as a non-event (every caller in this codebase
   * does, via `if (controller.signal.aborted) return` in the `.catch`) needs
   * no special case for going through a queue instead of calling straight
   * through. Once `run` has actually started, an abort is passed on to it
   * via `signal` exactly as if there were no queue at all — cancelling is
   * `run`'s job from that point on, not this class's.
   *
   * If `run` rejects, the returned promise rejects the same way, but the
   * queue itself is unaffected: the next task starts regardless.
   */
  schedule(
    priority: RenderPriority,
    run: (signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const task: QueuedTask = {
        priority,
        signal,
        run,
        resolve,
        reject,
        onQueuedAbort: () => {},
      };
      task.onQueuedAbort = () => {
        const index = this.queue.indexOf(task);
        // Already dequeued (running, or just finished) — nothing to remove,
        // and the abort from here on is `run`'s own concern.
        if (index === -1) return;
        this.queue.splice(index, 1);
        signal.removeEventListener("abort", task.onQueuedAbort);
        resolve();
      };
      signal.addEventListener("abort", task.onQueuedAbort);

      this.insert(task);
      this.drain();
    });
  }

  /** Inserts after the last task of equal-or-higher priority, so FIFO order
   * within a priority falls out of insertion order alone. */
  private insert(task: QueuedTask): void {
    const rank = PRIORITY_RANK[task.priority];
    let index = this.queue.length;
    for (let i = 0; i < this.queue.length; i += 1) {
      if (PRIORITY_RANK[this.queue[i].priority] > rank) {
        index = i;
        break;
      }
    }
    this.queue.splice(index, 0, task);
  }

  private drain(): void {
    if (this.draining) return;
    const task = this.queue.shift();
    if (!task) return;

    // Past this point the task is no longer "queued and removable" — an
    // abort now is for `run` to notice via `signal` itself.
    task.signal.removeEventListener("abort", task.onQueuedAbort);
    this.draining = true;

    // The next task is started *before* this one's own promise settles
    // (rather than in a trailing `.finally`): a caller awaiting `schedule`'s
    // result should see the queue having already moved on, not a queue that
    // looks stalled for one more microtask after the task it was waiting on
    // resolved. Wrapped in `Promise.resolve().then(...)` so a `run` that
    // throws synchronously (rather than returning a rejected promise) still
    // lands on `task.reject` instead of escaping as an unhandled exception.
    const advance = () => {
      this.draining = false;
      this.drain();
    };
    Promise.resolve()
      .then(() => task.run(task.signal))
      .then(
        () => {
          advance();
          task.resolve();
        },
        (cause: unknown) => {
          advance();
          task.reject(cause);
        },
      );
  }
}
