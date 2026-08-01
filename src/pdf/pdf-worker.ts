// pdf.js's worker, wrapped so the polyfills are installed inside the worker
// realm too -- patching the main thread does not reach it, and the worker is
// where document loading actually calls the missing builtins.
import "./polyfills";
import "pdfjs-dist/build/pdf.worker.mjs";
