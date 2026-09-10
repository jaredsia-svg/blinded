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

  const Match = root.BlackbarMatch;

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
  const breathe = () => new Promise(resolve => setTimeout(resolve, 0));

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
  function prepareTemplate(template, opts) {
    const coarse = prepareAt(template, opts.coarseSize || Match.COARSE_SIZE);
    const fine = prepareAt(template, opts.fineSize || Match.FINE_SIZE);
    const native = prepareAt(template, opts.nativeSize || Match.NATIVE_SIZE);
    // A blank or near-blank pick has no structure to search for.
    if (!coarse || !fine || !native) return null;
    return { template, coarse, fine, native };
  }

  // Searches one already-decoded page for one prepared template.
  function searchPage(gray, pageW, pageH, ready, opts) {
    const scales = opts.scales || Match.SCALES;
    const threshold = opts.threshold === undefined ? Match.THRESHOLD : opts.threshold;
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
    for (const item of shortlist) {
      const hit = verify(gray, pageW, pageH, template, native, item.hit,
        [item.scale, item.hit.scale]) || item.hit;
      if (hit.score > best) best = hit.score;
      if (hit.score >= threshold) kept.push(hit);
    }
    // Nothing survived the gate, so the closest thing seen is refinement's own
    // best. Reported as a floor rather than left at zero, since "no match, and
    // nothing came close" is different from "no match at all".
    if (!kept.length) {
      for (const item of located) if (item.hit.score > best) best = item.hit.score;
    }

    return { matches: Match.suppress(kept, opts.overlap), best };
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
      results.set(entry.key, { matches: [], best: 0 });
      if (prepared) ready.push({ key: entry.key, ...prepared });
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

  function searchAllParallel(pages, entries, options, onProgress) {
    const opts = options || {};
    if (!WORKER_URL || typeof Worker !== 'function' || pages.length < 2) {
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
      for (const entry of entries) results.set(entry.key, { matches: [], best: 0 });

      let next = 0;
      let done = 0;
      let failed = false;
      const finish = () => { for (const w of workers) w.terminate(); };

      const feed = worker => {
        if (next >= pages.length) return;
        const page = pages[next++];
        const gray = grayFor(page);
        worker.postMessage({
          type: 'page',
          index: page.index,
          width: page.source.width,
          height: page.source.height,
          gray,
        }, [gray.buffer]);   // transferred, so nothing is copied
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
            for (const hit of found.matches) into.matches.push({ ...hit, pageIndex: message.index });
          }

          done++;
          if (onProgress) onProgress(done, pages.length);
          if (done === pages.length) { finish(); resolve(results); return; }
          feed(worker);
        };

        // Only the key and the pixels. Callers attach their own baggage to an
        // entry — a logo entry carries the template object it came from, whose
        // thumbnail is a canvas — and a canvas cannot be structured-cloned, so
        // posting the entries as given throws and takes the whole search with
        // it.
        worker.postMessage({
          type: 'init',
          entries: entries.map(entry => ({ key: entry.key, template: entry.template })),
          options: opts,
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

  root.BlackbarImageSearch = {
    search, searchAll, searchAllParallel, searchPage, prepareTemplate, grayFor,
    templateFrom, grayOf, refine, verify, nominate, prepareAt, interleave,
  };
})(typeof window !== 'undefined' ? window : globalThis);
