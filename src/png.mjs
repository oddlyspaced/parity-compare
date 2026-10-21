// A PNG reader with no dependencies beyond Node's own zlib.
//
// This exists because the thing it replaces did not. The previous comparator shelled out to
// ImageMagick and read a number from `compare -metric AE`. In ImageMagick 7.1.2-32 that number
// quietly stopped being a count of differing pixels and became a sum of normalised per-channel
// magnitudes: a 40x40 red rectangle over white, which is 1600 differing pixels, reported 800, and
// the same rectangle in rgb(254,254,254) reported 4.71. Every measurement taken through it was
// wrong by a factor that depended on which channels differed, and nothing said so.
//
// A comparison you cannot reproduce is not evidence. So this reads the pixels itself.

import zlib from "node:zlib";
import fs from "node:fs";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PngError extends Error {}

/** Decoded image: width, height, and RGBA bytes, four per pixel. */
export class Image {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data;
  }
  /** Byte offset of (x, y). */
  index(x, y) {
    return (y * this.width + x) * 4;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverses the per-scanline filter PNG applies before compression. */
function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = pos;
    pos += stride;
    const o = y * stride;
    const prior = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[line + i];
      const a = i >= bytesPerPixel ? out[o + i - bytesPerPixel] : 0;
      const b = y > 0 ? out[prior + i] : 0;
      const c = i >= bytesPerPixel && y > 0 ? out[prior + i - bytesPerPixel] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: throw new PngError(`unknown scanline filter ${filter} on row ${y}`);
      }
      out[o + i] = value & 0xff;
    }
  }
  return out;
}

/** Decodes an 8-bit, non-interlaced PNG to RGBA. */
export function decodePng(buffer) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buffer[i] !== SIGNATURE[i]) throw new PngError("not a PNG: signature does not match");
  }
  let pos = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length; // length + type + data + crc
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") transparency = Buffer.from(body);
    else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
  }
  if (!header) throw new PngError("no IHDR chunk");
  const { width, height, bitDepth, colorType, interlace } = header;
  if (bitDepth !== 8) throw new PngError(`bit depth ${bitDepth} is not supported, only 8`);
  if (interlace !== 0) throw new PngError("interlaced PNGs are not supported");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new PngError(`colour type ${colorType} is not supported`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const expected = height * (width * channels + 1);
  if (raw.length < expected) throw new PngError(`truncated image data: ${raw.length} of ${expected} bytes`);
  const flat = unfilter(raw, width, height, channels);

  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s];
    } else if (colorType === 2) {
      rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2];
    } else if (colorType === 3) {
      if (!palette) throw new PngError("palette image with no PLTE chunk");
      const p = flat[s] * 3;
      rgba[d] = palette[p]; rgba[d + 1] = palette[p + 1]; rgba[d + 2] = palette[p + 2];
      if (transparency && flat[s] < transparency.length) rgba[d + 3] = transparency[flat[s]];
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = flat[s + 1];
    } else {
      rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = flat[s + 3];
    }
  }
  return new Image(width, height, rgba);
}

export function readPng(file) {
  return decodePng(fs.readFileSync(file));
}
