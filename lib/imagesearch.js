// Runs the template matcher over the pages of a document.
//
// lib/match.js does the arithmetic on plain arrays; this is the part that
// knows about canvases, about finding a logo at a size other than the one it
// was picked at, and about not freezing the tab while it works.
//
// The search is two-stage, and the reason is worth stating because the first
// version was one-stage and it did not work.
//
// A single sweep has to pick one working resolution, and there is no good
// choice. Coarse enough to sweep two dozen sizes quickly is too coarse to
// score honestly — a page shrunk to a tenth of its size has had the fine
// structure resampled out of it, so a true match scores 0.6 and gets thrown
// away. Fine enough to score honestly is far too slow to sweep. The original
// picked "fast", swept only 0.6x to 1.75x to stay affordable, and therefore
// could not find a logo at half size or double size at any threshold at all.
//
// So: a cheap sweep over a wide range of sizes nominates candidates at a
// deliberately generous threshold, and then each candidate is re-scored
// against the full-resolution page, with small nudges either side of its
// scale to recover what the ladder's steps left behind. Breadth comes from
// the first stage, accuracy from the second, and neither pays for the other.
(function (root) {
  'use strict';

  const Match = root.BlindedMatch;

  // Where the worker lives, resolved while this script is running because
  // document.currentScript is only meaningful then.
  const WORKER_URL = (typeof document !== 'undefined' && document.currentScript)
    ? new URL('searchworker.js', document.currentScript.src).href
    : null;

  // Pulls the picked region out of a canvas as greyscale, trimmed to whatever
  // ink is inside it — see trimToContent for why the trim matters so much.
  function templateFrom(canvas, rect) {
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const w = Math.min(canvas.width - x, Math.round(rect.w));
    const h = Math.min(canvas.height - y, Math.round(rect.h));
    if (w < 4 || h < 4) return null;

    const data = canvas.getContext('2d').getImageData(x, y, w, h).data;
    const gray = Match.toGray(data, w, h);
    const box = Match.trimToContent(gray, w, h);
    if (box.w < 4 || box.h < 4) return null;

    return {
      gray: Match.crop(gray, w, h, box),
      width: box.w,
      height: box.h,
      // Where the trimmed template sits inside the original pick, so the UI
      // can show the reviewer what was actually taken.
      origin: { x: x + box.x, y: y + box.y },
    };
  }

  function grayOf(canvas) {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return Match.toGray(data, canvas.width, canvas.height);
  }

  // Lets the browser paint between pages. Without it the whole sweep runs in
  // one turn of the event loop and the progress message never appears — the
  // tab simply locks until the search is finished.
  //
  // A timer here would be clamped to about one call a second in a background
  // tab, which is most of a minute added to a hundred-page sweep for nothing.
  const breathe = root.BlindedSchedule
    ? root.BlindedSchedule.nextTask
    : () => new Promise(resolve => setTimeout(resolve, 0));

  function prepareAt(template, size) {
    const base = Match.workingScale(template.width, template.height, size);
    if (!base) return null;
    const w = Math.max(2, Math.round(template.width * base));
    const h = Math.max(2, Math.round(template.height * base));
    const small = Match.resize(template.gray, template.width, template.height, w, h);
    const prepared = Match.prepareTemplate(small, w, h);
    return prepared ? { prepared, base } : null;
  }

  // ---------- stage one: where might it be ----------

  // Nominations are pooled per scale, never suppressed across scales.
  //
  // Suppressing across scales here was a real bug and cost half the matches on
  // a wide mark. A box is the template's shape times the scale, so a spurious
  // nomination at 3.6x is enormous — for a wide wordmark it spans the page —
  // and overlaps several rows at once. Suppression keeps the best-scoring box
  // of an overlapping group, and coarse scores are exactly the ones not worth
  // trusting, so one bad large-scale guess scoring 0.5 would delete three true
  // marks scoring 0.45 before refinement ever saw them.
  //
  // Within a single scale the boxes are all the same size, overlap means what
  // it should, and suppression is safe. Across scales the decision waits until
  // refinement has produced scores worth comparing.
  function nominate(gray, pageW, pageH, coarse, scales, perScale) {
    const keep = perScale || 8;
    const found = [];

    for (const scale of scales) {
      // At scale s the logo is s times the template's size, so the page has to
      // shrink by s for the fixed-size template to sit over it.
      const factor = coarse.base / scale;
      const pw = Math.round(pageW * factor);
      const ph = Math.round(pageH * factor);
      if (pw < coarse.prepared.width || ph < coarse.prepared.height) continue;

      const scaled = Match.resize(gray, pageW, pageH, pw, ph);
      const hits = Match.correlate(scaled, pw, ph, coarse.prepared,
        { threshold: Match.COARSE_THRESHOLD, anyPolarity: true });

      const atScale = hits.map(hit => ({
        x: hit.x / factor,
        y: hit.y / factor,
        w: coarse.prepared.width / factor,
        h: coarse.prepared.height / factor,
        scale,
        score: hit.score,
      }));
      // suppress returns best-first, so slice takes the strongest few.
      found.push(Match.suppress(atScale, 0.4).slice(0, keep));
    }
    return found;
  }

  // Picks which nominations get refined, taking the best from every scale
  // before the second-best from any of them.
  //
  // The obvious thing — pool them all, sort by score, keep the top N — is
  // wrong, and wrong in a way that quietly halved the matches on a wide mark.
  // A coarse score comes from correlating against a page resampled by a factor
  // that depends on the scale being tested, so scores from different scales
  // are not measurements of the same thing and ranking them against each other
  // is meaningless. In practice the true matches scored 0.59 to 0.70 and were
  // pushed past the cap by dozens of spurious nominations from other scales
  // scoring higher — despite every one of them scoring above 0.82 once
  // refinement looked at it properly.
  //
  // Round-robin makes the cap cost breadth of evidence per scale rather than
  // whole scales, so a logo whose size is unusual is still considered.
  function interleave(byScale, limit) {
    const out = [];
    const depth = Math.max(0, ...byScale.map(group => group.length));
    for (let rank = 0; rank < depth && out.length < limit; rank++) {
      for (const group of byScale) {
        if (rank < group.length && out.length < limit) out.push(group[rank]);
      }
    }
    return out;
  }

  // ---------- stage two: is it really there ----------

  // Re-scores one candidate against the original pixels rather than a
  // tenth-size copy of them, trying a few sizes either side of the coarse
  // guess. Returns the best {x, y, w, h, score} or null.
  function refine(gray, pageW, pageH, template, fine, candidate) {
    let best = null;

    for (const step of Match.REFINE_STEPS) {
      const scale = candidate.scale * step;
      const logoW = template.width * scale;
      const logoH = template.height * scale;
      if (logoW < 4 || logoH < 4 || logoW > pageW || logoH > pageH) continue;

      // Work on a crop around the candidate rather than the whole page: the
      // answer is known to be near here, and cropping is what makes
      // full-resolution scoring affordable at all.
      const margin = Math.max(6, logoW * 0.3, logoH * 0.3);
      const cx = Math.max(0, Math.floor(candidate.x - margin));
      const cy = Math.max(0, Math.floor(candidate.y - margin));
      const cw = Math.min(pageW - cx, Math.ceil(logoW + margin * 2));
      const ch = Math.min(pageH - cy, Math.ceil(logoH + margin * 2));
      if (cw < 4 || ch < 4) continue;

      const patch = Match.crop(gray, pageW, pageH, { x: cx, y: cy, w: cw, h: ch });

      // Resample the crop so the logo lands at the fine template's size.
      const factor = fine.prepared.width / logoW;
      const pw = Math.max(1, Math.round(cw * factor));
      const ph = Math.max(1, Math.round(ch * factor));
      if (pw < fine.prepared.width || ph < fine.prepared.height) continue;

      const scaled = Match.resize(patch, cw, ch, pw, ph);
      const hits = Match.correlate(scaled, pw, ph, fine.prepared,
        { threshold: -1, anyPolarity: true });
      for (const hit of hits) {
        if (best && hit.score <= best.score) continue;
        best = {
          x: cx + hit.x / factor,
          y: cy + hit.y / factor,
          w: logoW,
          h: logoH,
          score: hit.score,
          scale,
        };
      }
    }
    return best;
  }

  // ---------- stage three: score it honestly ----------

  // Re-scores a refined hit with the template at its own resolution.
  //
  // Refinement finds *where* something is; this decides whether it is really
  // the same thing. The distinction matters because the two questions have
  // different requirements: localising tolerates a shrunken template, scoring
  // does not, and using one number for both let sampling artefacts masquerade
  // as dissimilarity.
  //
  // At scale 1 the crop is not resampled at all, so a copy identical to the
  // pick correlates against it exactly. Only a few positions are tested, since
  // refinement has already done the searching.
  function verify(gray, pageW, pageH, template, native, hit, scales) {
    // Which sizes to check. Refinement chose its scale using the shrunken
    // template, where identical content scores unevenly, so its choice is a
    // suggestion rather than an answer — and inheriting it silently was enough
    // to sink a perfect match. A copy printed at the picked size sits exactly
    // on the ladder rung the nomination came from, so that rung is always
    // tried too, and at it no resampling happens at all.
    const candidates = [];
    for (const scale of (scales && scales.length ? scales : [hit.scale])) {
      if (scale > 0 && !candidates.some(s => Math.abs(s - scale) < 1e-6)) candidates.push(scale);
    }

    let best = null;
    for (const scale of candidates) {
      const w = template.width * scale;
      const h = template.height * scale;
      const factor = native.prepared.width / w;
      const margin = Math.ceil(VERIFY_MARGIN / factor);

      const cx = Math.max(0, Math.floor(hit.x - margin));
      const cy = Math.max(0, Math.floor(hit.y - margin));
      const cw = Math.min(pageW - cx, Math.ceil(w + margin * 2));
      const chh = Math.min(pageH - cy, Math.ceil(h + margin * 2));
      if (cw < 2 || chh < 2) continue;

      const patch = Match.crop(gray, pageW, pageH, { x: cx, y: cy, w: cw, h: chh });
      const pw = Math.max(1, Math.round(cw * factor));
      const ph = Math.max(1, Math.round(chh * factor));
      if (pw < native.prepared.width || ph < native.prepared.height) continue;

      const scaled = Match.resize(patch, cw, chh, pw, ph);
      for (const found of Match.correlate(scaled, pw, ph, native.prepared,
        { threshold: -1, anyPolarity: true })) {
        if (best && found.score <= best.score) continue;
        best = {
          x: cx + found.x / factor,
          y: cy + found.y / factor,
          w, h,
          score: found.score,
          inverted: Boolean(found.inverted),
          scale,
        };
      }
    }
    return best;
  }

  const VERIFY_MARGIN = Match.VERIFY_RADIUS;

  // ---------- one pass, every template ----------

  // Everything one template needs, worked out once rather than per page.
  // How far a page is resampled up when hunting for small lettering.
  const SMALL_TEXT_UPSCALE = 1.5;

  function prepareTemplate(template, opts) {
    const coarse = prepareAt(template,
      opts.coarseSize || Match.coarseSizeFor(template.width, template.height));
    const fine = prepareAt(template, opts.fineSize || Match.FINE_SIZE);
    const native = prepareAt(template, opts.nativeSize || Match.NATIVE_SIZE);
    // A blank or near-blank pick has no structure to search for.
    if (!coarse || !fine || !native) return null;
    return { template, coarse, fine, native };
  }

  // Searches one already-decoded page for one prepared template.
  // A 1.5x resampling of a page, kept per page so a sweep of several word
  // templates pays for it once.
  const upscaled = new WeakMap();

  function upscaledOf(gray, width, height) {
    let up = upscaled.get(gray);
    if (up) return up;
    const w = Math.round(width * SMALL_TEXT_UPSCALE);
    const h = Math.round(height * SMALL_TEXT_UPSCALE);
    up = { gray: Match.resize(gray, width, height, w, h), width: w, height: h };
    upscaled.set(gray, up);
    return up;
  }

  function searchPage(gray, pageW, pageH, ready, opts) {
    const scales = opts.scales || Match.SCALES;
    // A template may carry its own threshold, and it wins over the sweep's.
    // Not every template deserves the same bar: a logo cut out of the document
    // is being matched against itself and should correlate almost perfectly,
    // while a word drawn here in Helvetica is only ever an approximation of
    // whatever typeface the document was actually set in, and never reaches
    // the same scores. Holding both to one number means either the logos let
    // rubbish through or the words are never found at all.
    const threshold = ready.threshold !== undefined ? ready.threshold
      : (opts.threshold === undefined ? Match.THRESHOLD : opts.threshold);
    const { template, coarse, fine, native } = ready;

    const nominated = interleave(
      nominate(gray, pageW, pageH, coarse, scales, opts.perScale),
      opts.maxCandidates || Match.MAX_CANDIDATES);

    // Locate everything first. This is the cheap half.
    const located = [];
    for (const candidate of nominated) {
      const hit = refine(gray, pageW, pageH, template, fine, candidate);
      if (hit) located.push({ hit, scale: candidate.scale });
    }

    // Then verify only the plausible ones, best first. Refinement says where;
    // verification says whether — and its score is the one reported, so what
    // the reviewer sees on the sensitivity control is a like-for-like
    // comparison rather than a sampling artefact.
    const gate = opts.verifyGate === undefined ? Match.VERIFY_GATE : opts.verifyGate;
    const shortlist = located
      .filter(item => item.hit.score >= gate)
      .sort((a, b) => b.hit.score - a.hit.score)
      .slice(0, opts.verifyLimit || Match.VERIFY_LIMIT);

    let best = 0;
    const kept = [];
    // What the bar turned away.
    //
    // Every one of these has been verified at full resolution, so its score is
    // as trustworthy as an accepted one — it simply fell on the other side of
    // a number the reviewer chose. Without it the panel can only describe what
    // was found, which is the half of the picture that does not help: a
    // reviewer looking at two marks when they expected seven needs to know
    // that five more scored 0.95 down to 0.93, not to guess the bar downwards
    // and re-run until something appears.
    const turnedAway = [];
    for (const item of shortlist) {
      const hit = verify(gray, pageW, pageH, template, native, item.hit,
        [item.scale, item.hit.scale]) || item.hit;
      if (hit.score > best) best = hit.score;
      if (hit.score >= threshold) kept.push(hit);
      else turnedAway.push(hit.score);
    }
    // Nothing survived the gate, so the closest thing seen is refinement's own
    // best. Reported as a floor rather than left at zero, since "no match, and
    // nothing came close" is different from "no match at all".
    if (!kept.length) {
      for (const item of located) if (item.hit.score > best) best = item.hit.score;
    }

    let matches = kept;
    let bestScore = best;

    // Body text set as a picture is the case this exists for. A word 14 pixels
    // tall has to be matched against a template shrunk to 14 pixels, and at
    // that size letterforms smear into a blob: on a real slide, a "KAG" in a
    // caption scored 0.314 — noise, and in the wrong place — while the same
    // word in the title scored 0.725.
    //
    // The fix is not more page detail. Resampling the page we already have up
    // by half scored 0.677 there, matching a genuine re-render at 3x (0.655),
    // because what was lost was the template's shape, not the page's. So the
    // second pass costs some arithmetic and no re-rendering.
    //
    // It is run in addition to the first, never instead of it, so nothing that
    // was found before can be lost by turning it on.
    if (ready.smallText) {
      const up = upscaledOf(gray, pageW, pageH);
      const found = searchPage(up.gray, up.width, up.height,
        { ...ready, smallText: false }, opts);
      const factor = 1 / SMALL_TEXT_UPSCALE;
      if (found.best > bestScore) bestScore = found.best;
      for (const score of found.near || []) turnedAway.push(score);
      matches = matches.concat(found.matches.map(hit => ({
        ...hit,
        x: hit.x * factor, y: hit.y * factor,
        w: hit.w * factor, h: hit.h * factor,
      })));
    }

    return { matches: Match.suppress(matches, opts.overlap), best: bestScore,
             near: turnedAway };
  }

  // The greyscale of a page.
  //
  // Reading a page back off its canvas and converting it costs around 25ms at
  // the resolution these render at, and it used to be paid again for every
  // template and every typeface variant. It is now paid once per page per
  // sweep, because the outer loop is pages.
  //
  // Deliberately *not* cached on the page between sweeps. A letter page at
  // this resolution is nearly two million pixels, so its greyscale is about
  // 8MB; holding one per page would cost the better part of a gigabyte on a
  // hundred-page document, to save a few seconds on a second press of Redact.
  // That is not a trade worth making in a tab that also holds the document.
  function grayFor(page) {
    return grayOf(page.source);
  }

  /**
   * Searches every page for every template, in one pass.
   *
   * `entries` is [{ key, template }]. The outer loop is pages and the inner
   * loop is templates, not the other way round — which is the whole point.
   * Searching each template over the whole document in turn means decoding
   * every page once per template, and it means the reviewer watches the
   * document be swept from beginning to end once per image with no way to tell
   * how much is left. One pass decodes each page once and can honestly say
   * "page 7 of 100".
   *
   * Returns a Map from key to { matches, best }, matches carrying pageIndex.
   */
  async function searchAll(pages, entries, options, onProgress) {
    const opts = options || {};
    const results = new Map();

    const ready = [];
    for (const entry of entries) {
      const prepared = prepareTemplate(entry.template, opts);
      results.set(entry.key, { matches: [], best: 0, near: [] });
      if (prepared) ready.push({
      key: entry.key, threshold: entry.threshold, smallText: entry.smallText, ...prepared,
    });
    }
    if (!ready.length) return results;

    for (const page of pages) {
      const gray = grayFor(page);
      const pageW = page.source.width;
      const pageH = page.source.height;

      for (const item of ready) {
        const found = searchPage(gray, pageW, pageH, item, opts);
        const into = results.get(item.key);
        if (found.best > into.best) into.best = found.best;
        for (const score of found.near || []) into.near.push(score);
        for (const hit of found.matches) into.matches.push({ ...hit, pageIndex: page.index });
      }

      if (onProgress) onProgress(page.index + 1, pages.length);
      // Let the browser paint between pages. Without this the whole sweep runs
      // in one turn of the event loop and the progress message never appears —
      // the tab simply locks until it is finished.
      await breathe();
    }
    return results;
  }

  // ---------- the same pass, spread across cores ----------
  //
  // Correlation is the cost, and it is embarrassingly parallel: no page's
  // result depends on any other's. On a hundred-page document that is the
  // difference between a search you wait out and one you sit through.
  //
  // Pages are handed out one at a time rather than divided up in advance, so a
  // core that draws a page full of candidates does not leave the others idle.
  // Only as many greyscales exist at once as there are workers, which is what
  // keeps a long document from exhausting memory.
  function workerCount() {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    // Leave a core for the page itself. The ceiling is generous because the
    // measured scaling is close to linear — three workers gave 3.0x on a
    // twelve-page fixture — and the per-page hand-off is a transfer rather
    // than a copy, so it costs almost nothing to add another.
    return Math.max(1, Math.min(8, cores - 1));
  }

  // Everything in the options that survives being posted to a worker. A
  // caller's callbacks stay on this side.
  function cloneableOptions(options) {
    const out = {};
    for (const [key, value] of Object.entries(options || {})) {
      if (typeof value !== 'function') out[key] = value;
    }
    return out;
  }

  function searchAllParallel(pages, entries, options, onProgress) {
    const opts = options || {};
    // A single page used to be searched here on the main thread, on the
    // grounds that one worker for one page buys no parallelism. It buys
    // something better: the page keeps painting. Two megapixels against two
    // templates is seconds of arithmetic, and seconds of arithmetic on the
    // main thread is a tab that stops responding to its own progress bar.
    if (!WORKER_URL || typeof Worker !== 'function' || !pages.length) {
      return searchAll(pages, entries, opts, onProgress);
    }

    const count = Math.min(workerCount(), pages.length);
    let workers;
    try {
      workers = Array.from({ length: count }, () => new Worker(WORKER_URL));
    } catch {
      // Some environments refuse workers outright; the single-threaded path
      // gives the same answers, just slower.
      return searchAll(pages, entries, opts, onProgress);
    }

    return new Promise((resolve, reject) => {
      const results = new Map();
      for (const entry of entries) results.set(entry.key, { matches: [], best: 0, near: [] });

      let next = 0;
      let done = 0;
      let failed = false;
      let stopped = false;
      const finish = () => { for (const w of workers) w.terminate(); };

      // Stopping. A long sweep that cannot be called off is one a reviewer
      // has to sit out, so the caller can hand in something to check; what has
      // been found by then is returned rather than thrown away.
      const stopper = opts.stop;
      const shouldStop = () => Boolean(stopper && stopper());

      // Handing a page over.
      //
      // The greyscale used to be made here, on the main thread: a getImageData
      // of the whole page and then a pass over every pixel, once per page.
      // Measured on a 96-page document that was the difference between a
      // responsive tab and one that stalls for half a second at a time, and
      // on a slower machine it is what makes the browser offer to kill the
      // page. An ImageBitmap is cheap to make and can be transferred, so the
      // pixels are decoded where the arithmetic already happens.
      const canBitmap = typeof createImageBitmap === 'function';

      const feed = worker => {
        if (stopped || next >= pages.length) return;
        const page = pages[next++];
        const width = page.source.width;
        const height = page.source.height;
        if (!canBitmap) {
          const gray = grayFor(page);
          worker.postMessage({ type: 'page', index: page.index, width, height, gray },
            [gray.buffer]);   // transferred, so nothing is copied
          return;
        }
        createImageBitmap(page.source).then(bitmap => {
          if (stopped) { bitmap.close(); return; }
          worker.postMessage({ type: 'page', index: page.index, width, height, bitmap },
            [bitmap]);
        }).catch(() => {
          // A bitmap that cannot be made is not a reason to lose the page.
          const gray = grayFor(page);
          worker.postMessage({ type: 'page', index: page.index, width, height, gray },
            [gray.buffer]);
        });
      };

      for (const worker of workers) {
        worker.onerror = event => {
          if (failed) return;
          failed = true;
          finish();
          reject(new Error('the search worker failed: ' + (event.message || 'unknown')));
        };
        worker.onmessage = event => {
          const message = event.data;
          if (message.type !== 'result' || failed) return;

          for (const found of message.results) {
            const into = results.get(found.key);
            if (!into) continue;
            if (found.best > into.best) into.best = found.best;
            for (const score of found.near || []) into.near.push(score);
            for (const hit of found.matches) into.matches.push({ ...hit, pageIndex: message.index });
          }

          done++;
          if (onProgress) onProgress(done, pages.length);
          if (done === pages.length) { finish(); resolve(results); return; }
          if (shouldStop()) {
            stopped = true;
            finish();
            results.stoppedAfter = done;
            resolve(results);
            return;
          }
          feed(worker);
        };

        // Only the key and the pixels. Callers attach their own baggage to an
        // entry — a logo entry carries the template object it came from, whose
        // thumbnail is a canvas — and a canvas cannot be structured-cloned, so
        // posting the entries as given throws and takes the whole search with
        // it. The options are the same trap: `stop` is a function the caller
        // owns, and posting it failed the entire sweep with "could not be
        // cloned" before the first page was looked at.
        worker.postMessage({
          type: 'init',
          entries: entries.map(entry => ({
            key: entry.key, template: entry.template, threshold: entry.threshold,
            smallText: entry.smallText,
          })),
          options: cloneableOptions(opts),
        });
        feed(worker);
      }
    });
  }

  /**
   * One template across every page. A thin wrapper over searchAll, kept
   * because a single search reads better at the call site and in tests.
   */
  async function search(pages, template, options, onProgress) {
    const results = await searchAll(pages, [{ key: 'one', template }], options, onProgress);
    return results.get('one');
  }

  root.BlindedImageSearch = {
    search, searchAll, searchAllParallel, searchPage, prepareTemplate, grayFor,
    cloneableOptions,
    upscaledOf, SMALL_TEXT_UPSCALE,
    templateFrom, grayOf, refine, verify, nominate, prepareAt, interleave,
  };
})(typeof window !== 'undefined' ? window : globalThis);
