/**
 * Fills in the recent JavaScript APIs that pdf.js 6 calls and the WKWebView
 * Tauri embeds on macOS does not have.
 *
 * pdf.js reaches for stage-3-era builtins (`Math.sumPrecise`,
 * `Map.prototype.getOrInsertComputed`) with no fallback of its own, and its
 * `legacy` build carries the same calls, so opening a document fails with
 * "... is not a function". Everything here is feature-detected, so an engine
 * that already ships an API keeps its own.
 *
 * Import this module for its side effect *above* any import of pdf.js: module
 * evaluation follows import order, so the patches are in place before pdf.js
 * runs. The worker is a separate realm and needs its own import -- see
 * `../pdf-worker.ts`.
 */
import {
  getOrInsert,
  getOrInsertComputed,
  type MapLike,
} from "./get-or-insert";
import { sumPrecise } from "./sum-precise";

declare global {
  interface Math {
    sumPrecise?(values: Iterable<number>): number;
  }
  interface Map<K, V> {
    getOrInsert?(key: K, value: V): V;
    getOrInsertComputed?(key: K, callbackfn: (key: K) => V): V;
  }
  interface WeakMap<K extends WeakKey, V> {
    getOrInsert?(key: K, value: V): V;
    getOrInsertComputed?(key: K, callbackfn: (key: K) => V): V;
  }
}

/** Builtins are non-enumerable and replaceable; a plain assignment is neither. */
function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

if (typeof Math.sumPrecise !== "function") {
  define(Math, "sumPrecise", sumPrecise);
}

// The proposal puts both methods on WeakMap as well, and pdf.js caches through
// both kinds of map.
const mapPrototypes: Array<Map<unknown, unknown> | WeakMap<WeakKey, unknown>> =
  [Map.prototype, WeakMap.prototype];

for (const prototype of mapPrototypes) {
  if (typeof prototype.getOrInsert !== "function") {
    define(
      prototype,
      "getOrInsert",
      function (this: MapLike<unknown, unknown>, key: unknown, value: unknown) {
        return getOrInsert(this, key, value);
      },
    );
  }
  if (typeof prototype.getOrInsertComputed !== "function") {
    define(
      prototype,
      "getOrInsertComputed",
      function (
        this: MapLike<unknown, unknown>,
        key: unknown,
        callbackfn: (key: unknown) => unknown,
      ) {
        return getOrInsertComputed(this, key, callbackfn);
      },
    );
  }
}
