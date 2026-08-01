/// <reference types="vitest/config" />
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * pdf.js loads CMaps, standard fonts and its WASM decoders over HTTP at
 * runtime. They are copied out of node_modules into `public/pdfjs/` (ignored by
 * git) so they ship with the bundle instead of being fetched from a CDN, which
 * the app's CSP forbids and an offline desktop app cannot rely on.
 */
function pdfjsRuntimeAssets(): Plugin {
  return {
    name: "papyrus:pdfjs-runtime-assets",
    buildStart() {
      const require = createRequire(import.meta.url);
      const pdfjsRoot = path.dirname(
        require.resolve("pdfjs-dist/package.json"),
      );
      const target = path.resolve(import.meta.dirname, "public/pdfjs");
      mkdirSync(target, { recursive: true });
      for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
        cpSync(path.join(pdfjsRoot, dir), path.join(target, dir), {
          recursive: true,
        });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsRuntimeAssets()],

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
