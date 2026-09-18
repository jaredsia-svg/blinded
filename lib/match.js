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
  // The ladder is built outwards from exactly 1.0, which is not a detail.
  //
  // It used to start at 0.25 and multiply up, and 1.0 is not a power of 1.25
  // times 0.25 — so the rungs straddled it at 0.954 and 1.192 and the one
  // scale guaranteed to matter was never tested. A picked logo sits at scale
  // 1.0 by definition, and so does every copy of it printed at the same size,
  // which on a letterhead is most of them. Refinement could sometimes recover
  // the 4.6% error and sometimes could not: refining the source position at
  // scale 1 scored 0.977 while the whole search topped out at 0.805 and
  // reported nothing found.
  //
  // And the rungs are close together near 1.0, which is where the copies are.
  //
  // A step of 1.25 everywhere was too coarse to find an ordinary thing:
  // measured on a real deck, the same ByteDance lockup appeared on two pages
  // at 142x24 and at 163x27 — a scale of about 1.12, which falls squarely
  // between the rungs at 1.0 and 1.25. It was not that the match scored
  // badly; it was never proposed. At those two rungs the nominating pass
  // scored the true position 0.29 and 0.35, under the 0.4 it takes to be
  // nominated at all, so refinement was never given the chance to correct the
  // size. Rebuilt with rungs 8% apart between 0.7 and 1.6, the same search
  // verifies that copy at 0.91, with the best thing that is not the logo at
  // 0.50 — a gap nothing has to be tuned to land in.
  //
  // Why 8% and not 12%: at 1.12 steps the same copy came back at 0.765, which
  // clears the 0.75 bar by a hundredth and would be lost to any document
  // slightly worse than this one. The tolerance is not a fixed percentage —
  // scale error displaces the far end of a template by that percentage of its
  // width, so a 142-pixel wordmark is punished six times harder than a
  // 24-pixel monogram for the same error.
  //
  // The cost is the rungs: 13 to 20 on the shipped range, about a quarter
  // more nominating work. Outside 0.7 to 1.6 the old step stands, because a
  // logo at a fifth or triple its picked size is rare enough that finding it
  // at all matters more than scoring it precisely.
  function ladder(low, high) {
    const near = 1.08;        // between NEAR_LOW and NEAR_HIGH
    const far = 1.25;         // out on the tails
    const NEAR_LOW = 0.7;
    const NEAR_HIGH = 1.6;
    const out = [1];
    for (let s = 1 / near; s >= NEAR_LOW; s /= near) out.unshift(Math.round(s * 1000) / 1000);
    for (let s = out[0] / far; s >= low; s /= far) out.unshift(Math.round(s * 1000) / 1000);
    for (let s = near; s <= NEAR_HIGH; s *= near) out.push(Math.round(s * 1000) / 1000);
    for (let s = out[out.length - 1] * far; s <= high + 0.001; s *= far) {
      out.push(Math.round(s * 1000) / 1000);
    }
    return out.filter(s => s >= low * 0.999 && s <= high * 1.001);
  }

  const SCALES = ladder(0.24, 4);

  // The smallest copy worth looking for, in pixels of the page being searched.
  //
  // Measured, on a real deck. The ladder used to run from 0.24 to 4 times the
  // picked size whatever that size was, and a ratio is the wrong thing to
  // bound it by, because what decides whether a copy can be recognised is how
  // many pixels it has — not how it compares with the pick.
  //
  // Both failures in one document. A 46x46 roundel searched down to 0.24
  // proposed copies 11 to 14 pixels across, and at that size a round mark
  // correlates with every bullet, full stop and small circular icon on the
  // page: 93 matches at the 0.75 bar, of which two were the logo. The same
  // deck's 231x195 asterisk appears twice more at about 30 pixels, a ratio of
  // 0.13 — below the ladder's floor, so those two were never looked for at
  // any bar.
  //
  // Bounding the ladder in page pixels answers both: the roundel stops being
  // searched below 0.43, where the junk was, and the asterisk carries on down
  // to 0.09, where its real copies are.
  //
  // Bounded by area rather than by the short side, which was the first attempt
  // and cost a real match. A wordmark's short side is its x-height: a 113x25
  // lockup at half size is 12 pixels tall and 56 wide, and those 672 pixels
  // carry its shape perfectly well. Held to a 20-pixel short side it would not
  // have been looked for below 0.8, and the footer copy of it in the same deck
  // disappeared. Area asks the question that matters — how much of the mark is
  // left — and a floor on the short side only stops the ladder degenerating
  // into slivers.
  const MIN_COPY_AREA = 400;   // 20x20, however the mark is shaped
  const MIN_COPY_SHORT = 6;

  // And the same at the top, so an enormous blow-up of a small mark is still
  // tried without the ladder running off into sizes no page can hold.
  const MAX_COPY_OF = 4;

  // The rungs worth trying for a template of this size.
  function scalesFor(width, height, options) {
    const opts = options || {};
    const short = Math.min(width, height);
    if (!(short > 0)) return SCALES;
    const area = Math.max(1, width * height);
    const minArea = opts.minArea === undefined ? MIN_COPY_AREA : opts.minArea;
    const low = Math.min(1, Math.max(Math.sqrt(minArea / area), MIN_COPY_SHORT / short));
    const high = opts.maxScale === undefined ? MAX_COPY_OF : opts.maxScale;
    return ladder(Math.min(low, 1), Math.max(high, 1));
  }

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

  // The same pass for a mark that is much wider than it is tall.
  //
  // Nomination works on a shrunken copy, and how far it can be shrunk depends
  // on where the mark keeps its identity. A roundel or a monogram is a shape:
  // at 19x20 it is still recognisably itself. A wordmark is letters, and the
  // letters live in its height — squash "Tokenomics Digital Tech Co." from
  // 451x44 down to 72x7 and every letter becomes the same grey smear.
  //
  // This is not a hypothetical. A logo cropped out of a real deck was not
  // found at the very pixels it had been cut from: nomination proposed its
  // true position with an overlap of zero, so it was never offered for
  // verification at all. Forced to score that position by hand, the same
  // template refined to 0.90 and verified to 0.78 — the match was always
  // there, and the coarse pass simply could not see where to look. Four
  // reasonable hand-drawn crops of one logo scored 0.38, 0.45, 0.50 and 0.51.
  //
  // Keeping more of the short side costs about three times the nominating
  // work, which is why it is spent only on the shape that needs it. A
  // template of ordinary proportions is unaffected, and paying it here buys
  // back matches that were otherwise silently lost.
  const COARSE_SIZE_WIDE = { target: 20, minShort: 12, maxLong: 160, floorShort: 6 };

  // Where "wide" starts. Every crop that failed was at 3.8 or above.
  const WIDE_ASPECT = 3;

  function coarseSizeFor(width, height) {
    const short = Math.min(width, height);
    if (short <= 0) return COARSE_SIZE;
    return Math.max(width, height) / short >= WIDE_ASPECT ? COARSE_SIZE_WIDE : COARSE_SIZE;
  }
  const FINE_SIZE = { target: 40, minShort: 10, maxLong: 160, floorShort: 6 };

  // The size the final score is taken at: the template's own resolution,
  // capped so an enormous pick cannot make verification crawl.
  //
  // This exists because scoring on a shrunken copy is not just less precise,
  // it is unstable. Three identical logos on one page scored 0.977, 0.845 and
  // 0.738 through the fine stage, which resamples a 112x64 mark down to 40x23:
  // what differed between them was not their content but where the downsample
  // happened to land relative to their strokes. At native resolution and the
  // same scale, an identical copy correlates against itself exactly, so the
  // score measures similarity rather than sampling luck.
  //
  // It is affordable because verification only ever looks a few pixels either
  // side of a position refinement has already found.
  const NATIVE_SIZE = { target: 160, minShort: 12, maxLong: 160, floorShort: 6 };

  // Verification is the expensive stage — a full-resolution template over a
  // few hundred positions — so it is spent only where it can change the
  // answer. Refinement's score is too unstable to accept as final but is quite
  // good enough to rule out obvious rubbish: real matches came back from it at
  // 0.62 to 0.98, so a gate well below that loses nothing while discarding
  // most of the candidate list.
  const VERIFY_GATE = 0.45;

  // And a hard ceiling, so a page of near-misses cannot make a search crawl.
  const VERIFY_LIMIT = 16;

  // How far around a refined position the native check looks.
  //
  // Wide enough to correct refinement, not just to re-score it. Refinement
  // localises on a shrunken copy where identical content scores anywhere from
  // 0.74 to 0.98, so its idea of the exact position drifts a few pixels; at a
  // radius of 4 the true peak sat on the very edge of the window and a real
  // match verified at 0.58. Verification is a few hundred positions on a small
  // crop, so the extra reach costs almost nothing.
  const VERIFY_RADIUS = 12;

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

  // ---------- the numerator, all at once ----------
  //
  // Correlating a template against a page is one operation repeated: at every
  // position, multiply the two together pixel by pixel and add up the result.
  // The mean and the variance of the patch under the template already come
  // from integral images in constant time; that sum of products does not, and
  // it is essentially the whole cost of the search. Measured on a five-page
  // deck looking for one word: ninety-four percent of the comprehensive check
  // is inside `correlate`, and seventy-two billion multiply-adds. Only two
  // percent of positions are cheap enough to skip on their variance, so there
  // is no large saving hiding in the ones that are.
  //
  // The sum of products over every position is a cross-correlation, and a
  // cross-correlation is a convolution with the template turned round, and a
  // convolution is a pointwise product of two Fourier transforms. So every
  // position can be had in one go, in time that grows with the page and barely
  // at all with the template.
  //
  // It computes the same numbers, not an approximation of them: measured
  // against the loop it replaces, the two agree to three parts in ten million
  // in single precision, where a score is compared against a threshold quoted
  // to three decimals.
  //
  // Measured, the loop against this, at the sizes the tool actually uses:
  //
  //   page        template   positions   loop      transform   faster by
  //   600x470     41x12        257,040    234ms     93ms         2.5x
  //   900x700     41x12        592,540    606ms    192ms         3.2x
  //   1800x1012   41x12      1,761,760   1766ms    387ms         4.6x
  //   600x470     96x28        223,715   1206ms     79ms          15x
  //   600x470     160x46       187,425   2901ms     86ms          34x
  //
  // The gain grows with the template, because the loop pays for every one of
  // its pixels and this does not -- which is exactly where the old cost fell
  // hardest.
  //
  // Single precision, not double: it halves the memory, and four workers each
  // holding the transform of a two-megapixel page is the one place this could
  // hurt a small machine.

  // Under this many positions the transform's own setup costs more than the
  // loop it saves. Measured: a wash at 580 positions, three and a half times
  // faster by 3,920. Refinement re-scores one candidate in a small window and
  // stays on the loop.
  const FFT_MIN_POSITIONS = 4096;

  function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  // Twiddles per length, shared by every transform of that length.
  const twiddles = new Map();
  function twiddlesFor(n) {
    let at = twiddles.get(n);
    if (at) return at;
    const cos = new Float32Array(n / 2);
    const sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(-2 * Math.PI * i / n);
      sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    at = { cos, sin };
    twiddles.set(n, at);
    return at;
  }

  // One in-place radix-2 transform over a strided run, so the same code does
  // the rows and then the columns without copying either out.
  function fftRun(re, im, off, stride, n, inverse) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const a = off + i * stride;
        const b = off + j * stride;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    const turn = twiddlesFor(n);
    const cos = turn.cos;
    const sin = turn.sin;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = inverse ? -sin[k * step] : sin[k * step];
          const a = off + (i + k) * stride;
          const b = off + (i + k + half) * stride;
          const br = re[b], bi = im[b];
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  function fft2(re, im, w, h, inverse) {
    for (let y = 0; y < h; y++) fftRun(re, im, y * w, 1, w, inverse);
    for (let x = 0; x < w; x++) fftRun(re, im, x, w, h, inverse);
    if (inverse) {
      const n = w * h;
      const by = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= by; im[i] *= by; }
    }
  }

  // The template's transform, the same for every page of a given padded size
  // and worked out once. Held against the template itself, so it goes when the
  // template does.
  const templateSpectra = new WeakMap();
  function spectrumOf(template, pw, ph) {
    let bySize = templateSpectra.get(template);
    if (!bySize) { bySize = new Map(); templateSpectra.set(template, bySize); }
    const key = pw + 'x' + ph;
    const at = bySize.get(key);
    if (at) return at;
    const n = pw * ph;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const tw = template.width;
    const th = template.height;
    // Turned round and wrapped to the origin: convolution with a reversed
    // template is correlation, and putting it here means position (0,0) of the
    // answer lands at (0,0) rather than at the template's own corner.
    for (let j = 0; j < th; j++) {
      const row = ((ph - j) % ph) * pw;
      for (let i = 0; i < tw; i++) {
        re[row + ((pw - i) % pw)] = template.zero[j * tw + i];
      }
    }
    fft2(re, im, pw, ph, false);
    // Every tile is the same size, so in practice this holds one entry for
    // the life of the template. The cap is there for the page that is smaller
    // than a tile and gets its own.
    if (bySize.size >= 4) bySize.clear();
    const made = { re, im };
    bySize.set(key, made);
    return made;
  }

  // Every position's sum of products, as one plane of (width-tw+1) by
  // (height-th+1).
  //
  // Done in tiles, not in one go. A transform wants a power of two, and a page
  // is not one: measured on a real run, a working page of 1025 by 577 padded
  // to 2048 by 1024 and did three and a half times the arithmetic it needed,
  // and a 2004 by 1128 page padded to 2048 square and allocated thirty-three
  // megabytes a call in each of four workers. Whole-page padding turned a
  // transform that is two and a half times faster in the small into one that
  // was half the speed in the large.
  //
  // Overlapping tiles fix all three at once. Every tile is the same size, so
  // the template's transform is worked out once and then reused for the whole
  // document; the waste is the overlap rather than the gap to the next power
  // of two, which for a word-sized template is about a tenth; and the memory
  // is one tile, not one page.
  //
  // The overlap is what a circular convolution spoils: the first tw-1 columns
  // and th-1 rows of each tile's answer are wrapped nonsense, so tiles step by
  // the part that is sound and the rest is thrown away. This is the standard
  // overlap-save arrangement.
  // Measured on a five-page deck, the whole check: 512 gave 36.7s, 256 gave
  // 25.7s, 128 gave 24.9s against 46.6s before any of this. Smaller tiles
  // waste less on the overlap and sit better in cache; below 256 that stops
  // paying, and a tile that small has to be widened for a long word anyway.
  const TILE = 256;

  function numeratorPlane(gray, width, height, template) {
    const tw = template.width;
    const th = template.height;
    const outW = width - tw + 1;
    const outH = height - th + 1;
    const out = new Float32Array(outW * outH);

    // A tile no bigger than the page, and no smaller than the template can
    // work in.
    // Never smaller than the template can work in: a tile that cannot hold
    // the template and a step as well has nothing sound in it.
    const tileW = Math.max(pow2(tw * 2), Math.min(TILE, pow2(width)));
    const tileH = Math.max(pow2(th * 2), Math.min(TILE, pow2(height)));
    const stepX = tileW - tw + 1;
    const stepY = tileH - th + 1;
    if (stepX <= 0 || stepY <= 0) return null;

    const n = tileW * tileH;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const spectrum = spectrumOf(template, tileW, tileH);
    const sr = spectrum.re;
    const si = spectrum.im;

    // Two tiles per transform.
    //
    // The transform is complex and the page is not: half of every one of these
    // was carrying zeroes through the arithmetic. Two real tiles can ride in
    // one complex transform, one in the real part and one in the imaginary,
    // and come out separated at the other end -- because all of this is
    // linear, and because the answer for a real tile against a real template
    // is itself real. F(A + iB) = F(A) + iF(B); multiplying by the template's
    // spectrum keeps that apart; and the inverse gives A's answer in the real
    // part and B's in the imaginary, with nothing mixed between them.
    //
    // It is an identity, not an approximation, and it halves the forward
    // transform, the inverse, and the multiply between them. The last tile of
    // an odd number rides alone, with zeroes for company.
    const tiles = [];
    for (let oy = 0; oy < outH; oy += stepY) {
      for (let ox = 0; ox < outW; ox += stepX) tiles.push(oy * outW + ox, ox, oy);
    }

    const readInto = (into, ox, oy) => {
      const rows = Math.min(tileH, height - oy);
      const cols = Math.min(tileW, width - ox);
      for (let y = 0; y < rows; y++) {
        const from = (oy + y) * width + ox;
        const to = y * tileW;
        for (let x = 0; x < cols; x++) into[to + x] = gray[from + x];
      }
    };
    const writeFrom = (from, ox, oy) => {
      const takeY = Math.min(stepY, outH - oy);
      const takeX = Math.min(stepX, outW - ox);
      for (let y = 0; y < takeY; y++) {
        const at = y * tileW;
        const to = (oy + y) * outW + ox;
        for (let x = 0; x < takeX; x++) out[to + x] = from[at + x];
      }
    };

    for (let t = 0; t < tiles.length; t += 6) {
      re.fill(0);
      im.fill(0);
      readInto(re, tiles[t + 1], tiles[t + 2]);
      const paired = t + 3 < tiles.length;
      if (paired) readInto(im, tiles[t + 4], tiles[t + 5]);

      fft2(re, im, tileW, tileH, false);
      for (let i = 0; i < n; i++) {
        const ar = re[i], ai = im[i];
        re[i] = ar * sr[i] - ai * si[i];
        im[i] = ar * si[i] + ai * sr[i];
      }
      fft2(re, im, tileW, tileH, true);

      writeFrom(re, tiles[t + 1], tiles[t + 2]);
      if (paired) writeFrom(im, tiles[t + 4], tiles[t + 5]);
    }
    return out;
  }

  // One position's sum of products, for the windows too small to transform.
  function dotAt(gray, width, template, x, y) {
    const tw = template.width;
    const th = template.height;
    const zero = template.zero;
    let dot = 0;
    for (let j = 0; j < th; j++) {
      let gi = (y + j) * width + x;
      let ti = j * tw;
      for (let i = 0; i < tw; i++) dot += gray[gi + i] * zero[ti + i];
    }
    return dot;
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
    // Every position is tested. There was a `stride` option here, on the
    // reasoning that the nominating sweep only needs to get close and
    // refinement re-localises anyway. It was measured for speed and bought
    // none — and it was never measured for accuracy, which is where it did
    // real damage: on a small logo the coarse template is around 20x11, so a
    // stride of two steps over a tenth of it and walks straight past the
    // correlation peak. The best score at the true position fell from 0.765 to
    // 0.374, under the nomination threshold, and the whole document came back
    // "0 found". Sampling an image at a coarser interval than the feature you
    // are looking for does not approximate the answer; it misses it.
    const fromX = 0;
    const fromY = 0;
    const toX = width - tw;
    const toY = height - th;
    const anyPolarity = Boolean(opts.anyPolarity);

    const table = integrals(gray, width, height);
    const n = tw * th;
    const found = [];

    // Every position's sum of products in one transform, when there are enough
    // positions to be worth it; otherwise the loop, which is cheaper on the
    // small windows refinement uses. Either way, the same number.
    const planeW = toX + 1;
    const plane = (planeW * (toY + 1)) >= FFT_MIN_POSITIONS
      ? numeratorPlane(gray, width, height, template) : null;


    for (let y = fromY; y <= toY; y++) {
      for (let x = fromX; x <= toX; x++) {
        const sum = boxSum(table, 'sum', x, y, tw, th);
        const sumSq = boxSum(table, 'sumSq', x, y, tw, th);
        // Σ(P - meanP)², rearranged so it comes from the two tables.
        const variance = sumSq - (sum * sum) / n;
        // A patch with no contrast has no structure to match; it also makes
        // the denominator vanish.
        if (variance < 1e-6) continue;

        const dot = plane ? plane[y * planeW + x] : dotAt(gray, width, template, x, y);

        const signed = dot / (Math.sqrt(variance) * template.norm);
        // A correlation of -1 is the same shape with light and dark swapped:
        // white lettering on a dark banner against a template cut from black
        // lettering on white. Ignoring the sign asks "is this the same shape?"
        // rather than "is this the same shape in the same colours?", which is
        // the question a redaction tool wants answered — a word is no less
        // exposed for being knocked out of a coloured box.
        //
        // Signed by default, because the sign is real information and the
        // primitive should not throw it away; the search pipeline opts in.
        const score = anyPolarity ? Math.abs(signed) : signed;
        if (score >= threshold) {
          found.push({ x, y, w: tw, h: th, score, inverted: signed < 0 });
        }
      }
    }
    return found;
  }

  // ---------- overlap ----------

  // How much of the smaller box lies inside the larger one.
  //
  // Not IoU, which is the wrong tool for asking "are these two marks the same
  // thing?". The same word found twice by different means — once from the text
  // layer, once by recognising its shape — produces boxes of noticeably
  // different sizes, and IoU reads that as a poor overlap even when one box
  // sits entirely within the other. Measuring against the smaller area says
  // what actually matters: one of these covers the other.
  function overlapFraction(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    if (right <= x || bottom <= y) return 0;
    const overlap = (right - x) * (bottom - y);
    const smaller = Math.min(a.w * a.h, b.w * b.h);
    return smaller > 0 ? overlap / smaller : 0;
  }

  // How much of `inner` lies inside `outer`, as a fraction of inner's own area.
  //
  // Deliberately not overlapFraction, which divides by whichever box is
  // smaller and so answers 1.0 both when a small box sits inside a big one and
  // when a big box swallows a small one. Those are opposite facts, and code
  // deciding whether one mark makes another redundant needs to tell them
  // apart: a mark that sticks out beyond the thing already covering it is not
  // a duplicate, it is more coverage.
  function coveredFraction(inner, outer) {
    const x = Math.max(inner.x, outer.x);
    const y = Math.max(inner.y, outer.y);
    const right = Math.min(inner.x + inner.w, outer.x + outer.w);
    const bottom = Math.min(inner.y + inner.h, outer.y + outer.h);
    if (right <= x || bottom <= y) return 0;
    const area = inner.w * inner.h;
    return area > 0 ? ((right - x) * (bottom - y)) / area : 0;
  }

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


  // The same pair, one above the other.
  //
  // A name set over two lines is ordinary — on a slide, in a signature block,
  // under a photograph — and a phrase searched only along the line can never
  // find one. Measured: "Inderpreet Wadhwa" appears twice on a deck, stacked
  // both times, and the check found neither while finding each word on its own
  // perfectly well.
  //
  // Stricter than the inline rule about sideways drift, because two words on
  // consecutive lines of a paragraph are not a phrase: they have to line up,
  // which is what a two-line name in a heading or a caption does and what an
  // accident of wrapping does not.
  function phraseHitsStacked(above, below) {
    const maxH = Math.max(above.h, below.h);
    const maxW = Math.max(above.w, below.w);
    const gap = below.y - (above.y + above.h);
    // Touching, or within a line of space. Negative a little, because the
    // boxes are drawn round ink and a descender can reach into the line below.
    if (gap < -0.35 * maxH) return false;
    if (gap > maxH * 1.2) return false;
    // Lined up: left edges together, or centres together. One or the other,
    // since a caption may be left-aligned and a heading centred.
    const lefts = Math.abs(below.x - above.x);
    const centres = Math.abs((below.x + below.w / 2) - (above.x + above.w / 2));
    return Math.min(lefts, centres) <= maxW * 0.45;
  }

  function phraseHitsAdjacent(left, right, skippedBetween) {
    const maxH = Math.max(left.h, right.h);
    const maxW = Math.max(left.w, right.w);
    const gap = right.x - (left.x + left.w);
    const maxGap = maxW * (2.2 + 1.8 * (skippedBetween || 0));
    if (gap < -0.25 * maxW) return false;
    if (gap > maxGap) return false;
    const cyL = left.y + left.h / 2;
    const cyR = right.y + right.h / 2;
    if (Math.abs(cyL - cyR) > maxH * 0.8) return false;
    return true;
  }

  function unionHitRect(hits) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    let score = 1;
    for (const hit of hits) {
      if (hit.x < minX) minX = hit.x;
      if (hit.y < minY) minY = hit.y;
      if (hit.x + hit.w > maxX) maxX = hit.x + hit.w;
      if (hit.y + hit.h > maxY) maxY = hit.y + hit.h;
      if (hit.score < score) score = hit.score;
    }
    return {
      x: minX, y: minY, w: maxX - minX, h: maxY - minY,
      score: score,
      inverted: hits.some(h => h.inverted),
    };
  }

  function pairPhraseHits(parts, hitsByPart, skippedBetween) {
    if (!parts.length) return [];
    const pools = parts.map(p => (hitsByPart.get(p) || []).slice());
    const out = [];
    const first = pools[0];
    for (let i = 0; i < first.length; i++) {
      const chain = [first[i]];
      let ok = true;
      for (let p = 1; p < parts.length; p++) {
        const prev = chain[chain.length - 1];
        let best = -1;
        let bestGap = Infinity;
        // Along the line first, and only then underneath: a phrase that sits
        // on one line is the ordinary case, and a word directly below is a
        // weaker claim that should not win over a word directly beside.
        for (const stacked of [false, true]) {
          for (let j = 0; j < pools[p].length; j++) {
            const cand = pools[p][j];
            const fits = stacked
              ? phraseHitsStacked(prev, cand)
              : phraseHitsAdjacent(prev, cand, (skippedBetween && skippedBetween[p - 1]) || 0);
            if (!fits) continue;
            const gap = stacked
              ? cand.y - (prev.y + prev.h)
              : cand.x - (prev.x + prev.w);
            if (gap < bestGap) { bestGap = gap; best = j; }
          }
          if (best >= 0) break;
          bestGap = Infinity;
        }
        if (best < 0) { ok = false; break; }
        chain.push(pools[p][best]);
        pools[p].splice(best, 1);
      }
      if (ok) out.push(unionHitRect(chain));
    }
    return out;
  }

  function skippedConnectorsBetween(term, leftPart, rightPart) {
    const tokens = String(term || '').trim().split(/\s+/);
    const li = tokens.findIndex(t => t.toLowerCase() === leftPart.toLowerCase());
    const ri = tokens.findIndex((t, i) => i > li && t.toLowerCase() === rightPart.toLowerCase());
    if (li < 0 || ri < 0) return 0;
    return Math.max(0, ri - li - 1);
  }

  root.BlindedMatch = {
    toGray, resize, prepareTemplate, integrals, boxSum, correlate, suppress, iou,
    overlapFraction, coveredFraction,
    phraseHitsAdjacent, phraseHitsStacked, unionHitRect, pairPhraseHits,
    skippedConnectorsBetween,
    trimToContent, crop, workingScale,
    WORK_SIZE, SCALES, scalesFor, ladder, MIN_COPY_AREA, THRESHOLD, OVERLAP,
    COARSE_SIZE, COARSE_SIZE_WIDE, WIDE_ASPECT, coarseSizeFor,
    FINE_SIZE, NATIVE_SIZE, VERIFY_RADIUS, VERIFY_GATE, VERIFY_LIMIT,
    COARSE_THRESHOLD, MAX_CANDIDATES, REFINE_STEPS,
    numeratorPlane, dotAt, FFT_MIN_POSITIONS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
