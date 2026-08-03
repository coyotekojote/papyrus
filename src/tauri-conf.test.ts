import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression test for issue #42: the production CSP silently blocked Tauri's
 * IPC fetch because `connect-src` was unset (falling back to `default-src
 * 'self'`). This does not exercise the CSP itself — that only takes effect
 * in the embedded webview — it just pins the config so the directive cannot
 * quietly disappear again.
 *
 * `connect-src` must also keep `'self'`: once the directive is explicit it
 * no longer falls back to `default-src`, and pdf.js fetches its cmaps/fonts
 * (see src/pdf/pdfjs-renderer.ts) from the same origin at runtime. Dropping
 * `'self'` here would silently break that same-origin fetch again.
 */
describe("tauri.conf.json CSP", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  function readCsp(): string {
    const configPath = join(here, "..", "src-tauri", "tauri.conf.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      app?: { security?: { csp?: string } };
    };
    const csp = config.app?.security?.csp;
    if (typeof csp !== "string") {
      throw new Error("tauri.conf.json is missing app.security.csp");
    }
    return csp;
  }

  it("declares a connect-src directive", () => {
    const csp = readCsp();
    const directive = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("connect-src "));

    expect(directive).toBeDefined();
  });

  it("allows both IPC origins Tauri v2 needs (macOS/iOS and Windows/Linux) and same-origin fetches pdf.js relies on", () => {
    const csp = readCsp();
    const directive = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("connect-src "));

    const sources = directive?.split(/\s+/).slice(1) ?? [];
    expect(sources).toContain("ipc:");
    expect(sources).toContain("http://ipc.localhost");
    expect(sources).toContain("'self'");
  });
});
