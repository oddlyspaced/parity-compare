// The comparison itself.
//
// The standard here is that a screen comparison reports three things and never collapses them into
// one number:
//
//   structure  are the same elements present, in the same order
//   position   where they sit, and by how much that differs
//   content    whether the matched elements look the same, measured after the offset is removed
//
// A single "percentage of pixels that differ" cannot tell those apart, and the difference matters.
// A row that is two pixels taller than its counterpart shifts every row below it, so a two-pixel
// layout difference is reported as tens of thousands of differing pixels and the screen is called a
// failure. The screens are, in that case, identical to look at. Reporting the offset once, where it
// starts, says what is actually wrong and how much.
//
// Nothing here hides a difference. An offset is still reported, and a screen with offsets is not
// called a pass. It is called drift, which is a thing a person has to look at and accept.

import { findBands, alignBands, luma } from "./bands.mjs";

export const VERSION = "1.0.0";

export const DEFAULTS = {
  /** Per-channel difference, 0-255, above which two pixels are not the same colour. */
  colourTolerance: 16,
  /** Fraction of a band's pixels that may differ before the band is not the same content. */
  contentThreshold: 0.02,
  /** Vertical offset, in pixels, that is accepted without comment. */
  offsetTolerance: 0,
  /**
   * How far away a matching pixel may be before a pixel counts as different. 1 absorbs subpixel
   * text rendering; 0 turns the neighbourhood check off and counts every edge.
   */
  antialiasRadius: 1,
};

/** True when two pixels differ by more than `tolerance` on any channel. */
function pixelDiffers(a, ai, b, bi, tolerance) {
  return (
    Math.abs(a[ai] - b[bi]) > tolerance ||
    Math.abs(a[ai + 1] - b[bi + 1]) > tolerance ||
    Math.abs(a[ai + 2] - b[bi + 2]) > tolerance
  );
}

/**
 * True when a pixel has no match anywhere in the other image's neighbourhood.
 *
 * Two text renderers almost never put a glyph's edge on exactly the same subpixel, so a line of text
 * that reads identically still differs along every edge. Counting those is what makes a screenshot
 * diff report thousands of differing pixels for two images a person cannot tell apart.
 *
 * A pixel is only counted when nothing within `radius` of the same position matches it. A glyph edge
 * that moved by a fraction of a pixel finds its match and is not counted; a glyph that is absent, a
 * different shape, or the wrong colour finds nothing and is. The radius is small on purpose: anything
 * that moved further than this is a layout difference, and layout differences are reported by the
 * position measurement, not hidden here.
 */
function pixelUnmatched(a, ai, b, bImage, x, y, tolerance, radius) {
  for (let dy = -radius; dy <= radius; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= bImage.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= bImage.width) continue;
      if (!pixelDiffers(a, ai, b, bImage.index(nx, ny), tolerance)) return false;
    }
  }
  return true;
}

function inMask(masks, x, y) {
  for (const m of masks) {
    if (x >= m.x0 && x < m.x1 && y >= m.y0 && y < m.y1) return true;
  }
  return false;
}

/**
 * Compares one band pair with the vertical offset removed.
 *
 * Only the rows the two bands have in common are compared; a height difference is reported as such
 * rather than counted as differing pixels, because padding one band with background would make a
 * height difference look like a content difference.
 */
/** Differing-pixel count for one candidate offset. `step` samples columns when searching. */
function bandDifference(rnImage, natImage, pair, offset, opts, step = 1) {
  const { colourTolerance, masks, antialiasRadius: radius = 1 } = opts;
  const rows = Math.min(pair.a.height, pair.b.height);
  const width = Math.min(rnImage.width, natImage.width);
  let compared = 0;
  let differing = 0;
  for (let r = 0; r < rows; r++) {
    const ay = pair.a.top + r;
    const by = pair.a.top + r + offset;
    if (by < 0 || by >= natImage.height) continue;
    for (let x = 0; x < width; x += step) {
      if (inMask(masks, x, ay)) continue;
      compared++;
      const ai = rnImage.index(x, ay);
      if (!pixelDiffers(rnImage.data, ai, natImage.data, natImage.index(x, by), colourTolerance)) continue;
      if (radius <= 0 || pixelUnmatched(rnImage.data, ai, natImage.data, natImage, x, by, colourTolerance, radius)) {
        differing++;
      }
    }
  }
  return { compared, differing };
}

