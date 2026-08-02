/**
 * Thin wrapper around `performance.mark`/`measure` for the hot paths tracked
 * by Issue #12 (file read, renderer open, page sizes, first page render).
 *
 * Both `markStart` and `markEnd` are dev-only no-ops in production: a
 * reader's machine has no dev tools open to read the console log, and a mark
 * nothing ever measures is pointless to keep. That matters for `markStart`
 * in particular — production skipping it is what keeps a start mark from
 * piling up forever on a document the reader keeps open for hours.
 */

/** Suffix distinguishing this module's start marks from any others on the timeline. */
const START_SUFFIX = ":start";

/**
 * Not just "does `performance` exist" — some older WebViews expose the
 * global but not the full API this module calls (`mark`/`measure` are the
 * oldest and most likely to be present; `getEntriesByName`/`clearMarks`/
 * `clearMeasures` less certain). Checking each one is what actually backs
 * the "safe to call anywhere" claim the functions below make.
 */
function hasPerformance(): boolean {
  return (
    typeof performance !== "undefined" &&
    typeof performance.mark === "function" &&
    typeof performance.measure === "function" &&
    typeof performance.getEntriesByName === "function" &&
    typeof performance.clearMarks === "function" &&
    typeof performance.clearMeasures === "function"
  );
}

/**
 * Starts timing `name`. Pair with {@link markEnd} — or, if the measurement
 * turns out to be abandoned partway (the operation aborted, say), with
 * {@link clearStart} so the mark does not linger unmeasured. Safe to call
 * anywhere the Performance API is unavailable (e.g. very old WebViews) — it
 * is then a no-op, same as outside dev.
 *
 * `isDev` defaults to the build's dev flag but takes an explicit override so
 * this stays unit-testable without faking Vite's env injection.
 */
export function markStart(
  name: string,
  isDev: boolean = import.meta.env.DEV,
): void {
  if (!hasPerformance() || !isDev) return;
  performance.mark(`${name}${START_SUFFIX}`);
}

/**
 * Ends timing `name` and, in dev, logs the duration since the matching
 * {@link markStart}. Returns the duration in milliseconds, or `undefined`
 * when it could not be measured (missing start mark, or outside dev — the
 * measurement is skipped there too, not just the log, so marks do not pile
 * up on a document the reader keeps open for hours).
 *
 * `isDev` defaults to the build's dev flag but takes an explicit override so
 * this stays unit-testable without faking Vite's env injection.
 */
export function markEnd(
  name: string,
  isDev: boolean = import.meta.env.DEV,
): number | undefined {
  if (!hasPerformance() || !isDev) return undefined;
  const startMark = `${name}${START_SUFFIX}`;
  if (performance.getEntriesByName(startMark, "mark").length === 0) {
    return undefined;
  }
  try {
    const measure = performance.measure(name, startMark);
    console.debug(`[perf] ${name}: ${measure.duration.toFixed(1)}ms`);
    return measure.duration;
  } finally {
    performance.clearMarks(startMark);
    performance.clearMeasures(name);
  }
}

/**
 * Discards `name`'s start mark without measuring it — for a `markStart` whose
 * matching `markEnd` will never come (the operation it was timing was
 * abandoned, e.g. by an abort) and that should not stick around as leftover
 * state for whatever timing attempt comes next.
 *
 * `isDev` defaults to the build's dev flag but takes an explicit override so
 * this stays unit-testable without faking Vite's env injection.
 */
export function clearStart(
  name: string,
  isDev: boolean = import.meta.env.DEV,
): void {
  if (!hasPerformance() || !isDev) return;
  performance.clearMarks(`${name}${START_SUFFIX}`);
}
