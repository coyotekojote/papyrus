import { useEffect, useState } from "react";
import type { ViewMode } from "./spreads";

/**
 * Below this width the viewer switches to its "compact" layout (issue #11):
 * sidebars overlay the pages instead of sharing the row with them, and a
 * two-page spread is never the starting view mode. iPhones in portrait sit
 * well under this; iPads and desktop windows sit well over it — the number
 * itself matters less than that split.
 */
export const COMPACT_BREAKPOINT_PX = 700;

/** `matchMedia` query for {@link COMPACT_BREAKPOINT_PX}. */
export const COMPACT_MEDIA_QUERY = `(max-width: ${COMPACT_BREAKPOINT_PX - 1}px)`;

/**
 * What the document should open in. A two-page spread does not fit a compact
 * screen at all, so it overrides the app setting there regardless of what the
 * reader configured — the setting still applies as soon as the window (or the
 * device orientation) is wide enough for it to make sense.
 */
export function defaultViewModeForScreen(
  settingsViewMode: ViewMode,
  isCompact: boolean,
): ViewMode {
  return isCompact ? "single" : settingsViewMode;
}

/**
 * Tracks whether the viewport currently matches the compact breakpoint.
 * `window.matchMedia` is unavailable in some test environments (jsdom without
 * the polyfill some suites add); those fall back to `false`, i.e. never
 * compact, which is the safer default for a desktop-shaped test.
 */
export function useIsCompactScreen(): boolean {
  const [isCompact, setIsCompact] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(COMPACT_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(COMPACT_MEDIA_QUERY);
    const onChange = () => setIsCompact(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return isCompact;
}
