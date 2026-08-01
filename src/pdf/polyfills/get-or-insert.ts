/**
 * `Map.prototype.getOrInsert` / `getOrInsertComputed` for engines that lack
 * them, written to be installable on `WeakMap` too -- the proposal adds them
 * to both, and pdf.js caches through both kinds of map.
 *
 * They are written as free functions taking the map explicitly so they can be
 * tested without touching the global prototypes.
 */

/** The slice of Map/WeakMap these need; keeps one implementation for both. */
export interface MapLike<K, V> {
  has(key: K): boolean;
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
}

export function getOrInsert<K, V>(map: MapLike<K, V>, key: K, value: V): V {
  if (map.has(key)) return map.get(key) as V;
  map.set(key, value);
  return value;
}

export function getOrInsertComputed<K, V>(
  map: MapLike<K, V>,
  key: K,
  callbackfn: (key: K) => V,
): V {
  if (map.has(key)) return map.get(key) as V;
  const value = callbackfn(key);
  // Unconditionally, even though the key was absent a moment ago: the callback
  // is free to have inserted one itself, and the proposal has the computed
  // value win.
  map.set(key, value);
  return value;
}
