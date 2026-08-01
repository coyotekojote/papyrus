import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The polyfills have to be evaluated before pdf.js, and the only thing holding
 * that is the order of two import statements. Nothing in the toolchain sorts
 * imports today, but nothing stops one being added either -- and the breakage
 * would only show up as the original failure inside a WKWebView, which no test
 * environment reproduces. So assert the order on the source text.
 */
const entryPoints: ReadonlyArray<readonly [file: string, pdfjsImport: string]> =
  [
    ["src/pdf/pdfjs-renderer.ts", 'from "pdfjs-dist"'],
    ["src/pdf/pdf-worker.ts", 'import "pdfjs-dist/build/pdf.worker.mjs"'],
  ];

describe("polyfill import order", () => {
  it.each(entryPoints)(
    "imports the polyfills before pdf.js in %s",
    (file, pdfjsImport) => {
      // Vitest runs from the project root.
      const source = readFileSync(path.resolve(file), "utf8");
      const polyfills = source.indexOf('import "./polyfills"');
      const pdfjs = source.indexOf(pdfjsImport);

      expect(polyfills).toBeGreaterThanOrEqual(0);
      expect(pdfjs).toBeGreaterThanOrEqual(0);
      expect(polyfills).toBeLessThan(pdfjs);
    },
  );
});
