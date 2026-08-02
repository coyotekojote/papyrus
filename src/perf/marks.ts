/**
 * Thin wrapper around `performance.mark`/`measure` for the hot paths tracked
 * by Issue #12 (file read, renderer open, page sizes, first page render).
 *
 * `performance.mark` itself is cheap enough to leave in production builds —
 * what is guarded is the console noise: a reader's machine has no dev tools
 * open to read it, and even the marks themselves are pointless to keep once
 * nothing consumes them, so `markEnd` skips both the measure and the log
 * outside dev.
 */

/** Suffix distinguishing this module's start marks from any others on the timeline. */
const START_SUFFIX = ":start";

function hasPerformance(): boolean {
  return typeof performance !== "undefined";
}

/** Starts timing `name`. Pair with {@link markEnd}. Safe to call anywhere the
 * Performance API is unavailable (e.g. very old WebViews) — it is then a no-op. */
export function markStart(name: string): void {
  if (!hasPerformance()) return;
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
