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
const entryPoints: ReadonlyArray<readonly [file: string, pdfjs: string]> = [
  ["src/pdf/pdfjs-renderer.ts", "pdfjs-dist"],
  ["src/pdf/pdf-worker.ts", "pdfjs-dist/build/pdf.worker.mjs"],
];

/**
 * Only what actually runs, in the order it runs: `^import` at the start of a
 * line skips comments and specifiers quoted inside other code, and `import
 * type` is dropped because it is erased before anything executes. The
 * non-greedy body spans the multi-line named-import forms.
 */
const STATIC_VALUE_IMPORT = /^import\s+(?!type\s)[\s\S]*?["']([^"']+)["'];/gm;

function importedModules(source: string): string[] {
  return [...source.matchAll(STATIC_VALUE_IMPORT)].map(
    ([, specifier]) =>
      // `?worker&url` and friends are Vite query suffixes, not part of the id.
      specifier.split("?")[0],
  );
}

describe("polyfill import order", () => {
  it.each(entryPoints)(
    "imports the polyfills before pdf.js in %s",
    (file, pdfjs) => {
      // Vitest runs from the project root.
      const modules = importedModules(readFileSync(path.resolve(file), "utf8"));
      const polyfillsIndex = modules.indexOf("./polyfills");
      const pdfjsIndex = modules.indexOf(pdfjs);

      expect(polyfillsIndex).toBeGreaterThanOrEqual(0);
      expect(pdfjsIndex).toBeGreaterThanOrEqual(0);
      expect(polyfillsIndex).toBeLessThan(pdfjsIndex);
    },
  );

  it("reads past comments, type imports and multi-line import forms", () => {
    const source = [
      '// import "./pdf-first-in-a-comment";',
      'import type { Thing } from "./a-type-only-import";',
      'import "./polyfills";',
      "import {",
      "  something,",
      "  type SomeType,",
      '} from "pdfjs-dist";',
      'import url from "./pdf-worker?worker&url";',
    ].join("\n");

    expect(importedModules(source)).toEqual([
      "./polyfills",
      "pdfjs-dist",
      "./pdf-worker",
    ]);
  });
});
