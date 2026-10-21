import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { decodePng, PngError } from "../src/png.mjs";
import { findBands, alignBands, luma } from "../src/bands.mjs";
import { compareScreens } from "../src/compare.mjs";
import { parseArgs, pairScreens, masksFor, UsageError } from "../src/cli.mjs";

// ---------------------------------------------------------------------------
// A PNG writer, so the tests build their own images instead of shipping fixtures.

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGBA bytes as an 8-bit colour-type-6 PNG with no filtering. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A white canvas with filled rectangles, as [x, y, w, h, r, g, b]. */
function canvas(width, height, rects = []) {
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (const [x, y, w, h, r, g, b] of rects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = (yy * width + xx) * 4;
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      }
    }
  }
  return decodePng(encodePng(width, height, rgba));
}

// ---------------------------------------------------------------------------
// png.mjs

test("png: decodes what it encodes, pixel for pixel", () => {
  const im = canvas(8, 4, [[2, 1, 3, 2, 10, 20, 30]]);
  assert.equal(im.width, 8);
  assert.equal(im.height, 4);
  const i = im.index(3, 2);
  assert.deepEqual([im.data[i], im.data[i + 1], im.data[i + 2], im.data[i + 3]], [10, 20, 30, 255]);
  const j = im.index(0, 0);
  assert.deepEqual([im.data[j], im.data[j + 1], im.data[j + 2]], [255, 255, 255]);
});

test("png: refuses what it cannot read rather than guessing", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), PngError);
});

test("png: every scanline filter reverses to the same image", () => {
  // Filters are chosen by the encoder, so an image is decoded correctly only if all five reverse.
  const width = 6;
  const height = 5;
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (i * 7) & 0xff;
    rgba[i * 4 + 1] = (i * 13) & 0xff;
    rgba[i * 4 + 2] = (i * 29) & 0xff;
  }
  const stride = width * 4;
  for (const filter of [0, 1, 2, 3, 4]) {
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = filter;
      for (let i = 0; i < stride; i++) {
        const cur = rgba[y * stride + i];
        const a = i >= 4 ? rgba[y * stride + i - 4] : 0;
        const b = y > 0 ? rgba[(y - 1) * stride + i] : 0;
        const c = i >= 4 && y > 0 ? rgba[(y - 1) * stride + i - 4] : 0;
        let sub;
        if (filter === 0) sub = cur;
        else if (filter === 1) sub = cur - a;
        else if (filter === 2) sub = cur - b;
        else if (filter === 3) sub = cur - ((a + b) >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          sub = cur - pred;
        }
        raw[y * (stride + 1) + 1 + i] = sub & 0xff;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
    assert.deepEqual([...decodePng(png).data], [...rgba], `filter ${filter}`);
  }
});

// ---------------------------------------------------------------------------
// bands.mjs

test("bands: finds the strips that carry content, and ignores thin specks", () => {
  const im = canvas(40, 60, [[5, 10, 30, 8, 0, 0, 0], [5, 40, 30, 10, 0, 0, 0], [5, 30, 30, 1, 0, 0, 0]]);
  const bands = findBands(im);
  assert.equal(bands.length, 2, "the one-pixel speck is not a band");
  assert.deepEqual([bands[0].top, bands[0].height], [10, 8]);
  assert.deepEqual([bands[1].top, bands[1].height], [40, 10]);
});

test("bands: a masked region cannot create a band", () => {
  // A clock in the status bar changes every run. Letting it define a band makes every run disagree.
  const im = canvas(40, 60, [[5, 2, 30, 6, 0, 0, 0], [5, 40, 30, 10, 0, 0, 0]]);
  const masked = (x, y) => y < 12;
  assert.equal(findBands(im).length, 2);
  assert.equal(findBands(im, { masked }).length, 1);
});

test("bands: a band that changed height pairs with itself, it does not vanish", () => {
  const a = [{ top: 0, bottom: 95, height: 96 }];
  const b = [{ top: 0, bottom: 87, height: 88 }];
  const { pairs, onlyA, onlyB } = alignBands(a, b);
  assert.equal(pairs.length, 1);
  assert.equal(onlyA.length, 0);
  assert.equal(onlyB.length, 0);
});

test("bands: a band with nothing to pair with is reported as missing", () => {
  const a = [{ top: 0, bottom: 20, height: 21 }, { top: 500, bottom: 530, height: 31 }];
  const b = [{ top: 0, bottom: 20, height: 21 }];
  const { pairs, onlyA } = alignBands(a, b);
  assert.equal(pairs.length, 1);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].band.top, 500);
});

test("bands: alignment keeps order", () => {
  const a = [{ top: 0, height: 10, bottom: 9 }, { top: 100, height: 10, bottom: 109 }];
  const b = [{ top: 100, height: 10, bottom: 109 }, { top: 0, height: 10, bottom: 9 }];
  const { pairs } = alignBands(a, b);
  for (let i = 1; i < pairs.length; i++) {
    assert.ok(pairs[i].aIndex > pairs[i - 1].aIndex && pairs[i].bIndex > pairs[i - 1].bIndex);
  }
});

