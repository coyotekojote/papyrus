import type { PageSize } from "../pdf";
import { fitZoomForSpreads, PAGE_GAP, SPREAD_PADDING } from "./layout";
import type { Spread } from "./spreads";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 6;
export const DEFAULT_ZOOM = 1;

/** Discrete stops used by the Cmd/Ctrl +/- shortcuts and the toolbar buttons. */
export const ZOOM_STEPS: readonly number[] = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6,
];

/** Zoom applied per unit of pinch (ctrl+wheel) delta. */
const PINCH_SENSITIVITY = 0.01;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

/** Next stop above (`direction: 1`) or below (`-1`) the current zoom. */
export function steppedZoom(zoom: number, direction: 1 | -1): number {
  const current = clampZoom(zoom);
  const epsilon = 1e-6;
  const next =
    direction === 1
      ? ZOOM_STEPS.find((step) => step > current + epsilon)
      : [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon);
  return clampZoom(next ?? current);
}

/**
 * Pinch-to-zoom. Browsers report a trackpad pinch as a wheel event with
 * `ctrlKey` set; zooming exponentially keeps the gesture feeling linear.
 */
export function pinchZoom(zoom: number, deltaY: number): number {
  if (!Number.isFinite(deltaY)) return clampZoom(zoom);
  return clampZoom(clampZoom(zoom) * Math.exp(-deltaY * PINCH_SENSITIVITY));
}

/**
 * The zoom the reader sees. `fit` is the default (issue #68): the viewer
 * picks whatever zoom shows the widest spread in full, recomputed whenever
 * the viewport changes — opening the notes panel or resizing the window no
 * longer clips a spread against the sidebar. `manual` is pinned to a value
 * the reader chose (toolbar, keyboard, or a pinch) and stops tracking the
 * viewport until reset back to `fit`.
 */
export type ZoomState = { mode: "fit" } | { mode: "manual"; value: number };

/**
 * The zoom that shows every spread in full, given the current viewport. Only
 * ever shrinks to fit (issue #68) — a roomy window still shows pages at
 * their natural 100%, it never magnifies a spread past `DEFAULT_ZOOM` just
 * because there is space to spare. Falls back to `DEFAULT_ZOOM` before the
 * viewport has been measured (`viewportWidth` is 0 on first render), when
 * the viewport is too narrow to fit even the padding, or when there is no
 * spread yet to size against — see `fitZoomForSpreads` for how the gap
 * between a spread's pages (fixed, not scaled by zoom) is accounted for.
 */
export function fitZoom(
  viewportWidth: number,
  spreads: readonly Spread[],
  pageSizes: readonly PageSize[],
  padding = SPREAD_PADDING,
  gap = PAGE_GAP,
): number {
  if (viewportWidth <= 0) return DEFAULT_ZOOM;
  const availableWidth = viewportWidth - 2 * padding;
  const tightest = fitZoomForSpreads(spreads, pageSizes, availableWidth, gap);
  if (tightest === null) return DEFAULT_ZOOM;
  return clampZoom(Math.min(DEFAULT_ZOOM, tightest));
}

export type ZoomCommand = "in" | "out" | "reset";

/**
 * Maps a keyboard event to a zoom command: Cmd/Ctrl with `+`, `-` or `0`.
 * Returns null when the event is not a zoom shortcut.
 */
export function zoomCommandForKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
}): ZoomCommand | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.key === "=" || event.key === "+") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "reset";
  return null;
}

/**
 * Applies a zoom command against the zoom currently on screen. `in`/`out`
 * step from that *effective* zoom (whatever `fit` last resolved to, or the
 * standing manual value) and switch to `manual` — from here the reader is in
 * control, and the viewport tracking that fit did stops. `reset` hands
 * control back to `fit` (issue #68) rather than snapping to a fixed 100%, so
 * Cmd+0 undoes a manual zoom into whatever now fits the viewport.
 */
export function applyZoomCommand(
  effectiveZoom: number,
  command: ZoomCommand,
): ZoomState {
  switch (command) {
    case "in":
      return { mode: "manual", value: steppedZoom(effectiveZoom, 1) };
    case "out":
      return { mode: "manual", value: steppedZoom(effectiveZoom, -1) };
    case "reset":
      return { mode: "fit" };
  }
}
