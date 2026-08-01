// pdf.js's worker, wrapped so the `Math.sumPrecise` polyfill is installed
// inside the worker realm too -- a main-thread polyfill does not reach it, and
// the worker is where document loading actually calls it.
import "./math-sum-precise-polyfill";
import "pdfjs-dist/build/pdf.worker.mjs";
