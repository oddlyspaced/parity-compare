// Content bands: the horizontal strips of a screen that actually carry something.
//
// A screenshot of a list is mostly background. What a reader compares is the strips that carry
// content, and where they sit. Finding those strips first is what lets a comparison say "the same
// things, two pixels lower" instead of "forty thousand pixels differ".

/** Rec. 709 luma. */
export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The background luma of a row, taken as the median of its outer margins.
 *
 * The margins rather than the whole row: a row whose content covers more than half its width makes
 * the median of the whole row the content's own colour, and every test of "does this differ from the
 * background" then inverts. A wide button or a full-width image is enough to do it. The outer eighth
 * on each side is page background in any screen this is meant for.
 *
 * It falls back to the whole row when the margins are masked away, and to white when everything is.
 */
export function rowBackground(image, y, x0, x1, step = 4, masked = null) {
  const width = x1 - x0;
  const margin = Math.max(1, Math.floor(width / 8));
  const sample = (from, to) => {
    const values = [];
    for (let x = from; x < to; x += step) {
      if (x < 0 || x >= image.width) continue;
      if (masked && masked(x, y)) continue;
      const i = image.index(x, y);
      values.push(luma(image.data[i], image.data[i + 1], image.data[i + 2]));
    }
    return values;
  };
  let values = [...sample(x0, x0 + margin), ...sample(x1 - margin, x1)];
  if (!values.length) values = sample(x0, x1);
  if (!values.length) return 255;
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

/** Number of sampled pixels in a row whose luma is further than `inkThreshold` from the background. */
export function rowInk(image, y, opts = {}) {
  const { x0 = 0, x1 = image.width, step = 2, inkThreshold = 24, masked = null } = opts;
  const bg = rowBackground(image, y, x0, x1, 4, masked);
  let ink = 0;
  for (let x = x0; x < x1; x += step) {
    // A masked region is one the comparison has been told not to look at. Letting it contribute ink
    // would let a clock or a relative time decide where a band begins, and those change every run.
    if (masked && masked(x, y)) continue;
    const i = image.index(x, y);
    if (Math.abs(luma(image.data[i], image.data[i + 1], image.data[i + 2]) - bg) > inkThreshold) ink++;
  }
  return ink;
}

/**
 * The content bands of an image, top to bottom.
 *
 * `minGap` is how many consecutive background rows end a band. Too small and one paragraph becomes
 * one band per line; too large and separate rows merge. `minHeight` drops single-pixel specks, which
 * are usually a hairline rule or compression noise rather than content.
 */
export function findBands(image, opts = {}) {
  const {
    y0 = 0,
    y1 = image.height,
    minGap = 4,
    minHeight = 3,
    /**
     * The share of a row's sampled width that must be ink for the row to belong to a band.
     *
     * Not one pixel. A scroll indicator is about 1% of the width and runs the whole height of a
     * list, so at one pixel it bridges every gap and the entire list collapses into a single band.
     * Measured on a 1280 px Android capture: the React Native scrollbar is 12 px of grey at the
     * right edge, present in every row, and it merged nine feed rows into one 1405 px band while
     * the native capture, which draws no scrollbar, reported them separately. A real row of
     * content is far wider than this.
     */
    minInkFraction = 0.02,
    ...rowOpts
  } = opts;
  const sampled = Math.max(1, Math.ceil(((rowOpts.x1 ?? image.width) - (rowOpts.x0 ?? 0)) / (rowOpts.step ?? 2)));
  const minInk = Math.max(1, Math.round(sampled * minInkFraction));
  const bands = [];
  let start = null;
  let lastInk = null;
  for (let y = y0; y < y1; y++) {
    const ink = rowInk(image, y, rowOpts);
    if (ink >= minInk) {
      if (start === null) start = y;
      lastInk = y;
    } else if (start !== null && y - lastInk >= minGap) {
      if (lastInk - start + 1 >= minHeight) bands.push({ top: start, bottom: lastInk });
      start = null;
    }
  }
  if (start !== null && lastInk - start + 1 >= minHeight) bands.push({ top: start, bottom: lastInk });
  return bands.map((b) => ({ ...b, height: b.bottom - b.top + 1 }));
}

/**
 * Pairs the bands of two images in order.
 *
 * A longest-common-subsequence alignment rather than a zip, so one extra or missing band reports as
 * exactly that instead of shifting every later band into a mismatch. Two bands are candidates when
 * their heights are within `heightTolerance`; this is deliberately loose, because the point of the
 * alignment is to find the correspondence, and the differences are measured afterwards.
 */
/**
 * Pairs the bands of two images by minimum total cost.
 *
 * A band that changed height is the same band, not one that vanished and another that appeared, so
 * matching on height alone reports a row that grew by eight pixels as a missing element plus an
 * extra one. The cost of pairing two bands is how far apart they sit plus how much their heights
 * differ; leaving one unpaired costs `gapPenalty`. The alignment that costs least wins, so a band
 * is only called missing when nothing on the other side is a cheaper explanation.
 *
 * Order is preserved, which is what makes this an alignment and not a nearest-neighbour search: a
 * list cannot match its own items out of sequence.
 */
export function alignBands(a, b, options = {}) {
  const { gapPenalty = 120, positionWeight = 1, heightWeight = 1 } = typeof options === "number"
    ? { gapPenalty: 120 }
    : options;
  const cost = (p, q) =>
    positionWeight * Math.abs(p.top - q.top) + heightWeight * Math.abs(p.height - q.height);

  const n = a.length;
  const m = b.length;
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = n - 1; i >= 0; i--) { best[i][m] = best[i + 1][m] + gapPenalty; move[i][m] = 1; }
  for (let j = m - 1; j >= 0; j--) { best[n][j] = best[n][j + 1] + gapPenalty; move[n][j] = 2; }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = best[i + 1][j + 1] + cost(a[i], b[j]);
      const skipA = best[i + 1][j] + gapPenalty;
      const skipB = best[i][j + 1] + gapPenalty;
      if (pair <= skipA && pair <= skipB) { best[i][j] = pair; move[i][j] = 0; }
      else if (skipA <= skipB) { best[i][j] = skipA; move[i][j] = 1; }
      else { best[i][j] = skipB; move[i][j] = 2; }
    }
  }
  const pairs = [];
  const onlyA = [];
  const onlyB = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const step = i < n && j < m ? move[i][j] : i < n ? 1 : 2;
    if (step === 0) { pairs.push({ a: a[i], b: b[j], aIndex: i, bIndex: j }); i++; j++; }
    else if (step === 1) { onlyA.push({ band: a[i], index: i }); i++; }
    else { onlyB.push({ band: b[j], index: j }); j++; }
  }
  return { pairs, onlyA, onlyB, cost: best[0][0] };
}
