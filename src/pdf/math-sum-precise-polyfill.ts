/**
 * Installs {@link sumPrecise} as `Math.sumPrecise` when the engine has no
 * implementation of its own.
 *
 * pdf.js 6 calls `Math.sumPrecise` from both the main bundle and the worker,
 * and the WKWebView that Tauri embeds on macOS does not have it -- opening any
 * document fails with "Math.sumPrecise is not a function". The `legacy` build
 * carries the same calls, so this is the way out.
 *
 * Import this module for its side effect *above* any import of pdf.js: module
 * evaluation follows import order, so the polyfill is in place before pdf.js
 * runs.
 */
import { sumPrecise } from "./math-sum-precise";

declare global {
  interface Math {
    sumPrecise?(values: Iterable<number>): number;
  }
}

if (typeof Math.sumPrecise !== "function") {
  Object.defineProperty(Math, "sumPrecise", {
    value: sumPrecise,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