export function compareBand(rnImage, natImage, pair, opts) {
  const detected = pair.b.top - pair.a.top;
  // The offset that actually lines the content up, not the one the band edges imply.
  //
  // A band's top edge is found from antialiased ink, so it can sit a pixel out even when the text
  // inside matches exactly. Comparing at that edge offset then reports every text row as different
  // and the band looks badly broken when it is one pixel adrift. The search is bounded and the
  // offset it settles on is reported, so nothing is hidden: a band that needs a shift is still a
  // band that moved.
  const span = opts.offsetSearch ?? 6;
  // Candidates are tried from the detected offset outwards, and a candidate only wins on strictly
  // fewer differing pixels. Ties therefore keep the smallest shift. Scanning from one end instead
  // reports a shift for two identical images: a solid block matches itself at several offsets, and
  // whichever was tried first won.
  const candidates = [detected];
  for (let d = 1; d <= span; d++) candidates.push(detected - d, detected + d);
  let offset = detected;
  let best = Infinity;
  for (const candidate of candidates) {
    const { differing } = bandDifference(rnImage, natImage, pair, candidate, opts, 4);
    if (differing < best) { best = differing; offset = candidate; }
  }
  const { compared, differing } = bandDifference(rnImage, natImage, pair, offset, opts, 1);
  return {
    detectedOffset: detected,
    rn: { top: pair.a.top, height: pair.a.height },
    native: { top: pair.b.top, height: pair.b.height },
    offset,
    heightDelta: pair.b.height - pair.a.height,
    comparedPixels: compared,
    differingPixels: differing,
    ratio: compared ? differing / compared : 0,
  };
}

/** Raw, unaligned pixel difference over the whole image. Reported for contrast, never as the verdict. */
export function rawDifference(rnImage, natImage, opts) {
  const { colourTolerance, masks } = opts;
  const width = Math.min(rnImage.width, natImage.width);
  const height = Math.min(rnImage.height, natImage.height);
  let compared = 0;
  let differing = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inMask(masks, x, y)) continue;
      compared++;
      if (pixelDiffers(rnImage.data, rnImage.index(x, y), natImage.data, natImage.index(x, y), colourTolerance)) {
        differing++;
      }
    }
  }
  return { comparedPixels: compared, differingPixels: differing, ratio: compared ? differing / compared : 0 };
}

/**
 * Compares two screenshots of the same screen.
 *
 * The verdict is the worst of the three measurements:
 *   fail   an element is missing or extra, the two images are different sizes, or a matched
 *          element's content differs by more than `contentThreshold`
 *   drift  everything matches, but something sits at a different offset or a different height
 *   pass   same elements, same places, same content
 */
export function compareScreens(rnImage, natImage, options = {}) {
  const opts = { ...DEFAULTS, masks: [], bandOptions: {}, ...options };
  const sizeMismatch =
    rnImage.width !== natImage.width || rnImage.height !== natImage.height
      ? { rn: [rnImage.width, rnImage.height], native: [natImage.width, natImage.height] }
      : null;

  // Band detection uses the same masks as the comparison, so a region the masks exclude cannot
  // decide where a band starts or ends.
  const masked = (x, y) => inMask(opts.masks, x, y);
  const bandOpts = { masked, ...opts.bandOptions };
  const rnBands = findBands(rnImage, bandOpts);
  const natBands = findBands(natImage, bandOpts);
  const { pairs, onlyA, onlyB } = alignBands(rnBands, natBands);

  const bands = pairs.map((p) => compareBand(rnImage, natImage, p, opts));
  const worstContent = bands.reduce((w, b) => (b.ratio > w ? b.ratio : w), 0);
  const offsets = bands.map((b) => b.offset);
  const maxOffset = offsets.reduce((m, o) => Math.max(m, Math.abs(o)), 0);
  const firstOffset = bands.find((b) => Math.abs(b.offset) > opts.offsetTolerance) ?? null;
  const heightDeltas = bands.filter((b) => b.heightDelta !== 0);

  const structural = onlyA.length > 0 || onlyB.length > 0 || Boolean(sizeMismatch);
  let verdict;
  if (structural || worstContent > opts.contentThreshold) verdict = "fail";
  else if (maxOffset > opts.offsetTolerance || heightDeltas.length > 0) verdict = "drift";
  else verdict = "pass";

  return {
    tool: { name: "parity-compare", version: VERSION },
    verdict,
    sizeMismatch,
    structure: {
      rnBands: rnBands.length,
      nativeBands: natBands.length,
      matched: pairs.length,
      missingInNative: onlyA.map((x) => x.band),
      extraInNative: onlyB.map((x) => x.band),
    },
    position: {
      maxOffset,
      offsetsByBand: offsets,
      firstOffsetAt: firstOffset ? { rnTop: firstOffset.rn.top, offset: firstOffset.offset } : null,
      heightDeltas: heightDeltas.map((b) => ({ rnTop: b.rn.top, delta: b.heightDelta })),
    },
    content: {
      worstBandRatio: worstContent,
      threshold: opts.contentThreshold,
      differingPixels: bands.reduce((s, b) => s + b.differingPixels, 0),
      comparedPixels: bands.reduce((s, b) => s + b.comparedPixels, 0),
    },
    raw: rawDifference(rnImage, natImage, opts),
    bands,
  };
}
