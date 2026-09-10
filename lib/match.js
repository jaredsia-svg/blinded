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

  // Sizes the logo might appear at relative to the picked one.
  //
  // This started as 0.6 to 1.75 and that was the single biggest reason the
  // matcher "found nothing" on real documents: a logo at 0.45x or 2.2x was
  // never actually tried, so it could not be found at any threshold. A
  // letterhead repeated as a small footer mark, or blown up on a cover page,
  // is completely ordinary and both fall outside that range.
  //
  // The ladder is geometric because scale error is proportional: a fixed step
  // that is fine at 0.3x is far too coarse at 3x. Steps of about 1.25 leave at
  // most ~12% of size error before refinement, which correlation tolerates.
  const SCALES = (() => {
    const out = [];
    for (let s = 0.25; s <= 4.001; s *= 1.25) out.push(Math.round(s * 1000) / 1000);
    return out;
  })();

  // Working sizes for the two stages, as {target, minShort, maxLong}.
  //
  // `target` is the long side we would like. `minShort` is the one that
  // matters: sizing by the long side alone destroys wide marks. A 600x30
  // wordmark — the most ordinary logo there is — scaled so its long side is 14
  // becomes a template **one pixel tall**, which has no structure left to
  // match and correlates with any horizontal edge on the page. That is the
  // likeliest reason a real document came back with nothing found.
  //
  // `maxLong` then caps what an extreme aspect ratio can cost, since holding
  // the short side up on a 20:1 mark would otherwise grow the template area
  // by an order of magnitude. Between the two, an elongated mark ends up
  // wider and shorter than a square one but never degenerate.
  // `floorShort` is the last word: on a mark elongated enough that maxLong and
  // minShort cannot both be honoured, the length cap gives way rather than
  // letting the template degenerate to a line. A 900x20 rule would otherwise
  // still come out one pixel tall.
  // The coarse stage is cheap — a fraction of what refinement costs — so it is
  // worth making it discriminate properly rather than merely quickly. At
  // 14/60/3 a wide wordmark reduced to a 60x4 template, which has so little
  // vertical structure that dozens of unrelated horizontal edges outscored the
  // real thing and crowded it out of the candidate list. Every real match was
  // then never refined, despite scoring 0.83 to 0.95 when it finally was.
  const COARSE_SIZE = { target: 20, minShort: 7, maxLong: 96, floorShort: 4 };
  const FINE_SIZE = { target: 40, minShort: 10, maxLong: 160, floorShort: 6 };

  // Works out the resampling factor for a template of this shape at this
  // working size. Exported so the sizing can be tested directly rather than
  // only through its effects.
  function workingScale(width, height, size) {
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    if (long <= 0 || short <= 0) return 0;

    let base = size.target / long;
    if (short * base < size.minShort) base = size.minShort / short;
    if (long * base > size.maxLong) base = size.maxLong / long;
    if (size.floorShort && short * base < size.floorShort) base = size.floorShort / short;
    // Never upsample: inventing pixels adds no structure, only cost.
    return Math.min(1, base);
  }

  // The coarse pass must not reject anything the fine pass might have
  // rescued, so it keeps far more than it should and lets refinement decide.
  const COARSE_THRESHOLD = 0.4;

  // How many coarse candidates per page survive to refinement. Refinement is
  // cheap per candidate, so this is generous.
  // Deep enough that every scale contributes several ranks, not just its
  // best. Interleaving means this is spent as breadth across scales rather
  // than depth in whichever scale happened to score highest.
  const MAX_CANDIDATES = 110;

  // Scale nudges tried around each candidate's coarse scale, to recover the
  // size error the geometric ladder leaves behind.
  // Five nudges either side of the candidate's rung. Cutting this to three
  // was tried and reverted: it saves 40% of refinement, but the probes are
  // then ~9% apart and the true scale falls between them, so scores sagged
  // across the board — a logo correlated against itself dropped from 0.96 to
  // 0.82. Refinement's whole job is to produce a score worth trusting, and a
  // cheaper refinement that scores a certain match at 0.82 has stopped doing
  // that job.
  const REFINE_STEPS = [0.88, 0.94, 1, 1.06, 1.12];

  // Correlation below this is not reported at all. Refinement re-scores every
  // candidate against the full-resolution page, so scores are higher and more
  // trustworthy than they were when this was judged off a heavily downsampled
  // page; 0.75 admits genuinely rescaled and re-encoded copies without opening
  // the door to unrelated page furniture.
  const THRESHOLD = 0.75;

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

  // ---------- trimming a hand-drawn pick ----------

  // Shrinks a picked region to the ink inside it.
  //
  // Nobody drags a tight box. A pick carries a margin of page background on
  // every side, and that margin is pure noise in the correlation: it dilutes
  // the logo's contribution to the score, and — worse — it makes the
  // template's size a property of how the reviewer happened to drag rather
  // than of the logo, so every scale in the sweep is measured against the
  // wrong reference. Trimming to the ink makes a sloppy pick behave like a
  // careful one.
  //
  // Background is taken from the border pixels rather than assumed white,
  // since a logo may sit in a coloured or dark banner.
  function trimToContent(gray, width, height, tolerance) {
    const slack = tolerance === undefined ? 18 : tolerance;
    if (width < 3 || height < 3) return { x: 0, y: 0, w: width, h: height };

    // Median of the border, which is robust to a stray dark pixel at an edge.
    const border = [];
    for (let x = 0; x < width; x++) {
      border.push(gray[x], gray[(height - 1) * width + x]);
    }
    for (let y = 0; y < height; y++) {
      border.push(gray[y * width], gray[y * width + width - 1]);
    }
    border.sort((a, b) => a - b);
    const background = border[border.length >> 1];

    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.abs(gray[y * width + x] - background) > slack) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // Nothing stood out from the background — leave the pick alone and let
    // prepareTemplate decide whether it has any structure at all.
    if (maxX < minX || maxY < minY) return { x: 0, y: 0, w: width, h: height };

    // One pixel of margin keeps the outermost stroke off the very edge, where
    // resampling would half-swallow it.
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(width - 1, maxX + 1);
    maxY = Math.min(height - 1, maxY + 1);
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function crop(gray, width, height, box) {
    const out = new Float32Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) {
      const from = (box.y + y) * width + box.x;
      out.set(gray.subarray(from, from + box.w), y * box.w);
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

    // An optional window confines the search to part of the image. Refinement
    // uses it to re-score one candidate without paying for the whole page.
    const win = opts.window;
    const fromX = win ? Math.max(0, Math.floor(win.x)) : 0;
    const fromY = win ? Math.max(0, Math.floor(win.y)) : 0;
    const toX = win ? Math.min(width - tw, Math.ceil(win.x + win.w)) : width - tw;
    const toY = win ? Math.min(height - th, Math.ceil(win.y + win.h)) : height - th;

    // Testing every position is only worth it when the score is the answer.
    // During the nominating sweep it is not — a candidate one pixel off is
    // re-localised by refinement anyway — and stepping by two costs a quarter
    // as much in each dimension. Defaults to 1 so scoring stays exact.
    const step = Math.max(1, Math.floor(opts.stride || 1));

    const table = integrals(gray, width, height);
    const n = tw * th;
    const found = [];

    for (let y = fromY; y <= toY; y += step) {
      for (let x = fromX; x <= toX; x += step) {
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
    trimToContent, crop, workingScale,
    WORK_SIZE, SCALES, THRESHOLD, OVERLAP,
    COARSE_SIZE, FINE_SIZE, COARSE_THRESHOLD, MAX_CANDIDATES, REFINE_STEPS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
