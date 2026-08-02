#!/usr/bin/env node
// Generates a synthetic large PDF for `npm run bench` to open. Not part of
// the app bundle or the test suite — it only feeds bench/open.bench.mjs.
//
// Output goes to bench/fixtures/ (gitignored): regenerating it is cheap and
// committing a 300-page PDF to the repo is not worth it.

import { deflateSync } from "node:zlib";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE_COUNT = 300;
const IMAGE_SIZE = 256;

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesDir = path.join(projectRoot, "bench", "fixtures");
const outputPath = path.join(fixturesDir, "bench.pdf");

/** CRC32 table, computed once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Minimal 8-bit RGB PNG encoder: just enough to give pdf.js a real image to decode. */
function makePng(width, height, [r, g, b]) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const pixelStart = rowStart + 1 + x * 3;
      // A gentle gradient so the compressed data is not trivially uniform.
      raw[pixelStart] = (r + x) & 0xff;
      raw[pixelStart + 1] = (g + y) & 0xff;
      raw[pixelStart + 2] = b;
    }
  }
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

async function main() {
  if (existsSync(outputPath)) {
    console.log(`${outputPath} already exists, skipping generation.`);
    return;
  }
  mkdirSync(fixturesDir, { recursive: true });

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // One image embedded once and reused on every page: this fixture is meant
  // to stress per-page open/layout costs, not asset decoding.
  const png = makePng(IMAGE_SIZE, IMAGE_SIZE, [30, 90, 160]);
  const image = await pdf.embedPng(png);

  for (let i = 1; i <= PAGE_COUNT; i += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawImage(image, {
      x: 50,
      y: 792 - 50 - IMAGE_SIZE,
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
    });
    page.drawText(`Benchmark fixture — page ${i} of ${PAGE_COUNT}`, {
      x: 50,
      y: 792 - 80 - IMAGE_SIZE,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
    for (let line = 0; line < 20; line += 1) {
      page.drawText(
        `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Line ${line}.`,
        {
          x: 50,
          y: 792 - 110 - IMAGE_SIZE - line * 16,
          size: 10,
          font,
          color: rgb(0.2, 0.2, 0.2),
        },
      );
    }
  }

  const bytes = await pdf.save();
  writeFileSync(outputPath, bytes);
  console.log(
    `Wrote ${outputPath} (${PAGE_COUNT} pages, ${bytes.length} bytes)`,
  );
}

await main();
