#!/usr/bin/env node
// Pack the rendered icon sizes into a Windows .ico.
//
// The Windows executable icon is a derived asset: `docs/logo.svg` is the
// design source and `docs/logo.ico` is rendered from it. This script is the
// second half of that derivation — it takes the per-size PNGs and writes the
// icon directory — and it is committed so the asset can be regenerated
// without rediscovering the format.
//
// Usage:
//   node tools/make-icon.mjs <png-dir> <out.ico>
//
// The PNGs are named `logo-<size>.png` and have to be square, with the sizes
// the file explorer asks for. Any renderer will do; the output does not
// depend on which one was used, only on the pixels it produced.

import fs from "node:fs";
import path from "node:path";

/** The sizes the file explorer asks for. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** The PNG signature every entry has to start with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The width and height a PNG header carries. */
function pngSize(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG image");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

const [pngDir, outFile] = process.argv.slice(2);
if (!pngDir || !outFile) {
  console.error("usage: node tools/make-icon.mjs <png-dir> <out.ico>");
  process.exit(2);
}

const entries = SIZES.map((size) => {
  const file = path.join(pngDir, `logo-${size}.png`);
  const data = fs.readFileSync(file);
  const { width, height } = pngSize(data);

  if (width !== size || height !== size) {
    throw new Error(`${file} is ${width}x${height}, expected ${size}x${size}`);
  }

  return { size, data };
});

// The icon directory: a six byte header followed by one sixteen byte entry
// per image, then the images themselves.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4); // image count

let offset = header.length + entries.length * 16;
const directory = Buffer.alloc(entries.length * 16);

entries.forEach((entry, index) => {
  const base = index * 16;
  // The size is a byte, and 256 does not fit into one, so it is written as 0.
  directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base);
  directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
  directory.writeUInt8(0, base + 2); // palette size
  directory.writeUInt8(0, base + 3); // reserved
  directory.writeUInt16LE(1, base + 4); // colour planes
  directory.writeUInt16LE(32, base + 6); // bits per pixel
  directory.writeUInt32LE(entry.data.length, base + 8);
  directory.writeUInt32LE(offset, base + 12);
  offset += entry.data.length;
});

fs.writeFileSync(outFile, Buffer.concat([header, directory, ...entries.map((e) => e.data)]));
console.log(`wrote ${outFile} (${offset} bytes, ${entries.length} sizes)`);
