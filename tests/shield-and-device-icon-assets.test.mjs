// Regression tests for the 2026-09-20 visual fixes:
//
//  1. The HCG shield mark's bottom point was clipped flush against its
//     source PNG's own canvas edge (zero bottom margin — verified by
//     direct pixel inspection: mobile/assets/shield-mark.png's alpha
//     bounding box used to end exactly at the canvas height). This is
//     an asset-level defect, not a container/resizeMode bug — no CSS/
//     style change in mobile/app/(tabs)/index.tsx could have fixed it.
//     Replaced with a version re-derived from the existing (unused)
//     shield-mark-padded-master.png source, cropped and re-padded
//     symmetrically. This test decodes the real PNG pixels and proves
//     a genuine margin exists on every side, so a future asset export
//     can't silently reintroduce the clip.
//
//  2. mobile/app/(setup)/device-picker.tsx's iPhone/Android options used
//     Ionicons' generic logo-apple/logo-android glyphs. Replaced with
//     real image assets — an Android "bugdroid" silhouette (Google
//     open-licenses this mark, CC BY 3.0, for exactly this kind of
//     third-party single-colour use) and a generic, non-trademarked
//     smartphone-device silhouette for iPhone (Apple's own logo is not
//     free for third-party apps to use to represent "iPhone").
//
// No image-processing library exists in this project's dependencies
// (deliberately not adding one for this) — the PNG alpha-bbox check
// below is a small self-contained decoder (zlib inflate + PNG scanline
// unfiltering), good enough for 8-bit RGBA, non-interlaced PNGs, which
// is what this project's asset pipeline (Pillow) always produces.
//
// Run with: node tests/shield-and-device-icon-assets.test.mjs

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsRoot = path.join(__dirname, '..', 'mobile', 'assets');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// Decodes an 8-bit RGBA, non-interlaced PNG into { width, height, alphaBBox }.
// alphaBBox is [left, top, right, bottom] (right/bottom exclusive), the
// bounding box of pixels with alpha > 0, or null if the image is fully
// transparent.
function decodePngAlphaBBox(filePath) {
  const buf = readFileSync(filePath);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + filePath);

  let offset = 8;
  let width, height, bitDepth, colorType, interlace;
  const idatChunks = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    offset += 8 + length + 4; // length + type + data + crc
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}) in ${filePath} — this decoder only handles 8-bit RGBA, non-interlaced`);
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);

  let rawOffset = 0;
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const row = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const outRow = pixels.subarray(y * stride, (y + 1) * stride);

    for (let x = 0; x < stride; x++) {
      const a = row[x];
      const b = x >= bytesPerPixel ? outRow[x - bytesPerPixel] : 0;
      const c = prevRow[x];
      const d = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;
      let predictor;
      switch (filterType) {
        case 0: predictor = 0; break;
        case 1: predictor = b; break;
        case 2: predictor = c; break;
        case 3: predictor = Math.floor((b + c) / 2); break;
        case 4: {
          const p = b + c - d;
          const pa = Math.abs(p - b), pb = Math.abs(p - c), pc = Math.abs(p - d);
          predictor = (pa <= pb && pa <= pc) ? b : (pb <= pc ? c : d);
          break;
        }
        default: throw new Error('unsupported PNG filter type ' + filterType);
      }
      outRow[x] = (a + predictor) & 0xff;
    }
    prevRow = outRow;
  }

  let left = width, top = height, right = 0, bottom = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[y * stride + x * bytesPerPixel + 3];
      if (alpha > 0) {
        found = true;
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
        if (y < top) top = y;
        if (y + 1 > bottom) bottom = y + 1;
      }
    }
  }

  return { width, height, alphaBBox: found ? [left, top, right, bottom] : null };
}

// ============================================================
// 1. Shield mark — bottom-clip regression
// ============================================================

const shield = decodePngAlphaBBox(path.join(assetsRoot, 'shield-mark.png'));
check(shield.alphaBBox !== null, 'shield-mark.png has real (non-fully-transparent) content');

if (shield.alphaBBox) {
  const [left, top, right, bottom] = shield.alphaBBox;
  const bottomMargin = shield.height - bottom;
  const topMargin = top;
  const leftMargin = left;
  const rightMargin = shield.width - right;

  check(
    bottomMargin > 0,
    `the shield's bottom point is no longer clipped flush against the canvas edge (bottom margin = ${bottomMargin}px, was 0px before this fix)`
  );
  check(
    bottomMargin >= shield.height * 0.05,
    `the bottom margin (${bottomMargin}px) is a real, comfortable margin — not just 1-2 stray anti-aliased pixels (>= 5% of the ${shield.height}px canvas height)`
  );
  check(
    Math.abs(topMargin - bottomMargin) < shield.height * 0.1,
    `top (${topMargin}px) and bottom (${bottomMargin}px) margins are reasonably balanced, so the shield reads as vertically centred, not just "not clipped"`
  );
  check(
    Math.abs(leftMargin - rightMargin) < shield.width * 0.1,
    `left (${leftMargin}px) and right (${rightMargin}px) margins are reasonably balanced, so the shield reads as horizontally centred`
  );
}

// ============================================================
// 2. New device-icon assets exist and have real content
// ============================================================

for (const name of ['android-device-mark.png', 'iphone-device-mark.png']) {
  const decoded = decodePngAlphaBBox(path.join(assetsRoot, name));
  check(decoded.alphaBBox !== null, `${name} exists, decodes as a valid PNG, and has real (non-fully-transparent) content`);
}

// ============================================================
// 3. device-picker.tsx wiring — generic glyphs gone, real assets used,
//    no emoji anywhere in this screen's device options.
// ============================================================

const devicePickerSource = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'device-picker.tsx'),
  'utf8'
);

check(
  !devicePickerSource.includes('icon: "logo-apple"') && !devicePickerSource.includes('icon: "logo-android"'),
  'device-picker.tsx no longer uses the generic Ionicons logo-apple/logo-android glyphs (the explanatory comment above DEVICE_OPTIONS is allowed to name them for context — only actual usage is checked)'
);
check(
  devicePickerSource.includes('require("../../assets/android-device-mark.png")') &&
    devicePickerSource.includes('require("../../assets/iphone-device-mark.png")'),
  'device-picker.tsx wires in the real Android and iPhone device-mark image assets'
);
check(
  devicePickerSource.includes('iconSource ? (') &&
    devicePickerSource.includes('<Image source={iconSource}'),
  'the device option cards render an <Image> for the new icon assets, not another Ionicons glyph'
);
check(
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(devicePickerSource),
  'no emoji characters anywhere in device-picker.tsx (the device-selection UI this fix targets)'
);
check(
  devicePickerSource.includes('icon: "call"'),
  'the landline option keeps its existing generic Ionicons "call" glyph — only the platform-brand icons changed'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
