// Reading a page instead of correlating against it.
//
// Everything else in this tool that hunts for a word inside a picture is
// template matching: draw the word, slide it over the page, score the overlap.
// That works, and every awkward case it has ever failed on has been the same
// failure — it does not know what the letters are. Italic needed its own
// typefaces. Lettering twelve pixels tall needed the page resampled. A
// four-letter acronym needed its own threshold, because a short word resembles
// a great deal of a page. None of those are bugs in the matcher; they are the
// cost of guessing at shapes.
//
// Tesseract reads the glyphs. Measured on the three documents that forced each
// of those fixes: six true occurrences found on one page with nothing false,
// all three found on another including the caption that scored 0.314 against a
// template, and zero on the deck where a four-letter acronym had matched 333
// times. No threshold anywhere.
//
// It is not a replacement for the image search. A cut-out logo, a signature, a
// stamp — none of those are letters, and they stay with the matcher.
//
// Everything here is local. The engine, its WebAssembly and the language data
// are served from this origin, not a CDN, so switching this on still contacts
// nobody. They are about eleven megabytes together, which is why nothing is
// fetched until the reviewer actually asks for OCR.
(function (root) {
  'use strict';

  const PagePrep = root.BlindedPagePrep;

  const BASE = 'vendor/tesseract/';

  // The same proportions lib/boxes.js uses, so OCR words and pdf.js items
  // describe a line the same way and the existing box code fits both.
  const ASCENT = 0.82;

  // How many engines to run at once.
  //
  // Unlike the correlation search, these do not share memory and each one
  // holds its own copy of the model, so the ceiling is lower: this is bounded
  // by memory rather than by cores. The assets are fetched once by the browser
  // and served from its cache to the rest.
  const MAX_ENGINES = 4;

  function engineCount(pages) {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    return Math.max(1, Math.min(MAX_ENGINES, cores - 1, pages));
  }

  let pool = [];
  let loading = null;

  // Which WebAssembly build to use.
  //
  // Left to itself the engine picks from six variants and fetches whichever it
  // likes — including relaxed-SIMD builds. Each is about four megabytes, and
  // vendoring all six to satisfy a runtime choice is silly, so the build is
  // pinned here and only the two that are pinned are shipped. The SIMD one is
  // what any browser from the last few years will take; the plain one is the
  // fallback, and the test below is the standard v128 feature probe.
  // A module whose only distinguishing feature is one SIMD instruction:
  // i32.const 0, i8x16.splat, drop. An engine without SIMD rejects it.
  //
  // The first version of this was copied from memory and was malformed, so it
  // failed to validate everywhere and every browser quietly got the slower
  // build. PROBE_CONTROL is the same module with the SIMD opcode taken out; it
  // must validate anywhere at all, and the test asserts that, so a probe that
  // is broken rather than merely unsupported cannot pass unnoticed again.
  const SIMD_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x1a, 0x0b,
  ]);

  const PROBE_CONTROL = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x07, 0x01, 0x05, 0x00, 0x41, 0x00, 0x1a, 0x0b,
  ]);

  function corePath() {
    let simd = false;
    try { simd = WebAssembly.validate(SIMD_PROBE); } catch { simd = false; }
    return BASE + (simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.onload = () => resolve();
      tag.onerror = () => reject(new Error('could not load ' + src));
      document.head.appendChild(tag);
    });
  }

  async function makeEngine(onProgress) {
    if (!root.Tesseract) await loadScript(BASE + 'tesseract.min.js');
    if (!root.Tesseract) throw new Error('the OCR engine did not load');
    // The logger key is omitted rather than set to undefined: the engine calls
    // whatever is under it without checking.
    const options = {
      workerPath: BASE + 'worker.min.js',
      corePath: corePath(),
      langPath: BASE,
      gzip: true,
    };
    if (onProgress) options.logger = onProgress;
    return root.Tesseract.createWorker('eng', 1, options);
  }

  // Engines are built once and kept for the session. The first is built alone
  // so the browser fills its cache with the model before the rest ask for it;
  // starting four at once made four requests for the same three megabytes.
  async function engines(want, onProgress) {
    if (pool.length >= want) return pool.slice(0, want);
    if (!loading) {
      loading = (async () => {
        if (!pool.length) pool.push(await makeEngine(onProgress));
        while (pool.length < want) {
          const batch = [];
          for (let i = pool.length; i < want; i++) batch.push(makeEngine());
          pool = pool.concat(await Promise.all(batch));
        }
        return pool;
      })();
      loading.catch(() => { loading = null; });
    }
    const ready = await loading;
    loading = null;
    return ready.slice(0, want);
  }

  // One engine, for a single page.
  async function engine(onProgress) {
    const ready = await engines(1, onProgress);
    return ready[0];
  }

  // Tesseract nests blocks inside blocks; the words are the leaves.
  function wordsOf(data) {
    const out = [];
    const walk = node => {
      if (!node) return;
      let descended = false;
      for (const key of ['blocks', 'paragraphs', 'lines', 'words']) {
        if (Array.isArray(node[key])) {
          descended = true;
          for (const child of node[key]) walk(child);
        }
      }
      if (!descended && node.bbox && typeof node.text === 'string') out.push(node);
    };
    for (const block of data.blocks || []) walk(block);
    return out;
  }

  // One page, as items shaped like the ones lib/pdfread.js produces, so the
  // term matching and box slicing that already exist apply unchanged.
  //
  // Deliberately no confidence filter. The italic captions that this was built
  // for came back at 47, 31 and 17 — read correctly every time, and discarded
  // by any threshold worth the name. Tesseract's confidence says how sure it is
  // of the shapes, not whether the word is the one being looked for, and the
  // reviewer sees every proposal anyway.
  async function readPage(canvas, onProgress) {
    return readWith(await engine(onProgress), canvas);
  }

  function itemsFromData(data, offsetX, offsetY, toOrig) {
    const ox = offsetX || 0;
    const oy = offsetY || 0;
    const s = toOrig === undefined ? 1 : toOrig;
    const items = [];
    for (const word of wordsOf(data)) {
      const text = String(word.text || '');
      if (!text.trim()) continue;
      const box = word.bbox;
      const height = Math.max(1, box.y1 - box.y0);
      const x0 = (box.x0 + ox) * s;
      const y0 = (box.y0 + oy) * s;
      const x1 = (box.x1 + ox) * s;
      const y1 = (box.y1 + oy) * s;
      const h = Math.max(1, y1 - y0);
      items.push({
        str: text,
        x: x0,
        // lib/boxes.js measures a line from its baseline, upwards by ASCENT.
        // The bottom of the ink is the closest thing OCR gives to a baseline.
        y: y1,
        w: Math.max(1, x1 - x0),
        h: h / ASCENT,
        hasEOL: false,
        confidence: word.confidence,
        // The ink OCR actually saw, kept exactly. Slicing a fraction of a word
        // out of this would be guesswork; see matchOcr in app.js.
        rect: {
          x: x0, y: y0,
          w: Math.max(1, x1 - x0),
          h: h,
        },
      });
    }
    return items;
  }

  function markLineEnds(items) {
    // Mark line ends so the stitched text breaks where the page breaks. Items
    // come back in reading order, so a drop to a new line is a new line.
    for (let i = 0; i < items.length - 1; i++) {
      const here = items[i];
      const next = items[i + 1];
      const sameLine = Math.abs(next.y - here.y) <= Math.max(here.h, next.h) * 0.5
        && next.x >= here.x;
      if (!sameLine) here.hasEOL = true;
    }
    if (items.length) items[items.length - 1].hasEOL = true;
    return items;
  }

  // Minimum confidence for words found only on an inverted dark-band pass.
  // Lower than READER_SURE: these bands are small and Tesseract is often a
  // little less sure even when the letters are right. Still high enough that
  // a negated photo blob rarely invents a real-looking word.
  const INVERT_MIN_CONF = 50;

  function overlapFraction(a, b) {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return 0;
    const inter = (x1 - x0) * (y1 - y0);
    return inter / Math.max(1, a.w * a.h);
  }

  // Keep an inverted-pass word only when primary OCR did not already cover
  // that ink (or the same letters). Cuts duplicate boxes and most junk from
  // negating a band that was already readable.
  function keepInverted(item, primary) {
    if (!item || !item.str || !item.str.trim()) return false;
    if (!/[A-Za-z]{2,}/.test(item.str)) return false;
    if (typeof item.confidence === 'number' && item.confidence < INVERT_MIN_CONF) {
      return false;
    }
    const said = item.str.replace(/\s+/g, ' ').trim().toLowerCase();
    for (const other of primary) {
      if (overlapFraction(item.rect, other.rect) >= 0.45) return false;
      const otherSaid = other.str.replace(/\s+/g, ' ').trim().toLowerCase();
      if (otherSaid === said && Math.abs(other.y - item.y) < Math.max(other.h, item.h) * 1.2
        && Math.abs(other.x - item.x) < Math.max(other.w, item.w) * 1.5) {
        return false;
      }
    }
    return true;
  }

  async function readWith(engineWorker, canvas) {
    // Preprocess (moire / contrast / deskew, optional downsample) then OCR
    // text-like crops instead of the whole page when that helps.
    let prepared = canvas;
    let toOrig = 1;
    let regions = null;
    let gray = null;
    if (PagePrep) {
      const prep = PagePrep.prepareOcrCanvas(canvas);
      prepared = prep.canvas;
      toOrig = prep.toOrig || 1;
      gray = PagePrep.canvasToGray(prepared);
      regions = PagePrep.textRegions(gray, prepared.width, prepared.height);
    }

    const crops = PagePrep
      ? PagePrep.ocrRegionCrops(prepared, regions)
      : [{ canvas: prepared, x: 0, y: 0, w: prepared.width, h: prepared.height }];

    const items = [];
    for (const crop of crops) {
      const { data } = await engineWorker.recognize(crop.canvas, {}, { blocks: true });
      items.push(...itemsFromData(data, crop.x, crop.y, toOrig));
    }

    // Second look: invert dark header-like bands and OCR them as dark-on-light.
    // Cost tracks band area (usually a few percent of the page), not a full
    // second pass. Map labels on light patterned fills are out of scope here.
    if (PagePrep && gray && typeof PagePrep.darkInkRegions === 'function') {
      const dark = PagePrep.darkInkRegions(gray, prepared.width, prepared.height);
      for (const band of dark) {
        // Skip bands primary OCR already covered densely.
        const covered = items.filter(it => overlapFraction(it.rect, {
          x: band.x * toOrig, y: band.y * toOrig,
          w: band.w * toOrig, h: band.h * toOrig,
        }) >= 0.3).length;
        if (covered >= 2) continue;
        const crop = PagePrep.invertRegionCrop(prepared, band);
        const { data } = await engineWorker.recognize(crop.canvas, {}, { blocks: true });
        const found = itemsFromData(data, crop.x, crop.y, toOrig);
        for (const word of found) {
          if (keepInverted(word, items)) {
            word.fromInvert = true;
            items.push(word);
          }
        }
      }
    }

    items.sort((a, b) => a.y - b.y || a.x - b.x);
    return markLineEnds(items);
  }

  // The page as text, with the words placed in it.
  //
  // lib/boxes.js has to guess where the spaces are, because pdf.js hands it
  // runs of glyphs and a gap that may or may not be a word break. OCR does not
  // need guessing: every item here is one word, so a separator goes between
  // every pair of them. Guessing instead cost real matches — footnote text set
  // small stitched as "veryyearwithKAG", and a search for the name then found
  // nothing there, because the word boundary it needs was gone.
  function stitch(items) {
    let text = '';
    const placed = [];
    for (let i = 0; i < items.length; i++) {
      if (i > 0) text += items[i - 1].hasEOL ? '\n' : ' ';
      const start = text.length;
      text += items[i].str;
      placed.push({ ...items[i], start, end: text.length });
    }
    return { text, items: placed };
  }

  // Several pages at once, one per engine, in the order they were given.
  //
  // Sequentially this was eight to ten seconds a page, which is the whole
  // reason OCR is not the default. Nothing about a page's text depends on any
  // other page, so it splits the same way the correlation search does.
  async function readPages(canvases, onProgress, shouldStop) {
    const pages = canvases.length;
    if (!pages) return [];

    const running = await engines(engineCount(pages), onProgress ? undefined : undefined);
    const out = new Array(pages);
    let next = 0;
    let done = 0;
    let stopped = false;

    await Promise.all(running.map(async worker => {
      for (;;) {
        // Asked between pages, never inside one: a half-read page is not a
        // thing the rest of the program could use, and an engine interrupted
        // mid-recognise has to be rebuilt.
        if (stopped || (shouldStop && shouldStop())) { stopped = true; return; }
        const index = next++;
        if (index >= pages) return;
        out[index] = await readWith(worker, canvases[index]);
        done++;
        if (onProgress) onProgress(done, pages);
      }
    }));
    // Pages that were not reached come back undefined rather than empty, so a
    // caller can tell "nothing on it" from "not read yet" and resume.
    return out;
  }

  async function shutDown() {
    const running = pool;
    pool = [];
    loading = null;
    await Promise.all(running.map(async worker => {
      try { await worker.terminate(); } catch { /* already gone */ }
    }));
  }

  root.BlindedOcr = {
    readPage, readPages, stitch, shutDown, wordsOf, corePath, engineCount, BASE,
    SIMD_PROBE, PROBE_CONTROL, MAX_ENGINES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
