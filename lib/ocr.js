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

  // Whether this page is allowed to compile WebAssembly at all, asked before
  // anything is fetched.
  //
  // The engine does not fail when it is refused. Its core aborts inside the
  // worker and the promise building it simply never settles, so a browser that
  // will not compile -- one too old for the 'wasm-unsafe-eval' the policy
  // grants, or one with WebAssembly switched off -- sat on "Searching text"
  // for ever, with Search and Export both greyed out and nothing saying why.
  // Measured by serving the site with WebAssembly refused.
  //
  // Throwing here instead is what lets the search do what it was built to do
  // when the reader is unavailable: fall back to looking for the word's shape,
  // and say so. PROBE_CONTROL is a module every engine validates; compiling it
  // is the same question the engine's own core would ask, answered in
  // microseconds rather than never.
  function mayCompile() {
    try { return new WebAssembly.Module(PROBE_CONTROL) instanceof WebAssembly.Module; }
    catch { return false; }
  }

  async function makeEngine(onProgress) {
    if (!mayCompile()) throw new Error('this browser will not run the page reader');
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

  // A small area read as it is: no preparation, no regions, no second
  // looks. For a strip cut round one word, which is already the region and
  // already prepared the way it is wanted, the page pipeline above is most of
  // the cost and none of the benefit.
  let cropTurn = 0;
  async function readCrop(canvas) {
    // Any engine already loaded, in turn: crops read side by side spread
    // over them rather than queueing on the first.
    const worker = pool.length > 1 ? pool[cropTurn++ % pool.length] : await engine();
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    return itemsFromData(data, 0, 0, 1);
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

  // Words in reading order: line by line, then left to right.
  //
  // A line is not one exact number. Words read in different pieces of the
  // page get baselines a few pixels apart for the same line of type, and
  // ordered by that number alone a line came apart in the middle: a first
  // name on one line and the surname on the next. So words are gathered into lines first,
  // within half a word's height of the line's first word, and each line is
  // then read left to right.
  function readingOrder(items) {
    const at = it => it.lineY ?? it.y;
    items.sort((a, b) => at(a) - at(b) || a.x - b.x);
    let anchor = null;
    for (const it of items) {
      if (!anchor || at(it) - at(anchor) > Math.max(anchor.h || 0, it.h || 0) * 0.5) anchor = it;
      it._line = at(anchor);
    }
    items.sort((a, b) => a._line - b._line || a.x - b.x);
    for (const it of items) delete it._line;
    return items;
  }

  // A scrap of a word read a second time: one or two characters, unsure,
  // lying almost wholly inside a word read surely. Measured: the last letter
  // of a surname came back again as "2" at 54, inside the surname read at 96,
  // and where the scrap sorted between the two words of a name the name no
  // longer read as one. It is not a word of its own; it is the word beside it, again.
  const GHOST_SURE = 60;
  function dropGhosts(items) {
    const letters = it => String(it.str || '').replace(/[^A-Za-z0-9]/g, '').length;
    return items.filter(it => {
      if (!it || !it.rect || letters(it) > 2) return true;
      if (typeof it.confidence !== 'number' || it.confidence >= GHOST_SURE) return true;
      return !items.some(other => other !== it && other.rect && letters(other) >= 3
        && typeof other.confidence === 'number' && other.confidence >= GHOST_SURE
        && overlapFraction(it.rect, other.rect) >= 0.6);
    });
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

  // A third look, closer, at the small words the reader was unsure of.
  //
  // Tesseract reads best with letters twenty to thirty pixels tall. A caption
  // under a photograph at 144 dpi is ten or twelve: measured on a two-page
  // deck, the names under the headshots came back as "srw" at confidence 0
  // and "nee" at 25, which no term can be matched against. The same ink
  // enlarged three times is type of the size the engine was trained on.
  //
  // Only where it was unsure, and only small type: large words that read
  // badly are artwork, which enlarging does not help. The unsure words are
  // gathered into line-sized crops, each crop read once, and the crops per
  // page are capped, so the cost is a few small reads rather than a second
  // pass over the page.
  //
  // A new reading has to earn its place. It replaces the words it lies over
  // only when it is clearly surer than every one of them, so a caption read
  // correctly at 17 (which happens; see readPage) is not traded for a guess.
  // A word where nothing was read before needs the bar the inverted pass
  // uses.
  const REREAD_BELOW = 40;
  const REREAD_MAX_H = 22;
  const REREAD_SCALE = 3;
  const REREAD_CROPS = 24;
  const REREAD_GAIN = 10;

  // The words being looked for, when the app has said (setWants). With them
  // this look does four things more, which measured apart as a pass of their
  // own found what it did not: over a title in white on a photograph the
  // reader said "BARE" at 22, over a small scanned caption "srw" at 0, and
  // cut out on their own the same places read the title and the name.
  //   - large unsure words too, not only small type, enlarged only to the
  //     height the engine reads best and never shrunk;
  //   - a crop on a dark ground read inverted, as lettering light on dark;
  //   - each crop wide enough along its line for the longest word wanted;
  //   - a typed word read exactly taken on the bar a re-read of it is held
  //     to anywhere else (by its length), rather than having to be clearly
  //     surer than the junk it lies over.
  let rereadWants = [];
  function setWants(words) {
    rereadWants = [...new Set((words || []).map(plain).filter(w => w.length >= 3))];
  }
  function plain(str) {
    return String(str || '').replace(/['\u2019]s$/i, '').toLowerCase().replace(/[^a-z0-9&]+/g, '');
  }
  function wantedSure(want) {
    const n = want.length;
    return n >= 6 ? 40 : n === 5 ? 60 : 80;
  }
  // Letters of about this height are what the engine reads best.
  const REREAD_LETTER_PX = 30;
  const REREAD_MAX_H_WANTED = 160;
  const REREAD_MORE_WANTED = 8;

  function rereadCrops(items, toOrig, width, height) {
    const maxH = rereadWants.length ? REREAD_MAX_H_WANTED : REREAD_MAX_H;
    const unsure = items.filter(it => it.rect
      && typeof it.confidence === 'number' && it.confidence < REREAD_BELOW
      && /[A-Za-z]/.test(it.str || '')
      && it.rect.h / toOrig <= maxH && it.rect.h / toOrig >= 4)
      .map(it => ({ x: it.rect.x / toOrig, y: it.rect.y / toOrig,
        w: it.rect.w / toOrig, h: it.rect.h / toOrig, n: 1, least: it.confidence }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    // Neighbours on one line become one crop: the engine reads a line far
    // better than a word cut out of it.
    const boxes = [];
    for (const b of unsure) {
      const line = boxes.find(o => {
        const mid = b.y + b.h / 2;
        const sameLine = mid > o.y && mid < o.y + o.h;
        const gap = Math.max(o.x - (b.x + b.w), b.x - (o.x + o.w));
        // Large lettering joins only lettering its own size: let in beside
        // small type it made one crop of half a slide, read at its own size,
        // and a small scanned caption in it was not enlarged at all.
        const alike = Math.max(o.h, b.h) <= REREAD_MAX_H
          || Math.max(o.h, b.h) <= Math.min(o.h, b.h) * 1.5;
        return sameLine && alike && gap < Math.max(o.h, b.h) * 3;
      });
      if (!line) { boxes.push({ ...b }); continue; }
      const x0 = Math.min(line.x, b.x);
      const y0 = Math.min(line.y, b.y);
      line.w = Math.max(line.x + line.w, b.x + b.w) - x0;
      line.h = Math.max(line.y + line.h, b.y + b.h) - y0;
      line.x = x0; line.y = y0; line.n++;
      line.least = Math.min(line.least, b.least);
    }
    const chosen = boxes.slice().sort((a, b) => b.n - a.n).slice(0, REREAD_CROPS);
    // With words wanted, a few more: the least sure left, smallest first. A
    // scanned caption's name read as "srw" at 0 made a crop of two words,
    // never among the busiest lines of a busy slide.
    if (rereadWants.length) {
      chosen.push(...boxes.filter(b => !chosen.includes(b))
        .sort((a, b) => a.least - b.least || a.w * a.h - b.w * b.h)
        .slice(0, REREAD_MORE_WANTED));
    }
    return chosen
      .map(b => {
        const longest = rereadWants.length ? Math.max(...rereadWants.map(w => w.length)) : 0;
        const padX = Math.max(b.h * 1.2, (b.h * 0.6 * longest - b.w) / 2);
        const padY = b.h * 0.6;
        const x = Math.max(0, Math.floor(b.x - padX));
        const y = Math.max(0, Math.floor(b.y - padY));
        return { x, y,
          w: Math.min(width, Math.ceil(b.x + b.w + padX)) - x,
          h: Math.min(height, Math.ceil(b.y + b.h + padY)) - y,
          // Enlarged to the engine's letter height: small type three times,
          // large type not at all.
          scale: Math.max(1, Math.min(REREAD_SCALE, REREAD_LETTER_PX / Math.max(1, b.h))) };
      })
      .filter(b => b.w > 4 && b.h > 4);
  }

  function enlarged(canvas, box) {
    const scale = box.scale || REREAD_SCALE;
    const w = Math.round(box.w * scale);
    const h = Math.round(box.h * scale);
    const c = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, w, h);
    // Light lettering on a dark ground, turned dark on light: what the
    // engine was trained on. Only while words are wanted, as the other
    // three changes are.
    if (rereadWants.length) {
      const data = ctx.getImageData(0, 0, w, h);
      const d = data.data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += Math.min(d[i], d[i + 1], d[i + 2]);
      if (sum / (d.length / 4) < 110) {
        for (let i = 0; i < d.length; i += 4) {
          d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
        }
        ctx.putImageData(data, 0, 0);
      }
    }
    return c;
  }

  // Items read off an enlarged crop, put back in the page's own pixels.
  function fromEnlarged(found, box, toOrig) {
    const scale = box.scale || REREAD_SCALE;
    const k = toOrig / scale;
    const at = (v, o) => (o + v / scale) * toOrig;
    return found.map(it => ({ ...it,
      x: at(it.x, box.x), y: at(it.y, box.y), w: it.w * k, h: it.h * k,
      rect: { x: at(it.rect.x, box.x), y: at(it.rect.y, box.y),
        w: it.rect.w * k, h: it.rect.h * k } }));
  }

  // Which of the page's words a new reading takes over, or null to keep them.
  function rereadReplaces(word, items) {
    // Two letters, not two in a row: "P&N" is a word, and a reading that
    // required letters side by side threw it away.
    if (!word || !word.rect || !/[A-Za-z].*[A-Za-z]/.test(word.str || '')) return null;
    if (typeof word.confidence !== 'number') return null;
    const under = items.filter(it => it.rect
      && (overlapFraction(word.rect, it.rect) >= 0.3 || overlapFraction(it.rect, word.rect) >= 0.3));
    const wanted = rereadWants.includes(plain(word.str))
      && word.confidence >= wantedSure(plain(word.str));
    if (!under.length) return word.confidence >= INVERT_MIN_CONF || wanted ? [] : null;
    const best = Math.max(...under.map(it => typeof it.confidence === 'number' ? it.confidence : 100));
    if (word.confidence >= best + REREAD_GAIN) return under;
    // A typed word, read exactly, over what the reader could not read.
    if (wanted && under.every(it => typeof it.confidence !== 'number' || it.confidence < REREAD_BELOW
        || plain(it.str) === plain(word.str))) return under;
    return null;
  }

  // Lines the reading does not account for.
  //
  // The reader sometimes reads a line of body text only in part: a whole line
  // dropped between two it read (twice in a row on one scanned page, both
  // holding a typed name), a line read in scattered pieces, or a word cut
  // short (the first two letters of a name, read at 96, and the rest of it nothing). Nothing after it could see those:
  // every later look starts from something the reader returned, and here it
  // returned nothing, or something sure of itself. What does show is the ink:
  // a line of lettering with no words over a long stretch of it.
  //
  // So each text area is cut into its lines by the ink across its rows, each
  // line's ink is set against the words read on it, and a line with a long
  // stretch of ink no word covers is read again on its own, enlarged. Words
  // from that read are added where nothing was read, and take the place of
  // what was read only where they account for clearly more of the ink.
  const LINE_GAP_LETTERS = 3;    // unread ink this many letter-heights long
  const LINES_PER_PAGE = 16;
  // An area cut into its blocks of text: at empty bands across it, then at
  // empty strips down each band, and again within those, a few levels deep.
  // Lines set side by side sit at different heights, and split together they
  // split neither; a heading or a rule across the full width is why the
  // bands come first.
  function blocksIn(gray, width, height, area, depth = 0) {
    const x0 = Math.max(0, Math.floor(area.x)), x1 = Math.min(width, Math.ceil(area.x + area.w));
    const y0 = Math.max(0, Math.floor(area.y)), y1 = Math.min(height, Math.ceil(area.y + area.h));
    if (x1 - x0 < 20 || y1 - y0 < 6) return [];
    const hist = new Uint32Array(32);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) hist[gray[y * width + x] >> 3]++;
    let ground = 0;
    for (let i = 1; i < 32; i++) if (hist[i] > hist[ground]) ground = i;
    const g = ground * 8 + 4;
    const rows = new Uint32Array(y1 - y0), cols = new Uint32Array(x1 - x0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (Math.abs(gray[y * width + x] - g) > 70) { rows[y - y0]++; cols[x - x0]++; }
    }
    const cut = (counts, quiet, minGap) => {
      const parts = [];
      let from = -1, gap = 0;
      for (let i = 0; i <= counts.length; i++) {
        const empty = i === counts.length || counts[i] <= quiet;
        if (!empty) { if (from < 0) from = i; gap = 0; continue; }
        gap++;
        if (from >= 0 && (gap >= minGap || i === counts.length)) { parts.push([from, i - gap + 1]); from = -1; }
      }
      return parts;
    };
    if (depth < 5) {
      const bands = cut(rows, 0, 8);
      if (bands.length > 1) {
        return bands.flatMap(([a, b]) => blocksIn(gray, width, height, { x: x0, y: y0 + a, w: x1 - x0, h: b - a }, depth + 1));
      }
      const strips = cut(cols, Math.max(0, (y1 - y0) * 0.005), 18);
      if (strips.length > 1) {
        return strips.flatMap(([a, b]) => blocksIn(gray, width, height, { x: x0 + a, y: y0, w: b - a, h: y1 - y0 }, depth + 1));
      }
    }
    return [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }];
  }

  function linesIn(gray, width, height, area) {
    const x0 = Math.max(0, Math.floor(area.x)), x1 = Math.min(width, Math.ceil(area.x + area.w));
    const y0 = Math.max(0, Math.floor(area.y)), y1 = Math.min(height, Math.ceil(area.y + area.h));
    if (x1 - x0 < 20 || y1 - y0 < 6) return [];
    // The ground: the area's commonest shade, roughly.
    const hist = new Uint32Array(32);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) hist[gray[y * width + x] >> 3]++;
    let ground = 0;
    for (let i = 1; i < 32; i++) if (hist[i] > hist[ground]) ground = i;
    const g = ground * 8 + 4;
    const ink = v => Math.abs(v - g) > 70;
    const rows = [];
    for (let y = y0; y < y1; y++) {
      let n = 0;
      for (let x = x0; x < x1; x++) if (ink(gray[y * width + x])) n++;
      rows.push(n);
    }
    // A row is between lines when it holds little ink next to the busiest
    // rows: in tightly set text the tails of one line touch the next, and no
    // row between them is ever quite empty.
    const busy = rows.slice().sort((a, b) => a - b)[Math.floor(rows.length * 0.9)] || 0;
    const low = Math.max(1, busy * 0.12);
    const lines = [];
    let start = -1;
    for (let i = 0; i <= rows.length; i++) {
      const on = i < rows.length && rows[i] > low;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        const h = i - start;
        if (h >= 6 && h <= 40) lines.push({ y: y0 + start, h });
        start = -1;
      }
    }
    // Each line's ink, column by column.
    for (const line of lines) {
      const cols = new Uint8Array(x1 - x0);
      for (let y = line.y; y < line.y + line.h; y++) {
        for (let x = x0; x < x1; x++) if (ink(gray[y * width + x])) cols[x - x0] = 1;
      }
      line.x0 = x0;
      line.cols = cols;
    }
    return lines;
  }

  async function readIncompleteLines(engineWorker, prepared, gray, regions, items, toOrig) {
    const W = prepared.width, H = prepared.height;
    // The whole page, cut into its blocks: the reader's own text areas can
    // span both columns of a slide.
    const areas = blocksIn(gray, W, H, { x: 0, y: 0, w: W, h: H });
    const lacking = [];
    for (const area of areas) {
      for (const line of linesIn(gray, W, H, area)) {
        // What the reading covers of it: words standing on this line, not
        // ones two lines tall, which cover the line without reading it.
        const covered = new Uint8Array(line.cols.length);
        for (const it of items) {
          const r = it.rect;
          if (!r || !/[A-Za-z0-9]/.test(it.str || '')) continue;
          const ry = r.y / toOrig, rh = r.h / toOrig;
          const over = Math.min(ry + rh, line.y + line.h) - Math.max(ry, line.y);
          if (over < line.h * 0.5 || rh > line.h * 1.7) continue;
          const a = Math.max(0, Math.floor(r.x / toOrig) - line.x0);
          const b = Math.min(covered.length, Math.ceil((r.x + r.w) / toOrig) - line.x0);
          for (let i = a; i < b; i++) covered[i] = 1;
        }
        // The longest stretch of ink nothing covers, gaps between letters
        // and words bridged.
        const bridge = Math.ceil(line.h * 0.8);
        let longest = 0, run = 0, quiet = 0, first = -1, last = -1;
        for (let i = 0; i < line.cols.length; i++) {
          if (line.cols[i]) { first = first < 0 ? i : first; last = i; }
          if (line.cols[i] && !covered[i]) { run += 1 + Math.min(quiet, bridge); quiet = 0; }
          else if (!line.cols[i] && run) { quiet++; if (quiet > bridge) { longest = Math.max(longest, run); run = 0; quiet = 0; } }
          else if (covered[i]) { longest = Math.max(longest, run); run = 0; quiet = 0; }
        }
        longest = Math.max(longest, run);
        if (longest >= line.h * LINE_GAP_LETTERS && first >= 0) {
          lacking.push({ line, longest, x: line.x0 + first, w: last - first + 1 });
        }
      }
    }
    if (!lacking.length) return items;
    let out = items;
    for (const one of lacking.sort((a, b) => b.longest - a.longest).slice(0, LINES_PER_PAGE)) {
      const { line } = one;
      const pad = Math.round(line.h * 0.35);
      const box = { x: Math.max(0, one.x - line.h), y: Math.max(0, line.y - pad),
        scale: Math.max(1, Math.min(REREAD_SCALE, REREAD_LETTER_PX / Math.max(1, line.h))) };
      box.w = Math.min(W, one.x + one.w + line.h) - box.x;
      box.h = Math.min(H, line.y + line.h + pad) - box.y;
      const { data } = await engineWorker.recognize(enlarged(prepared, box), {}, { blocks: true });
      const read = fromEnlarged(itemsFromData(data, 0, 0, 1), box, toOrig)
        .filter(word => word.rect && /[A-Za-z0-9]{2}/.test(word.str || '') && typeof word.confidence === 'number');
      const added = [];
      const gone = new Set();
      for (const word of read) {
        const under = out.filter(it => it.rect && !gone.has(it)
          && (overlapFraction(word.rect, it.rect) >= 0.2 || overlapFraction(it.rect, word.rect) >= 0.5));
        if (!under.length) {
          // Where nothing was read: a word, if the reader is fairly sure of it.
          if (word.confidence >= REREAD_BELOW) { word.fromLine = true; added.push(word); }
          continue;
        }
        // Over what was read: only when it accounts for clearly more of the
        // ink (the whole name over its first two letters), and is about as sure.
        const was = under.reduce((n, it) => n + it.rect.w, 0);
        const best = Math.max(...under.map(it => typeof it.confidence === 'number' ? it.confidence : 100));
        const typed = rereadWants.includes(plain(word.str)) && word.confidence >= wantedSure(plain(word.str));
        if ((word.rect.w >= was * 1.4 && word.confidence >= Math.min(best, INVERT_MIN_CONF)) || (typed && word.confidence >= best - 30)) {
          for (const it of under) gone.add(it);
          word.fromLine = true;
          if (under.length) word.lineY = Math.min(...under.map(it => it.lineY ?? it.y));
          added.push(word);
        }
      }
      if (added.length) out = out.filter(it => !gone.has(it)).concat(added);
    }
    return out;
  }

  async function rereadUnsure(engineWorker, prepared, items, toOrig) {
    const boxes = rereadCrops(items, toOrig, prepared.width, prepared.height);
    if (!boxes.length) return items;
    const gone = new Set();
    const added = [];
    for (const box of boxes) {
      const { data } = await engineWorker.recognize(enlarged(prepared, box), {}, { blocks: true });
      const found = fromEnlarged(itemsFromData(data, 0, 0, 1), box, toOrig);
      for (const word of found) {
        // Crops are padded, so neighbouring ones can read the same word twice.
        if (added.some(a => overlapFraction(word.rect, a.rect) >= 0.5)) continue;
        const over = rereadReplaces(word, items);
        if (!over) continue;
        for (const it of over) gone.add(it);
        // Read in the place of the word it replaces. Order is by baseline, and
        // a new reading's boxes are not all the same height: "Porter and
        // Nash" re-read came back with "Porter" a few pixels taller, sorted
        // after the other two, and the page's text said "and Nash Porter".
        if (over.length) word.lineY = Math.min(...over.map(it => it.lineY ?? it.y));
        word.fromReread = true;
        added.push(word);
      }
    }
    if (!added.length) return items;
    return items.filter(it => !gone.has(it)).concat(added);
  }

  // How busy a page has to be to be read a second time (see readWith): the
  // photographed slides score about a third, clean pages and scans a tenth
  // or less.
  const SECOND_LOOK_BUSY = 0.25;

  // The prepared page with its mid-tones a shade lighter.
  function lightened(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h)
      : document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { alpha: false });
    ctx.drawImage(canvas, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, 0.93));
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
    ctx.putImageData(image, 0, 0);
    return c;
  }

  async function readWith(engineWorker, canvas) {
    // Preprocess (moire / contrast / deskew, optional downsample) then OCR
    // text-like crops instead of the whole page when that helps.
    let prepared = canvas;
    let toOrig = 1;
    let regions = null;
    let gray = null;
    let busy = 0;
    if (PagePrep) {
      const prep = PagePrep.prepareOcrCanvas(canvas);
      busy = prep.busy || 0;
      prepared = prep.canvas;
      toOrig = prep.toOrig || 1;
      gray = PagePrep.canvasToGray(prepared);
      regions = PagePrep.textRegions(gray, prepared.width, prepared.height, PagePrep.READ_PAD);
    }

    const crops = PagePrep
      ? PagePrep.ocrRegionCrops(prepared, regions)
      : [{ canvas: prepared, x: 0, y: 0, w: prepared.width, h: prepared.height }];

    const items = [];
    for (const crop of crops) {
      const { data } = await engineWorker.recognize(crop.canvas, {}, { blocks: true });
      // The regions are padded, so neighbours overlap and a line near the
      // edge of two is read by both. Kept twice, the words doubled ("as as
      // local local") and the second copy's slightly different baseline split
      // the line, so a name across it no longer read as a name. The same word
      // in the same place is one word, kept at the surer reading.
      for (const word of itemsFromData(data, crop.x, crop.y, toOrig)) {
        const twin = word.rect && items.find(it => it.rect && it.str === word.str
          && (overlapFraction(word.rect, it.rect) >= 0.5 || overlapFraction(it.rect, word.rect) >= 0.5));
        if (!twin) { items.push(word); continue; }
        if ((word.confidence || 0) > (twin.confidence || 0)) items[items.indexOf(twin)] = word;
      }
    }

    // And what the regions left out, read in small pieces of its own (see
    // PagePrep.readGaps). Only when the page was read in regions at all, and
    // a word from a piece is kept only where nothing was read already.
    const inRegions = crops.length > 1 || (crops[0] && (crops[0].w < prepared.width
      || crops[0].h < prepared.height));
    if (PagePrep && gray && inRegions && typeof PagePrep.readGaps === 'function') {
      const gaps = PagePrep.readGaps(gray, prepared.width, prepared.height, PagePrep.READ_PAD);
      for (const gap of gaps) {
        const piece = PagePrep.regionCrop(prepared, gap);
        if (!piece) continue;
        const { data } = await engineWorker.recognize(piece.canvas, {}, { blocks: true });
        for (const word of itemsFromData(data, piece.x, piece.y, toOrig)) {
          if (!word.rect) continue;
          const clash = items.some(it => it.rect && (overlapFraction(word.rect, it.rect) >= 0.3
            || overlapFraction(it.rect, word.rect) >= 0.3));
          if (clash) continue;
          word.fromGap = true;
          items.push(word);
        }
      }
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

    // A second reading of a photographed page, a shade lighter, merged into
    // the first. On a photograph of a screen the reader is at the edge of
    // what it can read, and a few percent of difference in the pixels decides
    // word by word what it gets: measured on one, a photo decoded 5% more
    // contrasty lost "Middle" and "East" and read "Philippines" only on the
    // map, while decoded as-is it read both from the table. Two browsers
    // decode the same photo that differently -- the same photo read well on a
    // phone and lost those words on a laptop. Two readings a shade apart
    // disagree about different words, so between them far fewer are lost.
    if (PagePrep && busy >= SECOND_LOOK_BUSY) {
      const lighter = lightened(prepared);
      const again = [];
      for (const crop of crops) {
        const piece = crop.w >= prepared.width && crop.h >= prepared.height ? lighter
          : PagePrep.regionCrop(lighter, crop);
        if (!piece) continue;
        const { data } = await engineWorker.recognize(piece.canvas || piece, {}, { blocks: true });
        again.push(...itemsFromData(data, crop.x, crop.y, toOrig));
      }
      for (const word of again) {
        if (!word.rect || !/[A-Za-z0-9]/.test(word.str || '')) continue;
        const over = items.filter(it => it.rect && (overlapFraction(word.rect, it.rect) >= 0.3
          || overlapFraction(it.rect, word.rect) >= 0.3));
        if (!over.length) {
          word.fromSecondLook = true;
          items.push(word);
          continue;
        }
        // Where both read something, the surer reading stands, and only
        // when it is clearly surer: a tie keeps what was read first.
        const best = Math.max(...over.map(it => typeof it.confidence === 'number' ? it.confidence : 100));
        if (typeof word.confidence === 'number' && word.confidence >= best + REREAD_GAIN) {
          for (const it of over) items.splice(items.indexOf(it), 1);
          word.fromSecondLook = true;
          items.push(word);
        }
      }
    }

    const looked = PagePrep ? await rereadUnsure(engineWorker, prepared, items, toOrig) : items;
    const settled = dropGhosts(PagePrep && gray
      ? await readIncompleteLines(engineWorker, prepared, gray, regions, looked, toOrig) : looked);
    readingOrder(settled);
    return markLineEnds(settled);
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

  // The closer look again, on pages already read, for words typed since.
  //
  // A page is read once, and its closer look at its unsure words was told the
  // words typed then (setWants). A word added afterwards would never have had
  // it: a title the reader made junk of, read only by a crop of its own at the
  // bar for its length, found when typed first and missed when typed second.
  // So the same look is taken again for the new words alone, on the reading
  // the page already has, one page to each engine. Each entry comes back as
  // the page's new reading, null when nothing changed, or undefined when it
  // was not reached before a pause.
  async function lookCloser(jobs, words, onProgress, shouldStop) {
    if (!jobs.length || !PagePrep || !words.length) return [];
    const running = await engines(engineCount(jobs.length));
    const out = new Array(jobs.length);
    let next = 0;
    let done = 0;
    const was = rereadWants;
    setWants(words);
    try {
      await Promise.all(running.map(async worker => {
        for (;;) {
          if (shouldStop && shouldStop()) return;
          const index = next++;
          if (index >= jobs.length) return;
          const { canvas, items } = jobs[index];
          const prep = PagePrep.prepareOcrCanvas(canvas);
          const looked = await rereadUnsure(worker, prep.canvas, items, prep.toOrig || 1);
          if (looked === items) out[index] = null;
          else {
            const settled = dropGhosts(looked);
            readingOrder(settled);
            out[index] = markLineEnds(settled);
          }
          done++;
          if (onProgress) onProgress(done, jobs.length);
        }
      }));
    } finally {
      rereadWants = was;
    }
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
    readPage, readCrop, readPages, stitch, readingOrder, shutDown, wordsOf, corePath, engineCount, BASE,
    SIMD_PROBE, PROBE_CONTROL, MAX_ENGINES,
    rereadCrops, rereadReplaces, fromEnlarged, REREAD_SCALE, setWants, lookCloser,
  };
})(typeof window !== 'undefined' ? window : globalThis);
