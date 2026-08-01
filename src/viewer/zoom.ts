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

export function applyZoomCommand(zoom: number, command: ZoomCommand): number {
  switch (command) {
    case "in":
      return steppedZoom(zoom, 1);
    case "out":
      return steppedZoom(zoom, -1);
    case "reset":
      return DEFAULT_ZOOM;
  }
}