test("bands: luma weights green most, as the eye does", () => {
  assert.ok(luma(0, 255, 0) > luma(255, 0, 0));
  assert.ok(luma(255, 0, 0) > luma(0, 0, 255));
});

// ---------------------------------------------------------------------------
// compare.mjs — the standard

test("compare: identical screens pass", () => {
  const rects = [[10, 20, 60, 20, 0, 0, 0], [10, 80, 60, 20, 0, 0, 0]];
  const r = compareScreens(canvas(100, 140, rects), canvas(100, 140, rects));
  assert.equal(r.verdict, "pass");
  assert.equal(r.position.maxOffset, 0);
  assert.equal(r.content.worstBandRatio, 0);
});

test("compare: a shifted element is drift, and the offset is reported once", () => {
  // This is the case a percentage-of-pixels diff gets wrong. The second element moved two pixels;
  // everything about it is otherwise identical, and the report should say that and not call it a
  // failure.
  const a = compareScreens(
    canvas(100, 140, [[10, 20, 60, 20, 0, 0, 0], [10, 80, 60, 20, 0, 0, 0]]),
    canvas(100, 140, [[10, 20, 60, 20, 0, 0, 0], [10, 82, 60, 20, 0, 0, 0]]),
  );
  assert.equal(a.verdict, "drift");
  assert.equal(a.structure.matched, 2, "both elements are still there");
  assert.equal(a.position.maxOffset, 2);
  assert.ok(a.content.worstBandRatio < 0.01, "content is the same once the offset is removed");
  assert.ok(a.raw.ratio > a.content.worstBandRatio, "the raw diff overstates it");
});

test("compare: a missing element fails, however few pixels it is", () => {
  const r = compareScreens(
    canvas(100, 140, [[10, 20, 60, 20, 0, 0, 0], [10, 80, 60, 20, 0, 0, 0]]),
    canvas(100, 140, [[10, 20, 60, 20, 0, 0, 0]]),
  );
  assert.equal(r.verdict, "fail");
  assert.equal(r.structure.missingInNative.length, 1);
});

test("compare: an element in the right place with the wrong content fails", () => {
  const r = compareScreens(
    canvas(100, 140, [[10, 20, 60, 20, 0, 0, 0]]),
    canvas(100, 140, [[10, 20, 60, 20, 220, 30, 30]]),
  );
  assert.equal(r.verdict, "fail");
  assert.equal(r.structure.matched, 1);
  assert.ok(r.content.worstBandRatio > 0.5);
});

test("compare: a masked region cannot fail a screen", () => {
  const masks = [{ x0: 0, y0: 0, x1: 100, y1: 60 }];
  const r = compareScreens(
    canvas(100, 140, [[10, 20, 60, 20, 0, 0, 0], [10, 80, 60, 20, 0, 0, 0]]),
    canvas(100, 140, [[10, 20, 60, 20, 220, 30, 30], [10, 80, 60, 20, 0, 0, 0]]),
    { masks },
  );
  assert.equal(r.verdict, "pass");
});

test("compare: different image sizes fail rather than compare the overlap", () => {
  const r = compareScreens(canvas(100, 140), canvas(100, 120));
  assert.equal(r.verdict, "fail");
  assert.ok(r.sizeMismatch);
});

test("compare: the raw number is still reported, it is just not the verdict", () => {
  const r = compareScreens(
    canvas(100, 140, [[10, 80, 60, 20, 0, 0, 0]]),
    canvas(100, 140, [[10, 82, 60, 20, 0, 0, 0]]),
  );
  assert.ok(r.raw.ratio > 0);
  assert.equal(r.verdict, "drift");
});

// ---------------------------------------------------------------------------
// cli.mjs

test("cli: rejects unknown options and missing values", () => {
  assert.throws(() => parseArgs(["--nope", "x"]), UsageError);
  assert.throws(() => parseArgs(["--a"]), UsageError);
  assert.throws(() => parseArgs(["--a", "x"]), UsageError, "b is required too");
  assert.throws(() => parseArgs(["--a", "x", "--b", "y", "--colour-tolerance", "no"]), UsageError);
});

test("cli: two files compare as one screen", () => {
  const screens = pairScreens("/tmp/a/home.png", "/tmp/b/home.png");
  assert.equal(screens.length, 1);
  assert.equal(screens[0].name, "home");
});

test("cli: masks are fractions, so one file fits any scale", () => {
  const masks = masksFor({ home: [{ x: 0, y: 0, w: 0.5, h: 0.25, reason: "status bar" }] }, "home", 1000, 2000);
  assert.deepEqual(masks, [{ x0: 0, y0: 0, x1: 500, y1: 500, reason: "status bar" }]);
  assert.deepEqual(masksFor(null, "home", 10, 10), []);
});
