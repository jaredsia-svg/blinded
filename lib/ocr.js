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

  const BASE = 'vendor/tesseract/';

  // The same proportions lib/boxes.js uses, so OCR words and pdf.js items
  // describe a line the same way and the existing box code fits both.
  const ASCENT = 0.82;

  let loading = null;
  let worker = null;

  // Which WebAssembly build to use.
  //
  // Left to itself the engine picks from six variants and fetches whichever it
  // likes — including relaxed-SIMD builds. Each is about four megabytes, and
  // vendoring all six to satisfy a runtime choice is silly, so the build is
  // pinned here and only the two that are pinned are shipped. The SIMD one is
  // what any browser from the last few years will take; the plain one is the
  // fallback, and the test below is the standard v128 feature probe.
  const SIMD_PROBE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
    3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 26, 11,
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

  // The engine is fetched once, on first use, and kept for the session.
  async function engine(onProgress) {
    if (worker) return worker;
    if (!loading) {
      loading = (async () => {
        if (!root.Tesseract) await loadScript(BASE + 'tesseract.min.js');
        if (!root.Tesseract) throw new Error('the OCR engine did not load');
        // The logger key is omitted rather than set to undefined: the engine
        // calls whatever is under it without checking.
        const options = {
          workerPath: BASE + 'worker.min.js',
          corePath: corePath(),
          langPath: BASE,
          gzip: true,
        };
        if (onProgress) options.logger = onProgress;
        const made = await root.Tesseract.createWorker('eng', 1, options);
        worker = made;
        return made;
      })();
      loading.catch(() => { loading = null; });
    }
    return loading;
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
    const engineWorker = await engine(onProgress);
    const { data } = await engineWorker.recognize(canvas, {}, { blocks: true });

    const items = [];
    for (const word of wordsOf(data)) {
      const text = String(word.text || '');
      if (!text.trim()) continue;
      const box = word.bbox;
      const height = Math.max(1, box.y1 - box.y0);
      items.push({
        str: text,
        x: box.x0,
        // lib/boxes.js measures a line from its baseline, upwards by ASCENT.
        // The bottom of the ink is the closest thing OCR gives to a baseline.
        y: box.y1,
        w: Math.max(1, box.x1 - box.x0),
        h: height / ASCENT,
        hasEOL: false,
        confidence: word.confidence,
        // The ink OCR actually saw, kept exactly. Slicing a fraction of a word
        // out of this would be guesswork; see matchOcr in app.js.
        rect: {
          x: box.x0, y: box.y0,
          w: Math.max(1, box.x1 - box.x0),
          h: height,
        },
      });
    }

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

  async function shutDown() {
    const running = worker;
    worker = null;
    loading = null;
    if (running) { try { await running.terminate(); } catch { /* already gone */ } }
  }

  root.BlindedOcr = { readPage, stitch, shutDown, wordsOf, corePath, BASE };
})(typeof window !== 'undefined' ? window : globalThis);
