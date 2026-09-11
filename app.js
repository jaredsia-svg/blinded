// Blinded's controller: file in, review, redacted file out.
//
// The review step is the product. Detection is a suggestion engine and it is
// wrong in both directions, so every proposal is visible on the document
// itself and every one of them can be turned off by clicking it. Nothing is
// covered that the reviewer has not seen.
(function () {
  'use strict';

  const Detect = window.BlindedDetect;
  const Boxes = window.BlindedBoxes;
  const PdfRead = window.BlindedPdfRead;
  const PdfWrite = window.BlindedPdfWrite;
  const Render = window.BlindedRender;
  const Labels = window.BlindedLabels;
  const TextImage = window.BlindedTextImage;
  const measure = window.BlindedMeasure.create();
  const Match = window.BlindedMatch;
  const ImageSearch = window.BlindedImageSearch;
  const Ocr = window.BlindedOcr;

  const el = id => document.getElementById(id);
  const views = { drop: el('view-drop'), review: el('view-review') };

  // A dismissed detection still has to be visible, or the reviewer cannot
  // change their mind — it becomes a dashed outline they can click again.
  const state = {
    kind: null,        // 'pdf' | 'image' | 'text'
    name: '',
    pages: [],         // { index, source, canvas, widthPt, heightPt, items, findings, hits, manual, dismissed }
    text: '',
    enabled: new Set(Detect.KINDS.map(k => k.kind).concat('term')),
    includeMedium: false,
    terms: [],
    // Logos the reviewer has picked. Each holds the greyscale patch it was cut
    // from, so its matches can be recomputed when the sensitivity moves
    // without making them draw the box again.
    templates: [],
    // 'box' draws a redaction; 'pick' cuts a logo to search for. One drag
    // gesture, two meanings, so the mode is always visible on the page itself.
    mode: 'box',
    // Placeholder labelling. Off by default: the plain black bar is still the
    // right output for most documents, and labels are a deliberate choice to
    // publish a little structure about what was removed.
    labelling: false,
    // Reviewer edits, keyed by the identity of the thing being labelled so an
    // edit survives a rescan.
    labelOverrides: {},
    labels: { byId: {}, entries: [] },
    // Marking up and redacting are two steps, not one.
    //
    // Everything used to happen the moment it was typed or drawn, which meant
    // picking a logo froze the tab for a full sweep of the document before the
    // reviewer had finished saying what else to cover — and then again for the
    // next logo. Now marks accumulate as red outlines and nothing is searched,
    // covered or committed until Redact is pressed.
    //
    // `applied` is the view: false shows what *would* be covered, true shows
    // what will be. Any change to what is covered returns it to false, because
    // a black bar that no longer reflects the current settings is exactly the
    // kind of stale reassurance this program must never give.
    applied: false,
    // Whether typed words are also looked for inside the pictures. On.
    //
    // It was off, on the reasoning that the text layer covers the ordinary
    // case. It does not, and the way it fails is the one this program exists
    // to prevent. A real slide had six visible occurrences of a name; four of
    // them were drawn as outlines rather than text, so the text layer held two
    // — and the panel reported "4", which reads like the whole answer. The
    // document came back with the name still on it four times and nothing
    // anywhere saying so.
    //
    // The cost is real and bounded: the reader is fetched once, and only when
    // Redact is actually pressed, so nobody who does not redact pays for it.
    // Under-covering silently is not bounded at all.
    termImages: true,
    // Words inside pictures are found by reading the page. Matching drawn
    // shapes is the fallback for when the reader cannot be loaded at all.
    useOcr: true,
    ocrFailed: false,
    // Whether the reader has already been fetched this session.
    ocrLoaded: false,
    // Set while a run is being stopped between pages.
    paused: false,
    // Per page: the words OCR read, and the text they stitch into.
    ocrRead: false,
    // Terms whose picture search has already run, so pressing Redact twice
    // does not repeat it.
    searchedTerms: [],
  };
  let nextTemplateId = 1;
  let nextManualId = 1;

  // ---------- chrome ----------

  // ---------- the working overlay ----------
  //
  // Three things a reviewer wants while a hundred pages are read: what is
  // happening, how far along it is, and a way to stop and look. The message
  // used to carry all of the first and none of the rest — "Searching for 1
  // word — page 30 of 100" spends most of its width restating a setting the
  // reviewer chose a moment ago.
  function busy(on, message, done, total) {
    el('busy').hidden = !on;
    if (message !== undefined && message !== null) el('busy-text').textContent = message;

    const bar = el('busy-bar');
    const known = Number.isFinite(done) && Number.isFinite(total) && total > 0;
    bar.hidden = !known;
    if (known) {
      const fraction = Math.max(0, Math.min(1, done / total));
      el('busy-fill').style.width = (fraction * 100).toFixed(1) + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    }
    if (!on) {
      el('busy-pause').hidden = true;
      el('busy-fill').style.width = '0%';
    }
  }

  // Pausing.
  //
  // A hundred pages is long enough that a reviewer will want to see what has
  // been found so far before it finishes — and, having seen it, may want to
  // change the terms rather than wait for a run that is looking for the wrong
  // thing. Stopping is cooperative and happens between pages: the work already
  // done is kept, and pressing Redact again carries on from there.
  function allowPause() {
    const button = el('busy-pause');
    button.hidden = false;
    button.disabled = false;
    button.textContent = 'Pause';
  }

  function requestPause() {
    state.paused = true;
    const button = el('busy-pause');
    button.disabled = true;
    button.textContent = 'Finishing this page…';
  }

  // How a long run reports itself: the page it is on, and nothing else.
  function pageProgress(done, total) {
    busy(true, 'Page ' + Math.min(done + 1, total) + ' of ' + total, done, total);
  }

  function show(name) {
    for (const key of Object.keys(views)) views[key].hidden = key !== name;
  }

  function fail(message) {
    const box = el('drop-error');
    box.textContent = message;
    box.hidden = false;
  }

  // ---------- undo ----------
  //
  // Every change a reviewer makes by hand is recorded with the operation that
  // puts it back. Redaction is fiddly work — a box drawn slightly wrong, a
  // detection dismissed by a misjudged click, a logo picked from the wrong
  // mark — and without this the only way back was to start the document over
  // and redo every decision.
  //
  // Undo covers what the reviewer did, not what the detectors found: rescans
  // are derived state and rebuild themselves from the settings.
  const undoStack = [];
  const UNDO_LIMIT = 100;

  function pushUndo(label, undo) {
    undoStack.push({ label, undo });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    refreshUndo();
  }

  function refreshUndo() {
    const button = el('undo');
    const last = undoStack[undoStack.length - 1];
    button.disabled = !last;
    button.title = last ? 'Undo ' + last.label : 'Nothing to undo';
  }

  function undoLast() {
    const action = undoStack.pop();
    if (!action) return;
    action.undo();
    markPending();
    for (const page of state.pages) if (page.canvas) drawPage(page);
    if (state.kind === 'text') drawTextView();
    renderTemplates();
    renderCounts();
    refreshUndo();
  }

  // ---------- loading ----------

  const TEXT_EXT = /\.(txt|md|markdown|csv|log|json|xml|yml|yaml)$/i;

  async function loadFile(file) {
    el('drop-error').hidden = true;
    if (!file) return;

    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        busy(true, 'Reading the PDF…');
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Every pass over the pages reports the same way: which page, and a
        // bar. Three different sentences for three loops that all mean "this
        // is taking a while" is three things to read instead of one.
        const pages = await PdfRead.load(bytes, (n, total) => pageProgress(n - 1, total));
        startReview('pdf', file.name, pages);
      } else if (/^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
        busy(true, 'Reading the image…');
        startReview('image', file.name, [await loadImage(file)]);
      } else if (/^text\//.test(file.type) || TEXT_EXT.test(file.name)) {
        busy(true, 'Reading the file…');
        state.text = await file.text();
        startReview('text', file.name, []);
      } else {
        fail('Blinded can open PDFs, PNG and JPEG images, and plain text files. That looked like none of those.');
      }
    } catch (error) {
      // A failure here means the document was not fully understood, and a
      // partial review is worse than none: it looks complete.
      fail('That file could not be opened: ' + (error && error.message ? error.message : String(error)) +
        '. Nothing was redacted. If the PDF is password-protected, remove the password first.');
      show('drop');
    } finally {
      busy(false);
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        // An image has no text layer, so there is nothing to detect and
        // everything is covered by hand.
        resolve({ index: 0, canvas, widthPt: img.naturalWidth, heightPt: img.naturalHeight, text: '', items: [] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('the image could not be decoded')); };
      img.src = url;
    });
  }

  function startReview(kind, name, pages) {
    state.kind = kind;
    state.name = name;
    // What was read belonged to the last document. Left standing, this one is
    // never read at all: the work looks done, nothing runs, and the document
    // comes back with the words still on it. Reset here rather than where the
    // old document is closed, because every way into a new one passes through
    // this function and only some of them pass through that.
    state.ocrRead = false;
    state.ocrFailed = false;
    state.useOcr = true;
    state.pages = pages.map(p => ({
      ...p,
      source: p.canvas,          // pristine; never drawn on
      canvas: null,              // the on-screen copy, created below
      findings: [],
      hits: [],
      imageHits: [],
      manual: [],
      dismissed: new Set(),
    }));

    el('doc-name').textContent = name;
    el('doc-name').title = name;
    el('textview').hidden = kind !== 'text';
    el('pages').hidden = kind === 'text';
    el('lossless').closest('.exportopts').hidden = kind === 'text';

    state.applied = false;
    if (kind !== 'text') buildPageElements();
    show('review');
    rescan();
    refreshApply();
  }

  // ---------- detection ----------

  function acceptedKinds() {
    return Array.from(state.enabled).filter(k => k !== 'term');
  }

  function scanText(text) {
    const found = Detect.findAll(text, { kinds: acceptedKinds(), terms: state.terms });
    return found.filter(f => f.confidence === 'high' || state.includeMedium);
  }

  // Recomputes everything downstream of the settings. Cheap enough to run on
  // every keystroke for documents of a sane size, and being always-consistent
  // is worth more than being clever about it.
  function rescan() {
    if (state.kind === 'text') {
      state.findings = scanText(state.text);
      drawTextView();
    } else {
      for (const page of state.pages) {
        page.findings = scanText(page.text);
        page.dismissed = new Set(Array.from(page.dismissed));
        page.hits = page.findings.map(f => ({
          finding: f,
          rects: Boxes.boxesForSpans(page.items, [f], { advance: measure }),
        }));
        drawPage(page);
      }
    }
    markDuplicates();
    renderKinds();
    renderTermCounts();
    renderSectionNotes();
    applyLabels();
    renderCounts();
    // A rescan only ever happens because the reviewer changed what should be
    // covered — a term, a detector, the confidence setting — so the document
    // goes back into review along with it.
    markPending();
  }

  // ---------- marking up, then redacting ----------

  // Anything that changes what would be covered puts the document back into
  // review. Appearance-only settings — how a placeholder is spelled, whether a
  // legend page is appended — deliberately do not, since they cannot make the
  // bars on screen wrong.
  function markPending() {
    if (!state.applied) { refreshApply(); return; }
    state.applied = false;
    redrawAll();
    refreshApply();
  }

  // Whether a document still needs reading before its terms can be found.
  // The sensitivity slider belongs to the shape matcher, so it is shown only
  // when the shape matcher is what is running.
  function showWordControls() {
    const note = el('ocrnote');
    note.hidden = !(state.termImages && state.ocrFailed);
    if (!note.hidden) {
      note.textContent = 'The page reader could not be loaded, so these words '
        + 'are being hunted for by shape instead. That is less reliable on '
        + 'italic and on small lettering — check the marks before exporting.';
    }
  }

  // Whether what was matched still answers the terms as they stand now.
  //
  // Reading a page and matching terms against what was read are different
  // jobs with different costs, and only one of them depends on the settings.
  // The words on a page do not change when a term is added, so reading is not
  // redone; the matching is, every time, because it is milliseconds and being
  // wrong about it means a term the reviewer typed is never looked for.
  //
  // This used to ask only whether anything had been matched at all. Adding a
  // second term after a redaction therefore matched nothing: something had
  // been searched, so nothing was pending, and the new term was silently
  // never looked for in the pictures.
  function ocrMatchStale() {
    const want = state.terms;
    const have = state.searchedTerms;
    return want.length !== have.length || want.some(term => !have.includes(term));
  }

  function ocrPending() {
    return Boolean(state.useOcr && state.termImages && state.kind !== 'text'
      && state.terms.length && (!state.ocrRead || ocrMatchStale()));
  }

  function refreshApply() {
    const button = el('apply');
    const marks = plannedCount();
    const unsearched = state.templates.filter(t => !t.searched).length
      + termsNeedingPictures().length
      // Reading the pages is work that has not happened yet either, and
      // without this the button stays dead: OCR has found nothing, so nothing
      // is pending, so there is nothing to press.
      + (ocrPending() ? 1 : 0);

    button.disabled = marks === 0 && unsearched === 0;
    button.textContent = state.applied ? 'Redacted' : 'Redact';
    button.classList.toggle('done', state.applied);

    el('export').disabled = !state.applied || marks === 0;

    const note = el('exportnote');
    const unread = state.pages.filter(page => !page.ocrItems).length;
    if (state.applied) {
      note.textContent = marks === 0 ? 'Nothing is covered.' : '';
    } else if (unread && unread < state.pages.length && ocrPending()) {
      // A paused run. Say how much of the document has actually been looked
      // at, because the marks on screen are the answer for part of it only.
      note.textContent = (state.pages.length - unread) + ' of ' + state.pages.length
        + ' pages read \u2014 press Redact to carry on.';
    } else if (unsearched) {
      note.textContent = unsearched === 1
        ? '1 search still to run.'
        : unsearched + ' searches still to run.';
    } else if (marks === 0) {
      note.textContent = 'Nothing marked yet.';
    } else {
      note.textContent = 'Outlined in red — press Redact to cover them.';
    }
  }

  // How many things are currently marked, whether or not they have been
  // applied. Image matches only exist once their search has run.
  function plannedCount() {
    if (state.kind === 'text') {
      return state.findings.filter(f => !dismissedText.has(f.id)).length;
    }
    return state.pages.reduce((sum, page) =>
      sum + page.hits.filter(h => !page.dismissed.has(h.finding.id)).length
        + liveImageHits(page).filter(m => !page.dismissed.has(m.id)).length
        + page.manual.length, 0);
  }

  // Runs every search that has not run yet, then switches the view to what the
  // exported file will contain.
  async function applyRedaction() {
    state.paused = false;

    // One bar across both passes.
    //
    // Reading the pages and searching them for a picked image are separate
    // jobs — one reads letters, the other correlates pixels, and neither can
    // use the other's answer — but they are two passes over the same
    // document, one after the other. A reviewer watching a bar does not care
    // which is running; two bars filling in sequence just looks like the first
    // one lied. So the work is counted once, here, in pages: those left to
    // read, plus those to search if anything is going to be searched.
    const pages = state.pages.length;
    const willRead = ocrPending() ? state.pages.filter(p => !p.ocrItems).length : 0;
    const willSearch = pendingTemplates().length ? pages : 0;
    const totalUnits = willRead + willSearch;
    let unitsDone = 0;
    const overall = (done, of) => {
      // `of` is the leg's own total; the bar is the whole job.
      const legDone = Math.min(done, of);
      pageProgress(unitsDone + legDone, totalUnits || of);
    };
    // Reading the pages comes first, because failing at it changes what else
    // has to run: the shape matcher is the fallback, so the list of templates
    // cannot be decided until it is known whether the reader worked.
    if (ocrPending()) {
      try {
        await readPages(overall);
        unitsDone += willRead;
        matchOcr();
        markDuplicates();
        renderTermCounts();
        renderSectionNotes();
        renderCounts();
      } catch (error) {
        // Not an error to report and stop on. The reader is an optimisation
        // over hunting for the word's shape, and the shape search still works,
        // so fall back to it and say so rather than leaving the reviewer with
        // an alert and no marks.
        state.ocrFailed = true;
        state.useOcr = false;
        showWordControls();
        console.warn('the page reader could not be loaded', error);
      } finally {
        busy(false);
      }
    }

    // A paused run stops here rather than going on to the image search, and
    // does not claim the document is redacted: the marks found so far are
    // shown, still red, and Redact picks up where it left off.
    if (state.paused) {
      state.paused = false;
      busy(false);
      redrawAll();
      refreshApply();
      return;
    }

    const entries = pendingTemplates();
    try {
      if (entries.length) await runSearches(entries, overall);
    } catch (error) {
      alert('The image search could not finish: ' + (error && error.message ? error.message : error));
      return;
    }
    state.applied = true;
    applyLabels();
    redrawAll();
    refreshApply();
  }

  // ---------- searching for every image at once ----------

  // Which terms still need a visual sweep. Recorded by the exact text searched
  // so that editing the list only costs a search for what actually changed.
  function termsNeedingPictures() {
    if (!state.termImages || state.kind === 'text') return [];
    // With OCR on, the same job is done by reading the page, and running both
    // would propose every word twice.
    if (state.useOcr) return [];
    return state.terms.filter(term => !state.searchedTerms.includes(term));
  }

  function clearTermImages() {
    state.searchedTerms = [];
    for (const page of state.pages) {
      page.imageHits = page.imageHits.filter(m => !m.term);
    }
  }

  // ---------- reading the pages ----------
  //
  // OCR runs once per document and is kept: the words on a page do not change
  // when the reviewer edits the terms list, so re-reading would be pure cost.
  // Matching those words against the terms is cheap and rerun freely.
  async function readPages(report) {
    const progress = report || pageProgress;
    if (state.ocrRead || !state.pages.length) return;
    const total = state.pages.length;
    // Pages already read in an earlier, paused run are not read again.
    // Pages that cannot hide lettering are not read at all. A page with no
    // images and no filled paths has nowhere to put a word the text layer
    // does not already report, so reading it can only find what is already
    // known. On a slide deck this skips nothing — every page has both — but a
    // contract or a report is skipped entirely.
    for (const page of state.pages) {
      if (!page.ocrItems && page.couldHideText === false) {
        page.ocrItems = [];
        page.ocrText = '';
        page.ocrPlaced = [];
        page.ocrSkipped = true;
      }
    }
    const outstanding = state.pages.filter(page => !page.ocrItems);
    if (!outstanding.length) { state.ocrRead = true; return; }
    // The reader is about seven megabytes and is fetched the first time it is
    // wanted. Without saying so, the first page looks like a hang.
    const alreadyDone = total - outstanding.length;
    if (!state.ocrLoaded) busy(true, 'Fetching the page reader — about 7 MB, once…');
    else progress(0, outstanding.length);
    allowPause();

    const read = await Ocr.readPages(
      outstanding.map(page => page.source),
      done => progress(done, outstanding.length),
      () => state.paused);

    outstanding.forEach((page, i) => {
      if (!read[i]) return;                 // not reached before the pause
      page.ocrItems = read[i];
      const stitched = Ocr.stitch(page.ocrItems);
      page.ocrText = stitched.text;
      page.ocrPlaced = stitched.items;
    });
    state.ocrLoaded = true;
    state.ocrRead = state.pages.every(page => page.ocrItems);
  }

  // Terms found in what OCR read, as the same kind of proposal the picture
  // search produces — keyed to the word, so a placeholder is shared with the
  // written occurrences and duplicates are folded together.
  function matchOcr() {
    for (const page of state.pages) {
      page.imageHits = page.imageHits.filter(m => !m.term);
      if (!page.ocrText) continue;
      const spans = Detect.resolveOverlaps(Detect.findTerms(page.ocrText, state.terms));
      for (const span of spans) {
        // Every word the match touches is covered whole.
        //
        // Slicing part of a word out would mean knowing where its letters sit
        // inside it, and OCR reports one box for the word, not one per glyph.
        // Dividing that box evenly is what a fallback would do, and it is
        // wrong in exactly the direction that matters: "KAG" inside the word
        // "KAG's" came out three fifths of the way across, and the bar landed
        // over "KA" with the G still legible. Covering the apostrophe-s too is
        // the harmless error; leaving a letter showing is not.
        for (const item of page.ocrPlaced) {
          if (item.start >= span.end || item.end <= span.start) continue;
          page.imageHits.push({
            id: 'ocr:' + span.term + ':' + page.index + ':'
              + Math.round(item.rect.x) + ':' + Math.round(item.rect.y),
            term: span.term,
            rect: { ...item.rect },
            score: 1,
            read: true,
          });
        }
      }
    }
    state.searchedTerms = state.terms.slice();
  }

  // Everything that needs looking for, as one list.
  //
  // A typed word contributes one entry per typeface it is drawn in, and a
  // picked logo contributes one. They are all just templates by this point,
  // which is what lets a single pass over the document cover the lot.
  function pendingTemplates() {
    const entries = [];

    for (const template of state.templates) {
      if (template.searched) continue;
      entries.push({ key: 'logo:' + template.id, template: template.cut, logo: template });
    }

    for (const term of termsNeedingPictures()) {
      TextImage.templatesFor(term).forEach((template, i) => {
        entries.push({
          key: 'term:' + term + ':' + i, template, term,
          threshold: wordBarFor(term),
          // Typed words are usually looked for in body text and captions,
          // which is exactly where they are too small to match at the page's
          // own resolution. A cut-out logo is not swept this way: it is
          // already whatever size it is on the page.
          smallText: true,
        });
      });
    }
    return entries;
  }

  // Runs every outstanding search in one sweep of the document.
  // `report` is how this leg tells the overlay where it has got to. Searching
  // for a picked image and reading the pages are two passes over the same
  // document, and a reviewer watching a bar does not care which one is
  // running — so the caller owns the counting and this reports into it.
  async function runSearches(entries, report) {
    const progress = report || pageProgress;
    progress(0, state.pages.length);
    allowPause();
    let results;
    try {
      results = await ImageSearch.searchAllParallel(state.pages, entries,
        { threshold: sensitivity() },
        (done, total) => progress(done, total));
    } finally {
      busy(false);
    }

    // Logos: one entry each, so the results land directly.
    for (const entry of entries.filter(e => e.logo)) {
      const found = results.get(entry.key);
      distribute(found.matches, hit => ({
        id: entry.logo.id + ':' + hit.pageIndex + ':' + Math.round(hit.x) + ':' + Math.round(hit.y),
        templateId: entry.logo.id,
        rect: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
        score: hit.score,
        inverted: Boolean(hit.inverted),
      }));
      entry.logo.matches = found.matches.length;
      entry.logo.rawMatches = found.matches.length;
      entry.logo.best = found.best;
      entry.logo.searched = true;
      reportSearch(found);
    }

    // Words: several typefaces per word, pooled and then de-duplicated. One
    // word found by two faces in the same place is one find, and which face
    // happened to correlate is an implementation detail a reviewer should
    // never be asked to reason about.
    for (const term of new Set(entries.filter(e => e.term).map(e => e.term))) {
      const pooled = [];
      let best = 0;
      for (const entry of entries.filter(e => e.term === term)) {
        const found = results.get(entry.key);
        if (found.best > best) best = found.best;
        for (const hit of found.matches) pooled.push(hit);
      }

      const perPage = new Map();
      for (const hit of pooled) {
        if (!perPage.has(hit.pageIndex)) perPage.set(hit.pageIndex, []);
        perPage.get(hit.pageIndex).push(hit);
      }
      for (const [pageIndex, hits] of perPage) {
        const page = state.pages[pageIndex];
        if (!page) continue;
        for (const hit of Match.suppress(hits, 0.3)) {
          page.imageHits.push({
            id: 'term:' + term + ':' + pageIndex + ':' + Math.round(hit.x) + ':' + Math.round(hit.y),
            // No templateId: this belongs to the typed word, and labelling
            // keys it to the word so a picture of a name shares the
            // placeholder its written occurrences get.
            term,
            rect: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
            score: hit.score,
            inverted: Boolean(hit.inverted),
          });
        }
      }
      state.searchedTerms.push(term);
      // Deliberately not reported into the Images section. That hint sits
      // under "Select an image to redact", and a line about a typed word
      // appearing there reads as being about an image the reviewer never
      // picked — "Found 2 times" under a button they have not pressed. The
      // term list in the Text section already says what each word found, and
      // the advice this used to give ("lower the sensitivity") pointed at a
      // control that no longer exists.
    }

    markDuplicates();
    renderTemplates();
    renderTermCounts();
    renderSectionNotes();
    renderCounts();
  }

  function distribute(matches, make) {
    for (const hit of matches) {
      const page = state.pages[hit.pageIndex];
      if (page) page.imageHits.push(make(hit));
    }
  }

  // What a picked image found, under the button that picked it.
  //
  // "0 found" on its own reads as a broken feature. Saying what the best score
  // actually was turns it into a decision the reviewer can act on — and the
  // sensitivity named here is the one control that still governs this search.
  function reportSearch(found) {
    const hint = el('pickhint');
    if (found.matches.length) {
      hint.textContent = found.matches.length === 1
        ? 'Found once. Every copy is proposed, never applied on its own.'
        : 'Found ' + found.matches.length + ' times. Every copy is proposed, '
          + 'never applied on its own.';
      hint.hidden = false;
      hint.classList.remove('warnhint');
      return;
    }
    const near = found.best > 0 ? found.best.toFixed(2) : null;
    hint.textContent = near
      ? 'No match at ' + sensitivity().toFixed(2) + '. The closest thing scored '
        + near + ' — lower the sensitivity below that to include it.'
      : 'Nothing resembling that was found anywhere in the document.';
    hint.hidden = false;
    hint.classList.add('warnhint');
  }

  // ---------- what a collapsed section is holding ----------
  //
  // Sections can be shut, so each one has to say enough on its own line to be
  // worth not opening. Without this, collapsing the panel just hides the state
  // rather than tidying it.
  function renderSectionNotes() {
    const set = (id, text, active) => {
      const note = el(id);
      note.textContent = text || '';
      note.classList.toggle('on', Boolean(active));
    };

    const terms = state.terms.length;
    set('term-note', terms ? terms + (terms === 1 ? ' word' : ' words') : '', terms > 0);

    const logos = state.templates.length;
    set('image-note', logos ? logos + (logos === 1 ? ' image' : ' images') : '', logos > 0);

    const kinds = Detect.KINDS.filter(k => state.enabled.has(k.kind)).length;
    set('kind-note', kinds + ' of ' + Detect.KINDS.length
      + (state.includeMedium ? ' · low-confidence' : ''), false);

    set('label-note', state.labelling
      ? (state.labels.entries.length || 0) + ' labels'
      : 'off', state.labelling);
  }

  // ---------- one occurrence, one mark ----------

  // How much two marks must overlap to be treated as the same find. The pair
  // that prompted this had one box entirely inside the other, so anything
  // above a half is comfortably clear of a genuine near-miss.
  const SAME_MARK = 0.5;

  // A word that is real text *and* recognisable by its shape gets found twice:
  // once from the text layer, once by the picture search. Two boxes appear,
  // slightly different sizes and slightly offset, over one word — which looks
  // like a bug because it is one. It also double-counts in the panel and, with
  // labelling on, tries to write two placeholders into the same space.
  //
  // The text-layer box wins. It comes from glyph positions rather than from
  // correlating a rendering, so it is the more precise of the two.
  //
  // Marked rather than deleted, and recomputed whenever the findings change,
  // so that removing the term brings the picture match back rather than
  // leaving a hole where a mark used to be.
  function markDuplicates() {
    for (const page of state.pages) {
      const textRects = [];
      // Dismissed findings count here too. A reviewer who clicked a mark off
      // decided that occurrence should stay; a duplicate quietly covering it
      // anyway would overrule them.
      for (const hit of page.hits) for (const rect of hit.rects) textRects.push(rect);

      const kept = [];
      for (const match of page.imageHits) {
        const overText = textRects.some(rect => Match.overlapFraction(match.rect, rect) > SAME_MARK);
        const overImage = kept.some(other => Match.overlapFraction(match.rect, other.rect) > SAME_MARK);
        match.superseded = overText || overImage;
        if (!match.superseded) kept.push(match);
      }
    }
  }

  // The image matches that actually count: everything not already covered by
  // something else.
  function liveImageHits(page) {
    return page.imageHits.filter(m => !m.superseded);
  }

  // ---------- placeholder labels ----------

  // Everything that will be covered, in the order a reader meets it. Order is
  // what decides the numbering, so it has to be reading order — page by page,
  // and within a page by position in the text — rather than whatever order the
  // detectors happened to run in.
  function labelItems() {
    if (state.kind === 'text') {
      return state.findings
        .filter(f => !dismissedText.has(f.id))
        .map(f => ({ id: f.id, kind: f.kind, text: f.text, term: f.term }));
    }

    const items = [];
    for (const page of state.pages) {
      for (const hit of page.hits) {
        if (page.dismissed.has(hit.finding.id)) continue;
        items.push({
          id: hit.finding.id,
          kind: hit.finding.kind,
          text: hit.finding.text,
          term: hit.finding.term,
        });
      }
      for (const match of liveImageHits(page)) {
        if (page.dismissed.has(match.id)) continue;
        // A picture of a typed word is that word, so it is labelled as one and
        // shares a placeholder with every written occurrence of it. Anything
        // else is a picked logo.
        if (match.term) items.push({ id: match.id, kind: 'term', term: match.term, text: match.term });
        else items.push({ id: match.id, kind: 'image', templateId: match.templateId });
      }
      for (const box of page.manual) {
        items.push({ id: box.id, kind: 'manual' });
      }
    }
    return items;
  }

  function applyLabels() {
    state.labels = Labels.assign(labelItems(), state.labelOverrides);
    renderLegend();
    renderSectionNotes();
  }

  function renderLegend() {
    const host = el('legend');
    const empty = el('legend-empty');
    host.textContent = '';

    const entries = state.labels.entries;
    empty.hidden = entries.length > 0;
    if (!entries.length) return;

    for (const entry of entries) {
      const row = document.createElement('li');

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'labelinput';
      input.value = entry.label;
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Placeholder for ' + entry.description);
      if (entry.edited) input.classList.add('edited');
      input.addEventListener('change', () => {
        const cleaned = Labels.normalise(input.value);
        // An empty or unusable edit falls back to the suggestion rather than
        // writing "[]" into the document.
        if (!cleaned || cleaned === entry.suggested) delete state.labelOverrides[entry.identity];
        else state.labelOverrides[entry.identity] = cleaned;
        applyLabels();
        redrawAll();
      });

      const what = document.createElement('span');
      what.className = 'what';
      // The original value is shown here and only here: the reviewer is
      // looking at their own document, so nothing is revealed that they do not
      // already have. It never travels into the export.
      what.textContent = entry.value ? entry.value : entry.description;
      what.title = entry.description + (entry.value ? ' — "' + entry.value + '"' : '');

      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = String(entry.count);

      row.append(input, what, count);
      host.append(row);
    }
  }

  function redrawAll() {
    for (const page of state.pages) if (page.canvas) drawPage(page);
    if (state.kind === 'text') drawTextView();
    renderCounts();
  }

  // ---------- sidebar ----------

  function allFindings() {
    return state.kind === 'text' ? state.findings : state.pages.flatMap(p => p.findings);
  }

  // Counts are taken with the kind filter lifted, so a group that is switched
  // off still shows how much it would catch. A zero next to "Payment cards"
  // means something different from a blank, and the reviewer needs to be able
  // to tell those apart.
  function countsByKind() {
    const texts = state.kind === 'text' ? [state.text] : state.pages.map(p => p.text);
    const tally = {};
    for (const text of texts) {
      const all = Detect.findAll(text, { terms: state.terms });
      for (const f of all) {
        if (f.confidence === 'medium' && !state.includeMedium) continue;
        tally[f.kind] = (tally[f.kind] || 0) + 1;
      }
    }
    return tally;
  }

  function renderKinds() {
    const tally = countsByKind();
    const rows = Detect.KINDS.concat([{ kind: 'term', label: 'Terms you listed', hint: 'Literal matches on what you typed above.' }]);
    const host = el('kinds');
    host.textContent = '';

    for (const row of rows) {
      const n = tally[row.kind] || 0;
      const label = document.createElement('label');
      label.className = 'kind' + (n === 0 ? ' empty' : '');
      label.title = row.hint;

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.enabled.has(row.kind);
      box.disabled = n === 0;
      box.dataset.kind = row.kind;
      box.addEventListener('change', () => {
        if (box.checked) state.enabled.add(row.kind);
        else state.enabled.delete(row.kind);
        rescan();
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.label;

      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = String(n);

      label.append(box, name, count);
      host.append(label);
    }
  }

  function renderCounts() {
    const covered = state.kind === 'text'
      ? state.findings.filter(f => !dismissedText.has(f.id)).length
      : state.pages.reduce((sum, p) => sum + p.hits.filter(h => !p.dismissed.has(h.finding.id)).length, 0);
    const manual = state.pages.reduce((sum, p) => sum + p.manual.length, 0);
    const images = state.pages.reduce(
      (sum, p) => sum + liveImageHits(p).filter(m => !p.dismissed.has(m.id)).length, 0);
    const skipped = state.kind === 'text'
      ? dismissedText.size
      : state.pages.reduce((sum, p) => sum + p.dismissed.size, 0);

    const parts = ['<strong>' + covered + '</strong> text match' + (covered === 1 ? '' : 'es') + ' will be covered'];
    if (images) parts.push('<strong>' + images + '</strong> image match' + (images === 1 ? '' : 'es'));
    if (manual) parts.push('<strong>' + manual + '</strong> box' + (manual === 1 ? '' : 'es') + ' you drew');
    if (skipped) parts.push('<strong>' + skipped + '</strong> you turned off');
    el('counts').innerHTML = parts.join('<br>');

    // Whether Export is available is decided by refreshApply, since it depends
    // on the phase rather than only on the count.
  }

  // ---------- page rendering ----------

  function buildPageElements() {
    const host = el('pages');
    host.textContent = '';

    for (const page of state.pages) {
      const wrap = document.createElement('div');
      wrap.className = 'page';

      const canvas = document.createElement('canvas');
      canvas.width = page.source.width;
      canvas.height = page.source.height;
      page.canvas = canvas;

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = 'Page ' + (page.index + 1);

      wrap.append(canvas, num);
      host.append(wrap);
      attachDrawing(page, canvas);
    }
  }

  function activeBoxes(page) {
    const live = page.hits.filter(h => !page.dismissed.has(h.finding.id));
    const images = liveImageHits(page).filter(m => !page.dismissed.has(m.id));

    if (!state.labelling) {
      // Merged across findings, which closes the gaps between adjacent bars.
      return Boxes.boxesForSpans(page.items, live.map(h => h.finding), { advance: measure })
        .concat(images.map(m => m.rect))
        .concat(page.manual);
    }

    // Labelling keeps each finding's bars separate. Two findings merged into
    // one bar could only carry one of their two labels, and a bar labelled
    // [EMAIL_1] that also covers a phone number is worse than a small gap.
    const boxes = [];
    for (const hit of live) {
      const label = state.labels.byId[hit.finding.id];
      // A span broken across two lines gets its label on the longer piece;
      // repeating it on both would read as two separate redactions.
      let widest = 0;
      hit.rects.forEach((r, i) => { if (r.w > hit.rects[widest].w) widest = i; });
      hit.rects.forEach((r, i) => boxes.push({ ...r, label: i === widest ? label : undefined }));
    }
    for (const match of images) {
      boxes.push({ ...match.rect, label: state.labels.byId[match.id] });
    }
    for (const box of page.manual) {
      boxes.push({ ...box, label: state.labels.byId[box.id] });
    }
    return boxes;
  }

  function drawPage(page, preview) {
    const ctx = page.canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, page.canvas.width, page.canvas.height);
    ctx.drawImage(page.source, 0, 0);

    const boxes = activeBoxes(page);

    if (state.applied) {
      // Solid black, exactly as it will be burned in — the preview must not be
      // more reassuring than the output.
      ctx.fillStyle = '#000';
      for (const box of boxes) ctx.fillRect(box.x, box.y, box.w, box.h);

      // Placeholders on top, through the same function the export uses, so
      // what is on screen is what ends up in the file — including a label that
      // turns out not to fit, which the reviewer needs to see here rather than
      // discover in the finished document.
      for (const box of boxes) {
        if (box.label) Render.drawLabel(ctx, box, box.label);
      }
    } else {
      // Not yet applied: outline what would be covered, and leave it readable.
      // Being able to read what is about to disappear is the whole point of
      // reviewing, and a filled bar removes that before the decision is made.
      ctx.save();
      ctx.strokeStyle = '#d92d20';
      ctx.fillStyle = 'rgba(217, 45, 32, 0.13)';
      ctx.lineWidth = Math.max(2, page.canvas.width / 600);
      for (const box of boxes) {
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
      }
      ctx.restore();
    }

    // Dismissed detections: dashed, so a mistaken dismissal is obvious and
    // can be clicked back on.
    const off = page.hits.filter(h => page.dismissed.has(h.finding.id));
    const offImages = liveImageHits(page).filter(m => page.dismissed.has(m.id));
    if (off.length || offImages.length) {
      ctx.save();
      ctx.strokeStyle = '#d98b1f';
      ctx.lineWidth = Math.max(1.5, page.canvas.width / 700);
      ctx.setLineDash([6, 5]);
      for (const hit of off) for (const r of hit.rects) ctx.strokeRect(r.x, r.y, r.w, r.h);
      for (const m of offImages) ctx.strokeRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
      ctx.restore();
    }

    if (preview) {
      ctx.save();
      ctx.strokeStyle = '#d92d20';
      ctx.fillStyle = 'rgba(217, 45, 32, 0.2)';
      ctx.lineWidth = Math.max(2, page.canvas.width / 600);
      ctx.fillRect(preview.x, preview.y, preview.w, preview.h);
      ctx.strokeRect(preview.x, preview.y, preview.w, preview.h);
      ctx.restore();
    }
  }

  // ---------- drawing and clicking on a page ----------

  function attachDrawing(page, canvas) {
    let start = null;

    // Screen pixels and canvas pixels differ whenever the page is scaled to
    // fit, so every pointer position is converted before it is used.
    const at = event => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    canvas.addEventListener('pointerdown', event => {
      start = at(event);
      // Capture keeps a drag alive if the pointer leaves the canvas, but it
      // throws for a pointer the browser is not currently tracking. That must
      // not take the rest of the handler down with it — losing `start` would
      // mean the drag silently never began.
      try { canvas.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
    });

    canvas.addEventListener('pointermove', event => {
      if (!start) return;
      const now = at(event);
      drawPage(page, Boxes.rectFromDrag(start.x, start.y, now.x, now.y));
    });

    canvas.addEventListener('pointerup', event => {
      if (!start) return;
      const end = at(event);
      const rect = Boxes.rectFromDrag(start.x, start.y, end.x, end.y);
      start = null;

      // A drag too small to be a box was a click, and a click means "change
      // your mind about whatever is under it".
      const minimum = canvas.width * 0.008;
      if (state.mode === 'pick') {
        // Too small to hold a logo. Leave pick mode armed rather than
        // silently treating the stray click as a redaction.
        if (rect.w < 8 || rect.h < 8) { drawPage(page); return; }
        addTemplate(page, rect);
        return;
      }
      if (rect.w < minimum && rect.h < minimum) {
        toggleAt(page, end.x, end.y);
        markPending();
      } else {
        const at = page.manual.length;
        // An id, so a hand-drawn box can carry a label and keep it across a
        // rescan.
        page.manual.push({ ...rect, id: 'man' + (nextManualId++) });
        pushUndo('the box you drew', () => page.manual.splice(at, 1));
        markPending();
      }

      drawPage(page);
      renderCounts();
    });

    canvas.addEventListener('pointercancel', () => { start = null; drawPage(page); });
  }

  // Click order matters: a hand-drawn box sits on top, so it is removed first;
  // then a live detection is dismissed; then a dismissed one is restored.
  function toggleAt(page, x, y) {
    const manualHit = Boxes.rectAt(page.manual, x, y);
    if (manualHit !== -1) {
      const [removed] = page.manual.splice(manualHit, 1);
      pushUndo('removing that box', () => page.manual.splice(manualHit, 0, removed));
      return;
    }

    // Live things first, in the order they are stacked on the page, then
    // dismissed ones so a change of mind is always reversible by clicking the
    // same spot again.
    for (const hit of page.hits) {
      if (page.dismissed.has(hit.finding.id)) continue;
      if (Boxes.rectAt(hit.rects, x, y) !== -1) {
        page.dismissed.add(hit.finding.id);
        pushUndo('keeping that match', () => page.dismissed.delete(hit.finding.id));
        return;
      }
    }
    for (const m of liveImageHits(page)) {
      if (page.dismissed.has(m.id)) continue;
      if (Boxes.rectAt([m.rect], x, y) !== -1) {
        page.dismissed.add(m.id);
        pushUndo('keeping that image', () => page.dismissed.delete(m.id));
        return;
      }
    }
    for (const hit of page.hits) {
      if (!page.dismissed.has(hit.finding.id)) continue;
      if (Boxes.rectAt(hit.rects, x, y) !== -1) {
        page.dismissed.delete(hit.finding.id);
        pushUndo('covering that match again', () => page.dismissed.add(hit.finding.id));
        return;
      }
    }
    for (const m of liveImageHits(page)) {
      if (!page.dismissed.has(m.id)) continue;
      if (Boxes.rectAt([m.rect], x, y) !== -1) {
        page.dismissed.delete(m.id);
        pushUndo('covering that image again', () => page.dismissed.add(m.id));
        return;
      }
    }
  }

  // ---------- picking a logo, and finding it again ----------

  function sensitivity() {
    return Number(el('sens').value) / 100;
  }

  // The bar a word drawn as a picture has to clear, on its own control.
  //
  // This was one slider with a fixed offset under it, and the offset was
  // wrong: it came from a single document, where a heading that really was
  // the word scored 0.598 and the best thing that was not scored 0.465. On
  // the next document a four-letter acronym matched 333 times, because a
  // short word resembles far more of a page than a long one does — in the
  // same panel, "TDTC" was matching everywhere while "Tokenomics Digital
  // Tech" matched once.
  //
  // No constant satisfies both: one needs 0.60 or lower, the other 0.65 or
  // higher. So it is a control rather than a number chosen here, it starts
  // where the image search starts, and the reviewer moves it with the
  // reported scores in front of them.
  // The bar the shape fallback holds a word to.
  //
  // This was a slider. Reading the pages is what runs now, and reading has no
  // threshold at all, so the control governed a method the reviewer almost
  // never sees — and asked them to tune something they had no way to judge.
  // The value is the one measured across three documents: every true
  // occurrence of a three-letter name scored 0.679 or better on one page,
  // while the best thing that was not the name scored 0.554.
  const WORD_BAR = 0.66;

  function wordSensitivity() {
    return WORD_BAR;
  }

  // The bar this particular word has to clear: the slider, less whatever its
  // length earns back. See lib/textimage.js for the measurements behind it.
  function wordBarFor(term) {
    return Math.max(0.3, Math.round((wordSensitivity() - TextImage.shapeRelief(term)) * 1000) / 1000);
  }

  function setMode(mode) {
    state.mode = mode;
    const button = el('pick');
    button.classList.toggle('on', mode === 'pick');
    button.textContent = mode === 'pick' ? 'Cancel — drag a box around the image' : 'Select an image to redact';
    for (const page of state.pages) {
      if (page.canvas) page.canvas.parentElement.classList.toggle('picking', mode === 'pick');
    }
    el('tip').textContent = mode === 'pick'
      ? 'Drag a box around the logo you want found everywhere else.'
      : 'Drag on a page to add a box. Click a mark to drop it. Marks stay red until you press Redact.';
  }

  // Cuts the picked region out of the page and searches every page for it.
  async function addTemplate(page, rect) {
    const cut = ImageSearch.templateFrom(page.source, rect);
    setMode('box');
    if (!cut) {
      alert('That pick was too small to match on. Draw a box around the whole logo.');
      drawPage(page);
      return;
    }

    const template = {
      id: 'tpl' + (nextTemplateId++),
      cut,
      rect,
      thumbnail: thumbnailOf(page.source, rect),
      matches: 0,
      // Not searched yet, and deliberately so: sweeping the document here is
      // what made picking a second logo mean waiting through the first.
      searched: false,
    };
    state.templates.push(template);
    pushUndo('picking that logo', () => dropTemplate(template.id));
    renderTemplates();
    renderSectionNotes();
    markPending();
    drawPage(page);
  }

  // Removal without recording an undo, so undoing an *add* does not leave a
  // "redo the removal" entry behind it.
  function dropTemplate(id) {
    state.templates = state.templates.filter(t => t.id !== id);
    for (const page of state.pages) {
      page.imageHits = page.imageHits.filter(m => m.templateId !== id);
    }
  }

  function removeTemplate(id) {
    const template = state.templates.find(t => t.id === id);
    const at = state.templates.indexOf(template);
    // Keep the matches as they stand, dismissals included, so putting the
    // logo back restores the review rather than re-running the search.
    const saved = state.pages.map(p => p.imageHits.filter(m => m.templateId === id));

    dropTemplate(id);
    pushUndo('removing that logo', () => {
      if (template) state.templates.splice(at, 0, template);
      state.pages.forEach((p, i) => { p.imageHits = p.imageHits.concat(saved[i]); });
    });

    renderTemplates();
    renderSectionNotes();
    markPending();
    redrawAll();
  }

  // A small picture of what was picked, so a list of three logos is
  // distinguishable at a glance.
  function thumbnailOf(source, rect) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 84 / Math.max(rect.w, rect.h));
    canvas.width = Math.max(1, Math.round(rect.w * scale));
    canvas.height = Math.max(1, Math.round(rect.h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function renderTemplates() {
    const host = el('templates');
    host.textContent = '';

    // The hint under the pick button describes the last search for a picked
    // image. With no image picked there is no such search to describe, and a
    // sentence left standing from a previous one — or from a previous
    // document, since this survived starting over — reads as a report about an
    // image the reviewer has not chosen.
    if (!state.templates.length) {
      const hint = el('pickhint');
      hint.hidden = true;
      hint.textContent = '';
      hint.classList.remove('warnhint');
    }

    for (const template of state.templates) {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.className = 't';
      // Counted from what survives, not from what the search returned: a
      // match already covered by a text mark is not a second thing found.
      const live = state.pages.reduce((sum, page) =>
        sum + liveImageHits(page).filter(m => m.templateId === template.id).length, 0);

      if (!template.searched) {
        name.textContent = 'not searched yet';
        name.classList.add('waiting');
      } else {
        name.textContent = live === 1 ? 'found once' : 'found ' + live + ' times';
      }

      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = template.searched ? String(live) : '—';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Stop matching this image';
      remove.addEventListener('click', () => removeTemplate(template.id));

      row.append(template.thumbnail, name, count, remove);
      host.append(row);
    }
  }

  // ---------- what each typed term actually matched ----------
  //
  // A term that matched nothing looks exactly like one that matched: the box
  // just sits there. Saying so is the difference between a reviewer noticing
  // they typed a name wrong and shipping a document with it still in.
  function renderTermCounts() {
    const host = el('termcounts');
    host.textContent = '';
    if (!state.terms.length) return;

    const texts = state.kind === 'text' ? [state.text] : state.pages.map(p => p.text);
    for (const term of state.terms) {
      let n = 0;
      for (const text of texts) n += Detect.findTerms(text, [term]).length;

      const row = document.createElement('li');
      if (n === 0) row.className = 'none';

      const label = document.createElement('span');
      label.className = 't';
      label.textContent = term;

      const pictures = state.pages.reduce((sum, page) =>
        sum + liveImageHits(page).filter(m => m.term === term).length, 0);

      const count = document.createElement('span');
      count.className = 'n';
      if (n === 0 && pictures === 0) count.textContent = 'not found';
      else if (pictures) count.textContent = n + ' + ' + pictures + ' as picture';
      else count.textContent = String(n);
      if (n === 0 && pictures > 0) row.className = '';

      row.append(label, count);
      host.append(row);

    }
  }

  // ---------- text documents ----------

  const dismissedText = new Set();

  function drawTextView() {
    const view = el('textview');
    view.textContent = '';
    let cursor = 0;

    for (const f of state.findings) {
      if (f.start < cursor) continue;
      view.append(document.createTextNode(state.text.slice(cursor, f.start)));
      const mark = document.createElement('mark');
      mark.textContent = state.text.slice(f.start, f.end);
      mark.title = f.label + ' — click to keep it';
      // Outlined until applied, so the reviewer can still read what is about
      // to go, exactly as on a page.
      if (!state.applied) mark.classList.add('pending');
      if (dismissedText.has(f.id)) { mark.className = 'off'; mark.title = f.label + ' — click to cover it'; }
      mark.addEventListener('click', () => {
        const wasOff = dismissedText.has(f.id);
        if (wasOff) dismissedText.delete(f.id); else dismissedText.add(f.id);
        pushUndo(wasOff ? 'covering that again' : 'keeping that match',
          () => { if (wasOff) dismissedText.add(f.id); else dismissedText.delete(f.id); });
        markPending();
        drawTextView();
        renderCounts();
      });
      view.append(mark);
      cursor = f.end;
    }
    view.append(document.createTextNode(state.text.slice(cursor)));
  }

  // ---------- export ----------

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function redactedName(extension) {
    const base = state.name.replace(/\.[^.]+$/, '') || 'document';
    return base + '-redacted.' + extension;
  }

  async function exportFile() {
    busy(true, 'Building the redacted file…');
    try {
      if (state.kind === 'text') {
        const spans = state.findings.filter(f => !dismissedText.has(f.id));
        let out;
        if (state.labelling) {
          // Placeholders instead of blocks, plus the legend at the foot so the
          // file explains its own notation.
          out = Detect.applyToText(state.text, spans.map(span => ({
            ...span, replacement: Labels.render(state.labels.byId[span.id]),
          })), 'replacement') + legendText();
        } else {
          out = Detect.applyToText(state.text, spans, 'block');
        }
        download(new Blob([out], { type: 'text/plain' }), redactedName('txt'));
      } else if (state.kind === 'image') {
        const page = state.pages[0];
        const flat = Render.flatten(page.source, activeBoxes(page));
        download(await Render.canvasToBlob(flat, 'image/png'), redactedName('png'));
      } else {
        const lossless = el('lossless').checked;
        const machineReadable = state.labelling && el('textlayer').checked;
        const built = [];

        for (const page of state.pages) {
          pageProgress(page.index, state.pages.length);
          const boxes = activeBoxes(page);
          const flat = Render.flatten(page.source, boxes);
          built.push({
            widthPt: page.widthPt,
            heightPt: page.heightPt,
            image: await Render.encodeForPdf(flat, lossless),
            labels: machineReadable ? textLayerFor(page, boxes) : undefined,
          });
        }

        if (state.labelling && el('legendpage').checked && state.labels.entries.length) {
          busy(true, 'Adding the legend…');
          built.push(await legendPage(lossless, machineReadable));
        }

        const bytes = PdfWrite.build(built);
        download(new Blob([bytes], { type: 'application/pdf' }), redactedName('pdf'));
      }
    } catch (error) {
      alert('The redacted file could not be built: ' + (error && error.message ? error.message : error) +
        '\n\nNothing was saved. Your document is unchanged.');
    } finally {
      busy(false);
    }
  }

  // Converts labelled boxes into the invisible text layer's coordinates.
  //
  // Canvas pixels run from the top left and PDF user space from the bottom
  // left, so the y axis flips here. The text is placed over the bar it belongs
  // to, which keeps extraction order the same as reading order.
  function textLayerFor(page, boxes) {
    const scaleX = page.widthPt / page.source.width;
    const scaleY = page.heightPt / page.source.height;

    return boxes.filter(box => box.label).map(box => {
      const height = box.h * scaleY;
      const size = Math.max(4, Math.min(height * 0.7, 14));
      return {
        text: Labels.render(box.label),
        x: box.x * scaleX,
        // Baseline sits a little above the bottom of the bar.
        y: page.heightPt - (box.y + box.h) * scaleY + (height - size) / 2,
        size,
      };
    });
  }

  // The legend, rendered as one more page image.
  //
  // Categories only. A legend inside the document that mapped a placeholder
  // back to the name it replaced would undo the redaction completely, which is
  // why the mapping is a separate download and why Labels.legend() is the
  // function used here rather than Labels.key().
  async function legendPage(lossless, machineReadable) {
    const first = state.pages[0];
    const built = Render.legendCanvas(Labels.legend(state.labels.entries), {
      width: first.source.width,
      height: first.source.height,
    });

    const scaleX = first.widthPt / built.canvas.width;
    const scaleY = first.heightPt / built.canvas.height;

    return {
      widthPt: first.widthPt,
      heightPt: first.heightPt,
      image: await Render.encodeForPdf(built.canvas, lossless),
      labels: machineReadable ? built.lines.map(line => ({
        text: line.text,
        x: line.x * scaleX,
        y: first.heightPt - line.y * scaleY,
        size: Math.max(4, line.size * scaleY),
      })) : undefined,
    };
  }

  // The legend as plain text, appended to a redacted text file.
  function legendText() {
    if (!state.labels.entries.length) return '';
    const rows = Labels.legend(state.labels.entries).map(entry =>
      '  ' + Labels.render(entry.label) + '  ' + entry.description +
      ' — appears ' + (entry.count === 1 ? 'once' : entry.count + ' times'));
    return '\n\n---\nRedaction legend\n' +
      'Each placeholder above replaces content removed from this document. The same\n' +
      'placeholder always stands for the same thing. This list does not record what\n' +
      'any of them were.\n\n' + rows.join('\n') + '\n';
  }

  // The mapping back to the originals — the one artefact here that is as
  // sensitive as the unredacted document, because it reconstructs everything
  // the redaction removed. It is a separate file, requested by its own button,
  // and it carries a header saying so. It is never written into the export.
  function downloadKey() {
    const payload = {
      document: state.name,
      generated: new Date().toISOString(),
      warning: 'This file maps each placeholder back to the text it replaced. It '
        + 'reconstructs everything the redaction removed. Keep it separate from the '
        + 'redacted document and do not share the two together.',
      entries: Labels.key(state.labels.entries),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    download(blob, (state.name.replace(/\.[^.]+$/, '') || 'document') + '-KEY-KEEP-PRIVATE.json');
  }

  // ---------- wiring ----------

  const drop = el('drop');
  const input = el('file');

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { loadFile(input.files[0]); input.value = ''; });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, e => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, e => { e.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
  // Without this the browser navigates away to the dropped file and the tab,
  // along with everything in it, is gone.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  // ---------- the "?" hints ----------
  //
  // These were title attributes. A title tooltip waits a second or two before
  // it appears, never appears at all on a touch screen, and cannot be reached
  // from the keyboard — so the hints read as decoration that does nothing.
  //
  // One bubble is shared and parented to <body> rather than to each button,
  // because the panel scrolls and a tooltip inside it gets clipped by its own
  // container. That means placing it in viewport coordinates, and closing it
  // when anything moves underneath it.
  const tip = (() => {
    let bubble = null;
    let owner = null;

    const close = () => {
      if (!owner) return;
      owner.setAttribute('aria-expanded', 'false');
      owner = null;
      if (bubble) bubble.hidden = true;
    };

    const open = button => {
      const text = button.getAttribute('data-tip');
      if (!text) return;
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'tipbubble';
        bubble.setAttribute('role', 'tooltip');
        bubble.id = 'tipbubble';
        document.body.appendChild(bubble);
      }
      bubble.textContent = text;
      bubble.hidden = false;
      button.setAttribute('aria-describedby', bubble.id);
      button.setAttribute('aria-expanded', 'true');
      owner = button;

      // Measure after filling it, then keep it on screen. Anchored under the
      // button where there is room and above it where there is not, so a hint
      // on the last row of the panel is not drawn off the bottom.
      const at = button.getBoundingClientRect();
      const size = bubble.getBoundingClientRect();
      const margin = 8;
      let left = at.left + at.width / 2 - size.width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - size.width - margin));
      let top = at.bottom + 6;
      if (top + size.height > window.innerHeight - margin) top = at.top - size.height - 6;
      bubble.style.left = Math.round(left) + 'px';
      bubble.style.top = Math.round(Math.max(margin, top)) + 'px';
    };

    return { open, close, isOpen: button => owner === button };
  })();

  for (const button of document.querySelectorAll('.why')) {
    button.setAttribute('aria-expanded', 'false');
    // Hover and focus for a pointer and a keyboard; click for a touch screen,
    // which has neither. Click also has to close an already-open hint, or
    // tapping one on a phone leaves it stuck open.
    button.addEventListener('pointerenter', () => tip.open(button));
    button.addEventListener('pointerleave', () => tip.close());
    button.addEventListener('focus', () => tip.open(button));
    button.addEventListener('blur', () => tip.close());
    button.addEventListener('click', event => {
      event.preventDefault();
      // A "?" inside a <label> would otherwise toggle the checkbox it sits
      // beside, so the click stops here.
      event.stopPropagation();
      if (tip.isOpen(button)) tip.close(); else tip.open(button);
    });
  }
  window.addEventListener('keydown', event => { if (event.key === 'Escape') tip.close(); });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.why')) tip.close();
  });
  // Anything that moves the anchor invalidates the placement.
  window.addEventListener('scroll', () => tip.close(), true);
  window.addEventListener('resize', () => tip.close());

  // Refreshing loses the document, and there is no recovering it.
  //
  // Everything lives in this tab by design: the file was never uploaded, so
  // there is no copy on a server to reload from, and the work of picking
  // terms, cropping logos and drawing boxes exists nowhere else. A reflexive
  // Cmd-R throws all of it away silently. The browser's own confirmation is
  // the only thing that can interrupt a reload, so ask for it whenever there
  // is something to lose.
  //
  // Browsers ignore custom text here and show their own wording, so none is
  // supplied. Chrome also requires preventDefault, while older browsers need
  // returnValue set; both are done because neither is enough alone.
  window.addEventListener('beforeunload', event => {
    if (!state.pages.length) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
  });

  let termsTimer = null;
  el('terms').addEventListener('input', () => {
    clearTimeout(termsTimer);
    termsTimer = setTimeout(() => {
      const next = el('terms').value.split('\n').map(s => s.trim()).filter(Boolean);
      // A word that is no longer listed should not keep its picture matches.
      const gone = state.searchedTerms.filter(term => !next.includes(term));
      if (gone.length) {
        state.searchedTerms = state.searchedTerms.filter(term => next.includes(term));
        for (const page of state.pages) {
          page.imageHits = page.imageHits.filter(m => !m.term || next.includes(m.term));
        }
      }
      state.terms = next;
      rescan();
    }, 200);
  });

  el('medium').addEventListener('change', e => { state.includeMedium = e.target.checked; rescan(); });

  // The box and the state start from the same value, rather than each
  // asserting a default of its own.
  el('termimages').checked = state.termImages;
  showWordControls();

  el('busy-pause').addEventListener('click', requestPause);

  el('termimages').addEventListener('change', e => {
    state.termImages = e.target.checked;
    showWordControls();
    clearTermImages();
    renderTermCounts();
    markPending();
    redrawAll();
  });

  el('pick').addEventListener('click', () => setMode(state.mode === 'pick' ? 'box' : 'pick'));

  el('labelling').addEventListener('change', e => {
    state.labelling = e.target.checked;
    el('labelopts').hidden = !state.labelling;
    el('legendbox').hidden = !state.labelling;
    renderSectionNotes();
    redrawAll();
    // The legend is the point of turning this on and it sits below the fold of
    // a long panel, so bring it to the reviewer rather than making them look
    // for it.
    if (state.labelling) el('legendbox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  el('downloadkey').addEventListener('click', downloadKey);
  el('undo').addEventListener('click', undoLast);
  el('apply').addEventListener('click', applyRedaction);
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      // Not while typing into the terms box — there, undo means the textarea's.
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
      event.preventDefault();
      undoLast();
    }
  });

  // The slider moves continuously; re-running the whole document on every
  // pixel of travel would make it unusable, so the search waits for it to
  // settle. The read-out updates immediately either way.
  // Moving the slider invalidates every search rather than re-running them.
  // Re-running on each pixel of travel was unusable, and re-running once it
  // settled still meant a multi-second sweep nobody asked for.
  el('sens').addEventListener('input', () => {
    el('sensvalue').textContent = sensitivity().toFixed(2);
    for (const template of state.templates) {
      if (template.searched) { template.searched = false; template.matches = 0; }
    }
    for (const page of state.pages) page.imageHits = [];
    state.searchedTerms = [];
    renderTemplates();
    renderTermCounts();
    markPending();
    redrawAll();
  });
  el('export').addEventListener('click', exportFile);
  el('restart').addEventListener('click', () => {
    state.pages = [];
    state.text = '';
    state.findings = [];
    dismissedText.clear();
    el('terms').value = '';
    state.terms = [];
    state.templates = [];
    state.labelOverrides = {};
    state.labels = { byId: {}, entries: [] };
    state.applied = false;
    state.searchedTerms = [];
    undoStack.length = 0;
    refreshUndo();
    setMode('box');
    renderTemplates();
    renderTermCounts();
    show('drop');
  });

  window.Blinded = { state, rescan, loadFile, exportFile, setMode, addTemplate,
    undoLast, undoStack, applyLabels, labelItems, legendText, downloadKey,
    sensitivity, wordSensitivity, wordBarFor,
    applyRedaction, markPending, plannedCount, pendingTemplates, termsNeedingPictures,
    readPages, matchOcr, ocrPending, ocrMatchStale, showWordControls,
    busy, pageProgress, requestPause,
    renderTermCounts };
})();
