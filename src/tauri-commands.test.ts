import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A Tauri command has to be listed in three places that nothing checks against
 * each other:
 *
 * - `generate_handler!` in `src-tauri/src/lib.rs`, so it is dispatched at all
 * - `COMMANDS` in `src-tauri/build.rs`, so tauri-build generates an
 *   `allow-<command>` permission for it
 * - `permissions` in `src-tauri/capabilities/default.json`, so the window is
 *   actually granted that permission
 *
 * Missing either of the last two does not fail the build, and does not fail
 * any test that mocks `invoke` — the call is simply denied at the IPC layer at
 * runtime. That is how `register_pdf_path` shipped unusable in #40: every
 * sidecar call then failed with `pathNotAllowed`, because the allow-list it
 * feeds was never populated.
 */
describe("Tauri commands are wired up end to end", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tauri = (...parts: string[]) => join(here, "..", "src-tauri", ...parts);

  /**
   * Command names inside `generate_handler![...]`, without their module path.
   * Anchored to the `invoke_handler` call it is passed to, rather than to
   * `generate_handler!` alone: the macro's name appearing anywhere else — a
   * doc comment, a second handler set for another window — would otherwise be
   * what got parsed, and the mismatch would surface as a confusing failure
   * somewhere else entirely.
   */
  function handlerCommands(): string[] {
    const source = readFileSync(tauri("src", "lib.rs"), "utf-8");
    const block =
      /\.invoke_handler\(\s*tauri::generate_handler!\[(.*?)\]\s*\)/s.exec(
        source,
      );
    if (!block) {
      throw new Error("lib.rs has no invoke_handler(generate_handler![...])");
    }
    return (
      block[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        // `sidecar::load_notes` and a bare `greet` both name one command.
        .map((entry) => entry.split("::").pop() as string)
    );
  }

  /**
   * The `COMMANDS` array tauri-build generates permissions from. Read up to
   * the `];` that closes it rather than to the first `]`, so a comment or
   * string holding one inside the array does not cut the list short — which
   * would quietly drop commands from the comparison instead of failing.
   */
  function buildCommands(): string[] {
    const source = readFileSync(tauri("build.rs"), "utf-8");
    const block = /const COMMANDS: &\[&str\] = &\[(.*?)\];/s.exec(source);
    if (!block) throw new Error("build.rs has no COMMANDS array");
    return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  }

  /** Plain string permissions granted to the main window. */
  function grantedPermissions(): string[] {
    const capability = JSON.parse(
      readFileSync(tauri("capabilities", "default.json"), "utf-8"),
    ) as { permissions?: unknown[] };
    return (capability.permissions ?? []).filter(
      (entry): entry is string => typeof entry === "string",
    );
  }

  /** `load_notes` → `allow-load-notes`, the name tauri-build generates. */
  const permissionFor = (command: string) =>
    `allow-${command.replaceAll("_", "-")}`;

  it("registers every dispatched command in build.rs COMMANDS", () => {
    const declared = new Set(buildCommands());
    const missing = handlerCommands().filter(
      (command) => !declared.has(command),
    );
    expect(missing).toEqual([]);
  });

  it("grants every dispatched command a permission on the main window", () => {
    const granted = new Set(grantedPermissions());
    const missing = handlerCommands().filter(
      (command) => !granted.has(permissionFor(command)),
    );
    expect(missing).toEqual([]);
  });

  it("does not declare commands that are never dispatched", () => {
    const dispatched = new Set(handlerCommands());
    const stale = buildCommands().filter((command) => !dispatched.has(command));
    expect(stale).toEqual([]);
  });

  it("reads a plausible command list rather than an empty one", () => {
    // Guards the parsing above: a regex that stopped matching would otherwise
    // make every assertion here pass vacuously.
    expect(handlerCommands()).toContain("register_pdf_path");
    expect(handlerCommands().length).toBeGreaterThan(10);
  });
});
