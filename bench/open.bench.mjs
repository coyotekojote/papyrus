#!/usr/bin/env node
// Node-side benchmark for Issue #12: measures the parts of the pdf.js hot
// path that run without a DOM (getDocument, getPage, getViewport). Raster
// rendering needs an HTMLCanvasElement, which Node does not have without an
// extra `canvas` native dependency — that half of the picture is only
// measured by hand in a dev build (see docs/performance.md).
//
// Usage: `npm run bench` (regenerates bench/fixtures/bench.pdf on first run).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = path.join(projectRoot, "bench", "fixtures", "bench.pdf");
const RUNS = 5;
const PAGE_SIZE_CHUNK = 32;

function ensureFixture() {
  if (existsSync(fixturePath)) return;
  console.log("Generating bench fixture...");
  execFileSync(
    process.execPath,
    [path.join(projectRoot, "scripts", "generate-bench-pdf.mjs")],
    { stdio: "inherit" },
  );
}

/** Opens the fixture and reads getDocument time plus all page sizes, batched
 * the same way `loadPageSizes` batches them in the app. */
async function measureOpen(data) {
  const openStart = performance.now();
  const task = getDocument({
    // pdf.js transfers (neuters) the buffer it is handed, same as the app's
    // renderer.open() — each run needs its own copy, or the second run's
    // postMessage throws on an already-detached buffer.
    data: data.slice(),
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const doc = await task.promise;
  const openMs = performance.now() - openStart;

  const sizesStart = performance.now();
  const firstChunkPages = Math.min(PAGE_SIZE_CHUNK, doc.numPages);
  let firstChunkMs = 0;
  for (let start = 1; start <= doc.numPages; start += PAGE_SIZE_CHUNK) {
    const end = Math.min(start + PAGE_SIZE_CHUNK - 1, doc.numPages);
    await Promise.all(
      Array.from({ length: end - start + 1 }, async (_, i) => {
        const page = await doc.getPage(start + i);
        return page.getViewport({ scale: 1 });
      }),
    );
    if (end === firstChunkPages) firstChunkMs = performance.now() - sizesStart;
  }
  const allSizesMs = performance.now() - sizesStart;

  await task.destroy();
  return { openMs, firstChunkMs, allSizesMs, totalMs: openMs + allSizesMs };
}

function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(
    `${label}: mean=${mean.toFixed(1)}ms median=${median.toFixed(1)}ms ` +
      `min=${sorted[0].toFixed(1)}ms max=${sorted.at(-1).toFixed(1)}ms (n=${samples.length})`,
  );
  return { mean, median, min: sorted[0], max: sorted.at(-1) };
}

async function main() {
  ensureFixture();
  const data = new Uint8Array(readFileSync(fixturePath));
  console.log(
    `Fixture: ${fixturePath} (${(data.length / 1024).toFixed(0)} KiB)`,
  );

  const open = [];
  const firstChunk = [];
  const allSizes = [];
  const total = [];

  for (let i = 0; i < RUNS; i += 1) {
    const result = await measureOpen(data);
    open.push(result.openMs);
    firstChunk.push(result.firstChunkMs);
    allSizes.push(result.allSizesMs);
    total.push(result.totalMs);
  }

  console.log(`\n--- pdf.js open benchmark (${RUNS} runs) ---`);
  summarize("getDocument", open);
  summarize(`first ${PAGE_SIZE_CHUNK} page sizes`, firstChunk);
  summarize("all page sizes", allSizes);
  summarize("open + all page sizes (current openPath blocking cost)", total);
}

await main();
