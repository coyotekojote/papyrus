/**
 * A `Math.sumPrecise` implementation for engines that lack it.
 *
 * The algorithm is Shewchuk's exact expansion sum (the one CPython's
 * `math.fsum` uses): the running total is kept as a list of non-overlapping
 * partials that together represent the sum exactly, and only the final
 * collapse rounds -- once, to nearest-even. A naive left-to-right sum rounds
 * once per addend, so cancelling terms lose their low bits before they can
 * contribute.
 */

/**
 * Folds `value` into `partials`, keeping the invariant that the partials are
 * non-overlapping and sum to the exact total seen so far.
 */
function accumulate(partials: number[], value: number): void {
  let x = value;
  let kept = 0;
  for (const partial of partials) {
    let y = partial;
    if (Math.abs(x) < Math.abs(y)) {
      const swap = x;
      x = y;
      y = swap;
    }
    // hi is the rounded sum, lo the exact rounding error (Fast2Sum, valid
    // because |x| >= |y|). A zero error means y was absorbed exactly.
    const hi = x + y;
    const lo = y - (hi - x);
    if (lo !== 0) partials[kept++] = lo;
    x = hi;
  }
  partials.length = kept;
  partials.push(x);
}

/**
 * Collapses the exact partials into the single nearest double.
 *
 * Adding them largest-first would round twice; instead the two largest are
 * combined and the remaining partials are only consulted to break a tie, which
 * is what makes the result correctly rounded rather than merely close.
 */
function collapse(partials: number[]): number {
  let index = partials.length;
  if (index === 0) return 0;

  let hi = partials[--index];
  let lo = 0;
  while (index > 0) {
    const x = hi;
    const y = partials[--index];
    hi = x + y;
    lo = y - (hi - x);
    if (lo !== 0) break;
  }

  // `hi` landed exactly halfway between two doubles and was rounded to even.
  // If the partials below it push in the same direction as `lo`, the true sum
  // is past the halfway point and the other neighbour is the closer double.
  if (
    index > 0 &&
    ((lo < 0 && partials[index - 1] < 0) || (lo > 0 && partials[index - 1] > 0))
  ) {
    const y = lo * 2;
    const x = hi + y;
    if (y === x - hi) hi = x;
  }
  return hi;
}

/**
 * Sums `values` with a single rounding at the end.
 *
 * Matches the `Math.sumPrecise` proposal: an empty iterable sums to `-0`, as
 * does a run of nothing but `-0`; a `NaN` element, or both infinities
 * together, give `NaN`.
 *
 * One deliberate gap: a partial can overflow to `Infinity` even when the true
 * sum is finite (adding `Number.MAX_VALUE` twice and then subtracting it
 * once). Handling that needs the sum carried in a wider representation, which
 * is not worth it for the only caller this exists for.
 */
export function sumPrecise(values: Iterable<number>): number {
  const partials: number[] = [];
  let empty = true;
  let sawNaN = false;
  let sawPositiveInfinity = false;
  let sawNegativeInfinity = false;
  let onlyNegativeZero = true;

  for (const value of values) {
    empty = false;
    if (typeof value !== "number") {
      throw new TypeError(
        `Math.sumPrecise expects numbers, got ${typeof value}`,
      );
    }
    if (Number.isNaN(value)) {
      sawNaN = true;
    } else if (value === Infinity) {
      sawPositiveInfinity = true;
    } else if (value === -Infinity) {
      sawNegativeInfinity = true;
    } else {
      if (!Object.is(value, -0)) onlyNegativeZero = false;
      // Skipping zeros keeps the partial list short; they change nothing.
      if (value !== 0) accumulate(partials, value);
    }
  }

  if (sawNaN || (sawPositiveInfinity && sawNegativeInfinity)) return NaN;
  if (sawPositiveInfinity) return Infinity;
  if (sawNegativeInfinity) return -Infinity;
  if (empty || onlyNegativeZero) return -0;
  return collapse(partials);
}
