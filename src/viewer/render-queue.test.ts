import { describe, expect, it, vi } from "vitest";
import { RenderQueue, type RenderPriority } from "./render-queue";

/** A promise whose resolution/rejection is controlled from outside — the
 * queue only ever starts one task at a time, so tests that care about order
 * need to hold a task open until they have asserted on it. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A `run` that starts recorded in `started`, then waits on the returned
 * deferred before resolving — the shape every ordering test needs. */
function controlledTask(started: string[], label: string) {
  const gate = deferred();
  const run = vi.fn(async () => {
    started.push(label);
    await gate.promise;
  });
  return { run, resolve: () => gate.resolve(undefined) };
}

describe("RenderQueue", () => {
  it("runs a single task", async () => {
    const queue = new RenderQueue();
    const run = vi.fn(async () => {});

    await queue.schedule("visible", run, new AbortController().signal);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs same-priority tasks in FIFO order", async () => {
    const queue = new RenderQueue();
    const started: string[] = [];
    const a = controlledTask(started, "a");
    const b = controlledTask(started, "b");
    const controller = new AbortController();

    const p1 = queue.schedule("visible", a.run, controller.signal);
    const p2 = queue.schedule("visible", b.run, controller.signal);

    // Only "a" has been dequeued; "b" is still waiting behind it.
    await Promise.resolve();
    expect(started).toEqual(["a"]);

    a.resolve();
    await p1;
    expect(started).toEqual(["a", "b"]);

    b.resolve();
    await p2;
  });

  it("always dequeues a higher-priority task ahead of an already-queued lower one", async () => {
    const queue = new RenderQueue();
    const started: string[] = [];
    const busy = controlledTask(started, "busy");
    const overscan = controlledTask(started, "overscan");
    const visible = controlledTask(started, "visible");
    const controller = new AbortController();

    // Occupies the single slot so both later calls queue up behind it.
    const pBusy = queue.schedule("visible", busy.run, controller.signal);
    await Promise.resolve();
    expect(started).toEqual(["busy"]);

    const pOverscan = queue.schedule(
      "overscan",
      overscan.run,
      controller.signal,
    );
    const pVisible = queue.schedule("visible", visible.run, controller.signal);

    busy.resolve();
    await pBusy;
    // "visible" was queued after "overscan", but outranks it and must run
    // first regardless.
    await Promise.resolve();
    expect(started).toEqual(["busy", "visible"]);

    visible.resolve();
    await pVisible;
    await Promise.resolve();
    expect(started).toEqual(["busy", "visible", "overscan"]);

    overscan.resolve();
    await pOverscan;
  });

  it("removes a task from the queue and never starts it if its signal aborts before its turn", async () => {
    const queue = new RenderQueue();
    const started: string[] = [];
    const busy = controlledTask(started, "busy");
    const neverRuns = vi.fn(async () => {});
    const controller = new AbortController();
    const abortedController = new AbortController();

    const pBusy = queue.schedule("visible", busy.run, controller.signal);
    await Promise.resolve();
    expect(started).toEqual(["busy"]);

    const pNeverRuns = queue.schedule(
      "overscan",
      neverRuns,
      abortedController.signal,
    );
    abortedController.abort();

    busy.resolve();
    await pBusy;
    // Resolves rather than rejects: a caller cancelling before a task ever
    // started needs no special case beyond what it already does for a
    // straight (queue-less) render's own pre-abort exit.
    await expect(pNeverRuns).resolves.toBeUndefined();
    expect(neverRuns).not.toHaveBeenCalled();
  });

  it("propagates an abort of a running task's signal into the signal passed to run", async () => {
    const queue = new RenderQueue();
    const gate = deferred();
    const run = vi.fn(async (signal: AbortSignal) => {
      // Read via `run.mock.calls` below, once `controller.abort()` has run —
      // referencing it here too keeps both eslint and tsc satisfied that the
      // parameter is used.
      void signal;
      await gate.promise;
    });
    const controller = new AbortController();

    const scheduled = queue.schedule("visible", run, controller.signal);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    controller.abort();
    const [signal] = run.mock.calls[0];
    expect(signal.aborted).toBe(true);

    gate.resolve();
    await scheduled;
  });

  it("continues to the next task after a running task's run rejects, and rejects that task's own promise", async () => {
    const queue = new RenderQueue();
    const started: string[] = [];
    const failure = new Error("render failed");
    const failing = vi.fn(async () => {
      started.push("failing");
      throw failure;
    });
    const next = controlledTask(started, "next");
    const controller = new AbortController();

    const pFailing = queue.schedule("visible", failing, controller.signal);
    const pNext = queue.schedule("visible", next.run, controller.signal);

    await expect(pFailing).rejects.toBe(failure);
    await Promise.resolve();
    expect(started).toEqual(["failing", "next"]);

    next.resolve();
    await pNext;
  });

  it("runs several pending tasks strictly one at a time, never overlapping", async () => {
    const queue = new RenderQueue();
    let concurrent = 0;
    let maxConcurrent = 0;
    const controller = new AbortController();

    const make = () =>
      vi.fn(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 0));
        concurrent -= 1;
      });

    const tasks = [make(), make(), make(), make()];
    await Promise.all(
      tasks.map((run) => queue.schedule("visible", run, controller.signal)),
    );

    for (const run of tasks) expect(run).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
  });

  it("resolves immediately without running when the signal is already aborted at schedule time", async () => {
    const queue = new RenderQueue();
    const run = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort();

    await expect(
      queue.schedule("visible", run, controller.signal),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a defined ranking across all three priorities: visible, then overscan, then prefetch", async () => {
    const queue = new RenderQueue();
    const started: string[] = [];
    const busy = controlledTask(started, "busy");
    const controller = new AbortController();

    const pBusy = queue.schedule("visible", busy.run, controller.signal);
    await Promise.resolve();

    const order: RenderPriority[] = ["prefetch", "overscan", "visible"];
    const tasks = order.map((priority) => controlledTask(started, priority));
    const promises = order.map((priority, index) =>
      queue.schedule(priority, tasks[index].run, controller.signal),
    );

    busy.resolve();
    await pBusy;
    for (const task of tasks) {
      await Promise.resolve();
      task.resolve();
    }
    await Promise.all(promises);

    expect(started).toEqual(["busy", "visible", "overscan", "prefetch"]);
  });
});
