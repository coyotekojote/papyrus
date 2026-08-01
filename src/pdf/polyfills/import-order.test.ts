import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The polyfills have to be evaluated before pdf.js, and the only thing holding
 * that is the order of two import statements. Nothing in the toolchain sorts
 * imports today, but nothing stops one being added either -- and the breakage
 * would only show up as the original failure inside a WKWebView, which no test
 * environment reproduces. So assert the order on the source.
 */
const entryPoints: ReadonlyArray<readonly [file: string, pdfjs: string]> = [
  ["src/pdf/pdfjs-renderer.ts", "pdfjs-dist"],
  ["src/pdf/pdf-worker.ts", "pdfjs-dist/build/pdf.worker.mjs"],
];

/**
 * The modules a file imports for their side effects or values, in evaluation
 * order. Parsed rather than matched: only a real parser can tell an import
 * from the same characters sitting in a comment or a template literal, and
 * `import type` is dropped because it is erased before anything executes.
 */
function importedModules(source: string): string[] {
  const parsed = ts.createSourceFile(
    "entry.ts",
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  return parsed.statements
    .filter(ts.isImportDeclaration)
    .filter((statement) => !statement.importClause?.isTypeOnly)
    .map((statement) =>
      ts.isStringLiteral(statement.moduleSpecifier)
        ? // `?worker&url` and friends are Vite query suffixes, not part of the id.
          statement.moduleSpecifier.text.split("?")[0]
        : "",
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

  it("reads type imports, multi-line forms and query suffixes", () => {
    const source = [
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

  it("ignores imports that only look like imports", () => {
    const source = [
      '// import "./in-a-line-comment";',
      "/*",
      'import "./in-a-block-comment";',
      "*/",
      "const snippet = `",
      'import "./in-a-template-literal";',
      "`;",
      'import "./the-only-real-one";',
    ].join("\n");

    expect(importedModules(source)).toEqual(["./the-only-real-one"]);
  });

  it("finds nothing to order when the polyfill import is gone", () => {
    expect(importedModules('import "pdfjs-dist";')).toEqual(["pdfjs-dist"]);
    expect(importedModules('import "pdfjs-dist";').indexOf("./polyfills")).toBe(
      -1,
    );
  });
});
