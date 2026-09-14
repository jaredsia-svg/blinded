// Page preparation shared by image search and OCR.
//
// Large photo pages (a phone snap of a monitor, a scanned CIM slide) are the
// expensive case: tens of megapixels of moiré and map texture where only a
// fraction of the ink is text. Everything here exists to shrink that work
// without throwing away the lettering.
(function (root) {
  'use strict';

  const Match = root.BlindedMatch;

  // Long edge of the greyscale the correlator actually searches. Full-res
  // verify still looks at a crop of the original; this only bounds the
  // nominate/refine arithmetic.
  const WORK_LONG_EDGE = 1800;

  // smallText's 1.5x pass is for captions on modest pages. On a 12MP photo it
  // is pure cost — the page is already fine enough.
  const SMALL_TEXT_MAX_LONG_EDGE = 1600;

  // Text-region grid. Cell variance above the page's soft floor counts as ink.
  const REGION_CELL = 32;
  const REGION_PAD = 12;

  function longEdge(width, height) {
    return Math.max(width, height);
  }

  function workSize(width, height, maxLong) {
    const cap = maxLong === undefined ? WORK_LONG_EDGE : maxLong;
    const long = longEdge(width, height);
    if (long <= cap) return { width: width, height: height, scale: 1 };
    const scale = cap / long;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale: scale,
    };
  }

  function downsampleGray(gray, width, height, maxLong) {
    const size = workSize(width, height, maxLong);
    if (size.scale === 1) {
      return { gray: gray, width: width, height: height, scale: 1 };
    }
    return {
      gray: Match.resize(gray, width, height, size.width, size.height),
      width: size.width,
      height: size.height,
      scale: size.scale,
    };
  }

  // Two or three halves of the working grey, so nominate can pick a level
  // close to the size it needs instead of resampling the full working page
  // from scratch for every scale of every template.
  function buildPyramid(gray, width, height) {
    const levels = [{ gray: gray, width: width, height: height }];
    let cw = width;
    let ch = height;
    let cg = gray;
    while (levels.length < 4 && Math.max(cw, ch) > 64) {
      const nw = Math.max(1, Math.round(cw / 2));
      const nh = Math.max(1, Math.round(ch / 2));
      cg = Match.resize(cg, cw, ch, nw, nh);
      cw = nw;
      ch = nh;
      levels.push({ gray: cg, width: cw, height: ch });
    }
    return levels;
  }

  // Closest pyramid level to a target width, for coarse nominate.
  function pyramidLevel(pyramid, targetW) {
    let best = pyramid[0];
    let bestDist = Math.abs(best.width - targetW);
    for (let i = 1; i < pyramid.length; i++) {
      const dist = Math.abs(pyramid[i].width - targetW);
      if (dist < bestDist) {
        best = pyramid[i];
        bestDist = dist;
      }
    }
    return best;
  }

  // Cheap ink map → merged axis-aligned regions in the grey's coordinates.
  //
  // Empty ocean / solid fills stay out; lettering, tables and titles stay in.
  // If almost the whole page looks like ink, returns [] so the caller searches
  // the full page rather than pretending a mask helped.
  function textRegions(gray, width, height) {
    const cell = REGION_CELL;
    const cols = Math.max(1, Math.ceil(width / cell));
    const rows = Math.max(1, Math.ceil(height / cell));
    const scores = new Float32Array(cols * rows);

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x0 = cx * cell;
        const y0 = cy * cell;
        const x1 = Math.min(width, x0 + cell);
        const y1 = Math.min(height, y0 + cell);
        let sum = 0;
        let sumSq = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          const row = y * width;
          for (let x = x0; x < x1; x++) {
            const v = gray[row + x];
            sum += v;
            sumSq += v * v;
            n++;
          }
        }
        const mean = sum / n;
        // Variance is a stand-in for "there is structure here". Flat map fill
        // and white margin score near zero; text and UI chrome score high.
        scores[cy * cols + cx] = Math.max(0, sumSq / n - mean * mean);
      }
    }

    // Soft floor: keep cells clearly above the quiet background.
    let sorted = Array.from(scores).sort((a, b) => a - b);
    const baseline = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const floor = Math.max(40, baseline * 3);
    const mark = new Uint8Array(cols * rows);
    let ink = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= floor) {
        mark[i] = 1;
        ink++;
      }
    }
    if (!ink) return [];
    // Whole page is busy — masking would not save work.
    if (ink > cols * rows * 0.85) return [];

    // Dilate once so letters in a word stay connected across cell boundaries.
    const dilate = new Uint8Array(mark);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!mark[cy * cols + cx]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = cy + dy;
            const nx = cx + dx;
            if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;
            dilate[ny * cols + nx] = 1;
          }
        }
      }
    }

    // Connected components → bounding boxes.
    const seen = new Uint8Array(cols * rows);
    const regions = [];
    const stack = [];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const start = cy * cols + cx;
        if (!dilate[start] || seen[start]) continue;
        let minX = cx;
        let maxX = cx;
        let minY = cy;
        let maxY = cy;
        stack.length = 0;
        stack.push(cx, cy);
        seen[start] = 1;
        while (stack.length) {
          const y = stack.pop();
          const x = stack.pop();
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
              const i = ny * cols + nx;
              if (!dilate[i] || seen[i]) continue;
              seen[i] = 1;
              stack.push(nx, ny);
            }
          }
        }
        const pad = REGION_PAD;
        const rx = Math.max(0, minX * cell - pad);
        const ry = Math.max(0, minY * cell - pad);
        const rw = Math.min(width - rx, (maxX + 1) * cell - rx + pad);
        const rh = Math.min(height - ry, (maxY + 1) * cell - ry + pad);
        // Drop specks.
        if (rw < cell && rh < cell) continue;
        regions.push({ x: rx, y: ry, w: rw, h: rh });
      }
    }

    regions.sort((a, b) => a.y - b.y || a.x - b.x);
    return regions;
  }

  // Fill non-text with the page mean so correlation does not fire on texture,
  // while leaving lettering untouched.
  function maskGray(gray, width, height, regions) {
    if (!regions || !regions.length) return gray;
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    const mean = sum / gray.length;
    const out = new Float32Array(gray.length);
    out.fill(mean);
    for (const r of regions) {
      const x1 = Math.min(width, r.x + r.w);
      const y1 = Math.min(height, r.y + r.h);
      for (let y = Math.max(0, r.y); y < y1; y++) {
        const row = y * width;
        for (let x = Math.max(0, r.x); x < x1; x++) out[row + x] = gray[row + x];
      }
    }
    return out;
  }

  // ----- OCR helpers (canvas in, canvas out) -----

  function canvasToGray(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return Match.toGray(data, canvas.width, canvas.height);
  }

  // High-frequency energy points at a photo of a screen (moire / pixel grid).
  function looksLikeScreenPhoto(gray, width, height) {
    const step = Math.max(2, Math.floor(Math.min(width, height) / 200));
    let edges = 0;
    let n = 0;
    for (let y = 0; y < height - step; y += step) {
      const row = y * width;
      const row2 = (y + step) * width;
      for (let x = 0; x < width - step; x += step) {
        const dx = Math.abs(gray[row + x] - gray[row + x + step]);
        const dy = Math.abs(gray[row + x] - gray[row2 + x]);
        if (dx + dy > 40) edges++;
        n++;
      }
    }
    return n > 0 && edges / n > 0.35;
  }

  function grayToCanvas(gray, width, height) {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    const image = ctx.createImageData(width, height);
    const data = image.data;
    for (let i = 0, j = 0; j < gray.length; j++, i += 4) {
      const v = Math.max(0, Math.min(255, gray[j]));
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  // Mild blur + local contrast. Aimed at moiré from a photographed monitor
  // without melting small type into the background.
  function enhanceGray(gray, width, height, screenPhoto) {
    const src = gray;
    const out = new Float32Array(src.length);
    // Separable 3-tap blur when a screen grid is present; identity otherwise.
    if (screenPhoto) {
      const tmp = new Float32Array(src.length);
      for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
          const x0 = Math.max(0, x - 1);
          const x1 = Math.min(width - 1, x + 1);
          tmp[row + x] = (src[row + x0] + src[row + x] * 2 + src[row + x1]) * 0.25;
        }
      }
      for (let y = 0; y < height; y++) {
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(height - 1, y + 1);
        for (let x = 0; x < width; x++) {
          out[y * width + x] =
            (tmp[y0 * width + x] + tmp[y * width + x] * 2 + tmp[y1 * width + x]) * 0.25;
        }
      }
    } else {
      out.set(src);
    }

    // Local contrast via a coarse mean grid (approx CLAHE-lite).
    const cell = 64;
    const cols = Math.max(1, Math.ceil(width / cell));
    const rows = Math.max(1, Math.ceil(height / cell));
    const means = new Float32Array(cols * rows);
    const counts = new Float32Array(cols * rows);
    for (let y = 0; y < height; y++) {
      const cy = Math.min(rows - 1, (y / cell) | 0);
      for (let x = 0; x < width; x++) {
        const cx = Math.min(cols - 1, (x / cell) | 0);
        const i = cy * cols + cx;
        means[i] += out[y * width + x];
        counts[i]++;
      }
    }
    for (let i = 0; i < means.length; i++) means[i] /= Math.max(1, counts[i]);

    for (let y = 0; y < height; y++) {
      const cy = Math.min(rows - 1, (y / cell) | 0);
      for (let x = 0; x < width; x++) {
        const cx = Math.min(cols - 1, (x / cell) | 0);
        const local = means[cy * cols + cx];
        const v = out[y * width + x];
        // Push away from the local mean a little.
        const boosted = local + (v - local) * 1.35;
        out[y * width + x] = Math.max(0, Math.min(255, boosted));
      }
    }
    return out;
  }

  // Deskew via vertical projection variance over a small angle range.
  // Cheap and good enough for a slightly tilted phone photo.
  function estimateSkewDegrees(gray, width, height) {
    const step = Math.max(2, (Math.min(width, height) / 150) | 0);
    const angles = [-3, -2, -1, 0, 1, 2, 3];
    let best = 0;
    let bestScore = -1;
    for (const angle of angles) {
      const rad = angle * Math.PI / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const hist = new Float32Array(height);
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const v = gray[y * width + x];
          if (v > 200) continue; // skip paper
          const yy = Math.round(y * cos + x * sin);
          if (yy >= 0 && yy < height) hist[yy] += 255 - v;
        }
      }
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let i = 0; i < hist.length; i++) {
        const h = hist[i];
        if (!h) continue;
        sum += h;
        sumSq += h * h;
        n++;
      }
      if (!n) continue;
      const mean = sum / n;
      const score = sumSq / n - mean * mean;
      if (score > bestScore) {
        bestScore = score;
        best = angle;
      }
    }
    return best;
  }

  function rotateGray(gray, width, height, degrees) {
    if (!degrees) return { gray: gray, width: width, height: height };
    const rad = degrees * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const out = new Float32Array(width * height);
    out.fill(255);
    const cx = width / 2;
    const cy = height / 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const sx = Math.round(cx + dx * cos + dy * sin);
        const sy = Math.round(cy - dx * sin + dy * cos);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        out[y * width + x] = gray[sy * width + sx];
      }
    }
    return { gray: out, width: width, height: height };
  }

  function prepareOcrCanvas(canvas) {
    const width = canvas.width;
    const height = canvas.height;
    let gray = canvasToGray(canvas);
    // Cap OCR working size the same way the correlator does. Boxes are scaled
    // back to the original canvas so redaction still lands on the page render.
    const work = downsampleGray(gray, width, height, WORK_LONG_EDGE);
    gray = work.gray;
    const ww = work.width;
    const wh = work.height;
    const screen = looksLikeScreenPhoto(gray, ww, wh);
    gray = enhanceGray(gray, ww, wh, screen);
    const skew = estimateSkewDegrees(gray, ww, wh);
    const rotated = rotateGray(gray, ww, wh, skew);
    const out = grayToCanvas(rotated.gray, rotated.width, rotated.height);
    return {
      canvas: out,
      screenPhoto: screen,
      skewDegrees: skew,
      width: rotated.width,
      height: rotated.height,
      // Multiply prepared-space coords by toOrig to reach the caller's canvas.
      scale: work.scale,
      toOrig: work.scale === 1 ? 1 : (1 / work.scale),
      sourceWidth: width,
      sourceHeight: height,
    };
  }

  // Crops for region-then-OCR. Coordinates are in the prepared canvas space.
  // Tiny or near-full-page region lists collapse to a single full-page crop.
  function ocrRegionCrops(canvas, regions) {
    const width = canvas.width;
    const height = canvas.height;
    if (!regions || regions.length < 2) {
      return [{ canvas: canvas, x: 0, y: 0, w: width, h: height }];
    }
    const area = regions.reduce((s, r) => s + r.w * r.h, 0);
    if (area >= width * height * 0.85) {
      return [{ canvas: canvas, x: 0, y: 0, w: width, h: height }];
    }
    const crops = [];
    for (const r of regions) {
      if (r.w < 24 || r.h < 16) continue;
      const c = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(r.w, r.h)
        : document.createElement('canvas');
      c.width = r.w;
      c.height = r.h;
      const ctx = c.getContext('2d', { alpha: false });
      ctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      crops.push({ canvas: c, x: r.x, y: r.y, w: r.w, h: r.h });
    }
    return crops.length ? crops : [{ canvas: canvas, x: 0, y: 0, w: width, h: height }];
  }

  // Per-page assets for image search, cached on the source greyscale.
  const cache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function pageAssets(gray, width, height) {
    if (cache) {
      const hit = cache.get(gray);
      if (hit) return hit;
    }
    const work = downsampleGray(gray, width, height, WORK_LONG_EDGE);
    const regions = textRegions(work.gray, work.width, work.height);
    const masked = maskGray(work.gray, work.width, work.height, regions);
    const pyramid = buildPyramid(masked, work.width, work.height);
    const assets = {
      original: { gray: gray, width: width, height: height },
      work: work,
      regions: regions,
      masked: masked,
      pyramid: pyramid,
      allowSmallText: longEdge(width, height) <= SMALL_TEXT_MAX_LONG_EDGE,
    };
    if (cache) cache.set(gray, assets);
    return assets;
  }

  root.BlindedPagePrep = {
    WORK_LONG_EDGE,
    SMALL_TEXT_MAX_LONG_EDGE,
    workSize,
    downsampleGray,
    buildPyramid,
    pyramidLevel,
    textRegions,
    maskGray,
    looksLikeScreenPhoto,
    prepareOcrCanvas,
    ocrRegionCrops,
    pageAssets,
    canvasToGray,
    enhanceGray,
    estimateSkewDegrees,
  };
})(typeof window !== 'undefined' ? window : globalThis);
