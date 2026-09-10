// Finds every place a picked logo appears again.
//
// The reviewer draws a box around a logo, a signature, a stamp or a face, and
// this looks for it everywhere else in the document. That is template matching,
// and the method is normalised cross-correlation on greyscale: for each
// candidate position, correlate the template against the patch beneath it after
// removing the mean from both and dividing by their standard deviations.
//
// Subtracting the mean and dividing by the deviation is what makes this usable
// on real documents rather than only on synthetic ones. A logo photocopied on
// to a darker page, printed lighter, or scanned at a different exposure has
// completely different absolute pixel values and nearly identical *structure*.
// Correlating raw brightness would miss all of those; correlating the
// normalised signal scores them near 1.0.
//
// Three things this deliberately does not do:
//
//   - It does not rotate. A logo turned 30 degrees will not be found, and the
//     README says so rather than the reviewer discovering it on a document
//     that mattered.
//   - It does not claim a match is correct. Everything found is proposed to
//     the reviewer exactly like a detected phone number, and can be clicked
//     off. A visual matcher run at a threshold loose enough to catch every
//     real repeat will also catch things that merely rhyme with one.
//   - It does not look at colour. Two logos identical in shape but different
//     in hue score as the same thing. For redaction that errs the safe way:
//     the cost is covering one logo too many, not missing one.
//
// Everything here is plain arrays and numbers so it can be tested in node.
// lib/imagesearch.js is the part that knows about canvases.
(function (root) {
  'use strict';

  // The template is resampled so its longer side is this many pixels before
  // any searching happens. Cost is linear in template area and in page area,
  // so this single number governs how long a search takes; 24 keeps a full
  // page under a few hundred milliseconds while still carrying enough
  // structure to tell two logos apart.
  const WORK_SIZE = 24;

  // Sizes the logo might appear at relative to the picked one. A letterhead
  // repeated at half size in a footer is the case this exists for.
  const SCALES = [0.6, 0.75, 0.9, 1, 1.15, 1.4, 1.75];

  // Correlation below this is not reported at all. Chosen to sit under a
  // re-encoded or rescaled copy of the same mark (which lands well above 0.9)
  // and above most unrelated page furniture.
  const THRESHOLD = 0.82;

  // Two proposals overlapping by more than this are the same find, and only
  // the better-scoring one is kept.
  const OVERLAP = 0.3;

  // ---------- pixels ----------

  // Rec. 601 luma. The exact weights matter less than using the same ones on
  // both sides of the correlation.
  function toGray(rgba, width, height) {
    const out = new Float32Array(width * height);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
      out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
    return out;
  }

  // Bilinear resample. Nearest-neighbour would alias the thin strokes that
  // carry a logo's identity, which costs matches on exactly the marks — small
  // type, fine rules — where the reviewer most needs them found.
  function resize(src, sw, sh, dw, dh) {
    const out = new Float32Array(dw * dh);
    if (dw <= 0 || dh <= 0) return out;
    const xRatio = sw / dw;
    const yRatio = sh / dh;

    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
      const y0 = Math.floor(sy);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fy = sy - y0;
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
        const x0 = Math.floor(sx);
        const x1 = Math.min(sw - 1, x0 + 1);
        const fx = sx - x0;
        const a = src[y0 * sw + x0], b = src[y0 * sw + x1];
        const c = src[y1 * sw + x0], d = src[y1 * sw + x1];
        out[y * dw + x] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy)
          + c * (1 - fx) * fy + d * fx * fy;
      }
    }
    return out;
  }

  // ---------- the template ----------

  // Mean removed once, up front, so the correlation loop does not repeat it
  // per position. Returns null for a featureless pick — a blank patch has no
  // structure to match, correlates with every other blank patch on the page,
  // and would bury the reviewer in proposals.
  function prepareTemplate(gray, width, height) {
    const n = width * height;
    if (n === 0) return null;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += gray[i];
    const mean = sum / n;

    const zero = new Float32Array(n);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = gray[i] - mean;
      zero[i] = v;
      energy += v * v;
    }
    if (energy < 1e-6) return null;

    return { zero, width, height, norm: Math.sqrt(energy) };
  }

  // ---------- integral images ----------
  //
  // The correlation denominator needs the mean and variance of every candidate
  // patch. Computed directly that is another pass over the template area per
  // position; from a summed-area table it is four lookups, independent of
  // patch size.

  function integrals(gray, width, height) {
    const w1 = width + 1;
    const sum = new Float64Array(w1 * (height + 1));
    const sumSq = new Float64Array(w1 * (height + 1));

    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      let rowSumSq = 0;
      for (let x = 0; x < width; x++) {
        const v = gray[y * width + x];
        rowSum += v;
        rowSumSq += v * v;
        sum[(y + 1) * w1 + x + 1] = sum[y * w1 + x + 1] + rowSum;
        sumSq[(y + 1) * w1 + x + 1] = sumSq[y * w1 + x + 1] + rowSumSq;
      }
    }
    return { sum, sumSq, w1 };
  }

  function boxSum(table, field, x, y, w, h) {
    const t = table[field];
    const s = table.w1;
    return t[(y + h) * s + x + w] - t[y * s + x + w] - t[(y + h) * s + x] + t[y * s + x];
  }

  // ---------- the search ----------

  // Correlates `template` against every position in one greyscale image.
  //
  // Because the template has already had its mean removed, its values sum to
  // zero, and so the mean of the patch contributes nothing to the dot product.
  // That is what lets the numerator be a plain dot product while the result is
  // still a properly normalised correlation.
  function correlate(gray, width, height, template, options) {
    const opts = options || {};
    const threshold = opts.threshold === undefined ? THRESHOLD : opts.threshold;
    const tw = template.width;
    const th = template.height;
    if (tw > width || th > height) return [];

    const table = integrals(gray, width, height);
    const n = tw * th;
    const found = [];

    for (let y = 0; y + th <= height; y++) {
      for (let x = 0; x + tw <= width; x++) {
        const sum = boxSum(table, 'sum', x, y, tw, th);
        const sumSq = boxSum(table, 'sumSq', x, y, tw, th);
        // Σ(P - meanP)², rearranged so it comes from the two tables.
        const variance = sumSq - (sum * sum) / n;
        // A patch with no contrast has no structure to match; it also makes
        // the denominator vanish.
        if (variance < 1e-6) continue;

        let dot = 0;
        for (let j = 0; j < th; j++) {
          let gi = (y + j) * width + x;
          let ti = j * tw;
          for (let i = 0; i < tw; i++) dot += gray[gi + i] * template.zero[ti + i];
        }

        const score = dot / (Math.sqrt(variance) * template.norm);
        if (score >= threshold) found.push({ x, y, w: tw, h: th, score });
      }
    }
    return found;
  }

  // ---------- overlap ----------

  function iou(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    if (right <= x || bottom <= y) return 0;
    const overlap = (right - x) * (bottom - y);
    return overlap / (a.w * a.h + b.w * b.h - overlap);
  }

  // Keeps the best-scoring proposal from each cluster of overlapping ones.
  // Without this a single logo comes back as a few hundred near-identical
  // boxes, one per position the correlation stayed above threshold.
  function suppress(boxes, limit) {
    const cutoff = limit === undefined ? OVERLAP : limit;
    const sorted = boxes.slice().sort((a, b) => b.score - a.score);
    const kept = [];
    for (const box of sorted) {
      if (!kept.some(other => iou(box, other) > cutoff)) kept.push(box);
    }
    return kept;
  }

  root.BlackbarMatch = {
    toGray, resize, prepareTemplate, integrals, boxSum, correlate, suppress, iou,
    WORK_SIZE, SCALES, THRESHOLD, OVERLAP,
  };
})(typeof window !== 'undefined' ? window : globalThis);
