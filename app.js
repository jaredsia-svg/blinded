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
  const views = { drop: el('view-drop'), review: el('view-review'), faq: el('view-faq') };

  // A dismissed detection still has to be visible, or the reviewer cannot
  // change their mind — it becomes a dashed outline they can click again.
  const state = {
    kind: null,        // 'pdf' | 'image' | 'text'
    name: '',
    pages: [],         // { index, source, canvas, widthPt, heightPt, items, findings, hits, manual, dismissed }
    text: '',
    enabled: new Set(Detect.KINDS.map(k => k.kind).concat('term')),
    terms: [],
    // The pages the reviewer has selected in the Organise sheet. Page objects
    // rather than numbers, because a number stops meaning the same page the
    // moment anything is moved and a selection that quietly retargets is
    // worse than one that is lost.
    picked: new Set(),
    // Logos the reviewer has picked. Each holds the greyscale patch it was cut
    // from, so its matches can be recomputed when the sensitivity moves
    // without making them draw the box again.
    templates: [],
    // 'box' draws a redaction; 'pick' cuts a logo to search for. One drag
    // gesture, two meanings, so the mode is always visible on the page itself.
    mode: 'box',
    // What a drag on a page does when no logo is being picked: 'pan' moves the
    // document, 'mark' draws a box.
    //
    // Panning is the default because reading comes before marking. With
    // dragging always meaning "draw", the only way to scroll a long document
    // was to keep the pointer off the pages entirely, and a drag that strayed
    // onto one left a box behind — on a confidential document, a stray mark
    // that covers something is a worse accident than a stray scroll.
    tool: 'pan',
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
    // Words are always looked for in pictures as well as in the text.
    //
    // This was a checkbox, on by default, from when reading the pages was slow
    // enough to be worth opting out of. Switching it off is not a trade a
    // reviewer can make sensibly — it turns off the one thing this tool does
    // that a text search cannot — and a document where the name only appears
    // in a screenshot comes out looking redacted and is not. The flag stays
    // because the fallback path and the text-file case both read it.
    termImages: true,
    // Words inside pictures are found by reading the page. Matching drawn
    // shapes is the fallback for when the reader cannot be loaded at all.
    useOcr: true,
    ocrFailed: false,
    // Whether the reader has already been fetched this session.
    ocrLoaded: false,
    // Set while a run is being stopped between pages.
    paused: false,
    // Places the reader was unsure of, that could be one of the terms.
    // The thorough sweep: whether it has run for the terms as they stand, and
    // what it added when it did.
    sweptTerms: [],
    sweepAdded: 0,
    // Three states, in order: nothing looked for yet, looked for and proposed,
    // covered.
    //
    // Marks used to appear the instant a word was typed, which put a red
    // outline on the page while the reviewer was still in the middle of typing
    // the word — and worse, showed a half-typed word's matches as if they were
    // an answer. Nothing is drawn now until the reviewer asks.
    searched: false,
    countedTerms: [],
    zoom: 1,
    // Which half of the review a small screen is showing.
    pane: 'edit',
    sourceSize: 0,
    sourceDigest: null,
    // Which word's list of places is open, if any.
    openTally: null,
    exported: false,
    redacting: false,
    sweepRunning: false,
    sweepStopped: false,
    sweepReached: 0,
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
  function busy(on, message) {
    el('busy').hidden = !on;
    if (message !== undefined && message !== null) el('busy-text').textContent = message;
    if (!on) {
      el('busy-pause').hidden = true;
      legs([]);
      busyNote('');
    }
  }

  // A line under the bars, for when the wait itself raises the question.
  //
  // Watching a file being worked on for the first time is exactly when someone
  // wonders where it has gone. The answer is on the front page, but the front
  // page is not what they are looking at.
  function busyNote(text) {
    const note = el('busy-note');
    note.textContent = text || '';
    note.hidden = !text;
  }

  // A run declares its legs up front, and each gets its own bar.
  //
  // This was one bar across the whole job, on the reasoning that two filling
  // in sequence would read as the first one having lied. That is true of bars
  // that appear one after another — but not of bars that are both there from
  // the start. Shown together they say what the job consists of before it
  // begins, and when a run is paused they say which part of it got how far:
  // "the pages are read to 40 of 100, the images are not started" is a
  // different situation from "everything is 40% done", and a reviewer deciding
  // whether to wait needs to know which one they are in.
  //
  // A leg that has no work is not drawn at all. An empty bar for a search
  // nobody asked for is a bar that will never move.
  function legs(list) {
    const host = el('busy-legs');
    host.textContent = '';
    host.hidden = !list.length;
    for (const leg of list) {
      if (!leg.total) continue;
      const row = document.createElement('div');
      row.className = 'leg';
      row.dataset.leg = leg.key;

      const label = document.createElement('p');
      label.className = 'leg-label';
      const what = document.createElement('span');
      what.textContent = leg.label;
      const count = document.createElement('span');
      count.className = 'leg-count';
      count.dataset.count = leg.key;
      count.textContent = '0 of ' + leg.total;
      label.append(what, count);

      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(leg.total));
      bar.setAttribute('aria-label', leg.label);
      const fill = document.createElement('i');
      fill.dataset.fill = leg.key;
      // Started explicitly at nothing rather than left unset: a leg that has
      // not begun should read as zero, not as absent.
      fill.style.width = '0%';
      bar.append(fill);

      row.append(label, bar);
      host.append(row);
      row.dataset.total = String(leg.total);
    }
    host.hidden = !host.children.length;
  }

  function leg(key, done) {
    const row = el('busy-legs').querySelector('[data-leg="' + key + '"]');
    if (!row) return;
    const total = Number(row.dataset.total) || 0;
    const at = Math.max(0, Math.min(total, done));
    row.querySelector('[data-fill]').style.width =
      (total ? (at / total) * 100 : 0).toFixed(1) + '%';
    row.querySelector('[data-count]').textContent = at + ' of ' + total;
    row.querySelector('.bar').setAttribute('aria-valuenow', String(at));
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

  // A run with one leg, which is most of them.
  function pageProgress(done, total, label) {
    const key = 'only';
    const host = el('busy-legs');
    if (!host.querySelector('[data-leg="' + key + '"]')) {
      legs([{ key, label: label || 'Pages', total }]);
    }
    leg(key, done);
  }

  // Which view the reviewer was on before opening the answers, so closing them
  // puts them back.
  let viewBefore = 'drop';

  function show(name) {
    if (name !== 'faq') viewBefore = name;
    for (const key of Object.keys(views)) views[key].hidden = key !== name;
    // The one button both opens and closes them, so it says which.
    el('faq-open').textContent = name === 'faq' ? 'Back to the tool' : 'Q\u0026A';
    // Reviewing is a fixed-height layout: the header and the export bar stay
    // put and the panel and the document each scroll on their own. The front
    // page is an ordinary scrolling page, so the class comes and goes with the
    // view rather than living on the body for good.
    document.body.classList.toggle('reviewing', name === 'review');
    // Starting over only means something once there is something to start
    // over from, and the questions page is not that: leaving it puts the
    // document back, so the button would be offering to throw away work the
    // reviewer is not even looking at.
    el('reset-top').hidden = !(name === 'review'
      || (name === 'faq' && viewBefore === 'review'));
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
    refreshUndo();
  }

  // ---------- loading ----------

  const TEXT_EXT = /\.(txt|md|markdown|csv|log|json|xml|yml|yaml)$/i;

  async function loadFile(file) {
    el('drop-error').hidden = true;
    if (!file) return;

    try {
      // A draft is not a document: it is the work that was done to one.
      if (/\.json$/i.test(file.name) || file.type === 'application/json') {
        const data = looksLikeDraft(await file.text());
        if (data) { takeDraft(data); return; }
        // Any other JSON is just a text file, and falls through as one.
      }

      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        busy(true, 'Reading the PDF…');
        busyNote('Your file is being rendered locally on your device. '
          + 'Nothing is uploaded.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        state.sourceSize = file.size;
        state.sourceDigest = await fingerprint(bytes);
        // Every pass over the pages reports the same way: which page, and a
        // bar. Three different sentences for three loops that all mean "this
        // is taking a while" is three things to read instead of one.
        const pages = await renderPdf(bytes, (n, total) =>
          pageProgress(n - 1, total, 'Rendering pages'));
        await warnIfHuge(pages.length);
        startReview('pdf', file.name, pages);
      } else if (/^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
        state.sourceSize = file.size;
        state.sourceDigest = await fingerprint(new Uint8Array(await file.arrayBuffer()));
        busy(true, 'Reading the image…');
        busyNote('Your file is being read locally on your device. '
          + 'Nothing is uploaded.');
        startReview('image', file.name, [await loadImage(file)]);
      } else if (/^text\//.test(file.type) || TEXT_EXT.test(file.name)) {
        busy(true, 'Reading the file…');
        state.text = await file.text();
        startReview('text', file.name, []);
      } else {
        fail('Blinded can open PDFs, PNG and JPEG images, and plain text files. That looked like none of those.');
        return;
      }

      // A draft was chosen first and has been waiting for its document.
      if (pendingDraft) {
        const draft = pendingDraft;
        pendingDraft = null;
        dropDraftPrompt();
        busy(false);
        await restoreDraft(draft);
      }
    } catch (error) {
      // Cancelling the password box is a decision, not a failure. Saying "that
      // file could not be opened" to someone who has just pressed Cancel tells
      // them something they already know, in the voice of a fault.
      if (error && error.blindedCancelled) { show('drop'); return; }
      // A failure here means the document was not fully understood, and a
      // partial review is worse than none: it looks complete.
      fail('That file could not be opened: ' + (error && error.message ? error.message : String(error))
        + '. Nothing was redacted.');
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
    state.sweptTerms = [];
    state.sweepAdded = 0;
    state.sweepStopped = false;
    state.sweepReached = 0;
    state.exported = false;
    state.searched = false;
    state.countedTerms = [];
    state.openTally = null;
    state.picked = new Set();
    state.pages = pages.map(p => ({
      ...p,
      uid: nextPageUid++,
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
    // The lossless choice is about how pages are re-encoded as pictures, so it
    // means nothing for a text file. It lives in the Save as box now, next to
    // the name, which is where the reviewer is actually deciding about the
    // file rather than about the document.
    el('losslessrow').hidden = kind === 'text';

    state.applied = false;
    if (kind !== 'text') buildPageElements();
    renderSheet();
    show('review');
    rescan();
    refreshApply();
    refreshPaging();
  }

  // ---------- organising the pages ----------
  //
  // The sheet is a second view of the same array. Everything it does — moving
  // a page, throwing one away, merging another document in — is a new order
  // for state.pages, applied in one place, so there is exactly one function
  // that has to get the bookkeeping right rather than four that each half do.
  //
  // Two things are keyed to a page's position and have to move with it. The
  // page's own index, which is what every "Page 7" in the panel is read from;
  // and a picked logo's pageIndex, which is where it gets re-cut from when the
  // sensitivity moves. Everything else — findings, marks, dismissals, the
  // reading — lives on the page object itself and travels with it for free.

  let nextPageUid = 1;

  const THUMB_W = 96;

  function thumbFor(page) {
    if (page.thumb && page.thumbFrom === page.source) return page.thumb;
    const scale = THUMB_W / page.source.width;
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W;
    canvas.height = Math.max(1, Math.round(page.source.height * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(page.source, 0, 0, canvas.width, canvas.height);
    page.thumb = canvas;
    page.thumbFrom = page.source;
    return canvas;
  }

  // A document that has been reorganised is no longer the file it came from,
  // so it must not answer to that file's drafts. The stamp is derived from the
  // order itself, so doing the same thing twice still agrees with itself and a
  // draft saved after organising reopens on a document organised the same way.
  function organiseStamp() {
    let hash = 0;
    for (const page of state.pages) hash = (hash * 31 + page.uid) % 2147483647;
    return 'p' + state.pages.length + '.' + hash.toString(36);
  }

  function restamp() {
    if (!state.baseDigest) state.baseDigest = state.sourceDigest;
    state.sourceDigest = state.baseDigest
      ? state.baseDigest + '+' + organiseStamp() : null;
  }

  // The one place the page list changes.
  function setOrder(pages, label, before) {
    const was = before || state.pages.slice();
    const wasPicked = new Set(state.picked);
    const knew = { searched: state.searched, swept: state.sweptTerms.slice(),
      read: state.ocrRead };
    state.pages = pages;
    state.pages.forEach((page, i) => { page.index = i; });
    // A logo remembers the page it was cut from by number. Re-point it at the
    // page object it actually came from, or drop it if that page has gone —
    // leaving it pointing at whatever is now in that slot would re-cut the
    // logo from the wrong picture the next time the bar moved.
    const at = new Map(state.pages.map((page, i) => [page, i]));
    state.templates = state.templates.filter(template => {
      const home = was[template.pageIndex];
      if (!home || !at.has(home)) return false;
      template.pageIndex = at.get(home);
      return true;
    });
    for (const page of [...state.picked]) if (!at.has(page)) state.picked.delete(page);

    // What the search knows is a claim about a set of pages. Moving them
    // around does not touch it — the marks live on the page objects and travel
    // with them — but changing which pages there are does, and quietly.
    //
    // The thorough check records the terms it has swept, not the pages it
    // swept them over. Add a document after a sweep and the panel goes on
    // saying the check has been done, over pages it has never seen. That is
    // the worst shape a bug can take here: it does not look like a failure, it
    // looks like an answer.
    const had = new Set(was);
    const added = state.pages.filter(page => !had.has(page));
    const gone = was.filter(page => !at.has(page));
    if (added.length || gone.length) {
      state.sweptTerms = [];
      state.searched = false;
    }
    // Reading is a claim about every page, so a new one un-reads the document.
    // Losing a page does not: what is left has still been read.
    if (added.length) state.ocrRead = false;

    restamp();
    if (label) {
      pushUndo(label, () => {
        state.pages = was;
        state.pages.forEach((page, i) => { page.index = i; });
        state.picked = wasPicked;
        state.searched = knew.searched;
        state.sweptTerms = knew.swept;
        state.ocrRead = knew.read;
        restamp();
        rebuildAfterOrder();
      });
    }
    rebuildAfterOrder();
  }

  function rebuildAfterOrder() {
    buildPageElements();
    renderSheet();
    // Settled, because a rescan otherwise sends the document back to
    // un-searched on its own, and here that is not its call to make. Moving a
    // page changes nothing about what was looked for or what was found, and
    // where the page set really did change, setOrder has already withdrawn
    // exactly as much as it should above.
    rescan({ settled: true });
    renderSweep();
    renderTemplates();
    refreshApply();
    refreshPaging();
  }

  function pickedInOrder() {
    return state.pages.filter(page => state.picked.has(page));
  }

  function renderSheet() {
    const section = el('organisesect');
    if (!section) return;
    // A text file has no pages to organise, and an empty sheet under a heading
    // reads as something broken rather than something absent.
    section.hidden = state.kind === 'text' || !state.pages.length;
    if (section.hidden) return;

    const host = el('sheet');
    host.textContent = '';
    for (const page of state.pages) {
      const item = document.createElement('li');
      item.className = 'sheetpage' + (state.picked.has(page) ? ' picked' : '');
      item.dataset.page = String(page.index);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sheetface';
      button.setAttribute('aria-pressed', state.picked.has(page) ? 'true' : 'false');
      button.title = 'Page ' + (page.index + 1);
      const thumb = thumbFor(page);
      const img = document.createElement('canvas');
      img.width = thumb.width;
      img.height = thumb.height;
      img.getContext('2d').drawImage(thumb, 0, 0);
      const num = document.createElement('span');
      num.className = 'sheetnum';
      num.textContent = String(page.index + 1);
      button.append(img, num);

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.title = 'Drag to move this page';
      grip.setAttribute('aria-hidden', 'true');

      item.append(button, grip);
      host.append(item);
      wireSheetPage(item, page, button, grip);
    }
    refreshSheetBar();
  }

  function refreshSheetBar() {
    const picked = pickedInOrder();
    const n = picked.length;
    const only = state.pages.length;
    const note = el('sheet-picked');
    note.hidden = n === 0;
    note.textContent = n === 1
      ? 'Page ' + (picked[0].index + 1) + ' selected.'
      : n + ' pages selected.';
    el('page-left').disabled = !n || picked[0].index === 0;
    el('page-right').disabled = !n || picked[n - 1].index === only - 1;
    // Keeping only everything is a no-op, and removing everything leaves no
    // document at all — neither is offered rather than refused after the fact.
    el('page-keep').disabled = !n || n === only;
    el('page-drop').disabled = !n || n === only;
    const kinds = state.pages.length;
    const set = el('organise-note');
    if (set) {
      set.textContent = kinds + (kinds === 1 ? ' page' : ' pages');
      set.classList.toggle('on', Boolean(state.baseDigest));
    }
  }

  // Click to select, shift-click for a run, ctrl or cmd-click to add one on
  // its own. The anchor is the last page clicked without shift, which is what
  // every file list does and therefore what the hand expects.
  let sheetAnchor = null;

  function selectPage(page, event) {
    // The sheet and the document are two views of one thing, so touching a
    // page in one should be looking at it in the other. Without this, finding
    // page 47 in the thumbnails and then wanting to read it means scrolling
    // the document to it by hand, having just pointed straight at it.
    goToPage(page.index, { stay: true });
    const spread = event && event.shiftKey;
    const add = event && (event.metaKey || event.ctrlKey);
    if (spread && sheetAnchor && state.pages.includes(sheetAnchor)) {
      const from = Math.min(sheetAnchor.index, page.index);
      const to = Math.max(sheetAnchor.index, page.index);
      if (!add) state.picked.clear();
      for (let i = from; i <= to; i++) state.picked.add(state.pages[i]);
    } else if (add) {
      if (state.picked.has(page)) state.picked.delete(page);
      else state.picked.add(page);
      sheetAnchor = page;
    } else {
      const alone = state.picked.size === 1 && state.picked.has(page);
      state.picked.clear();
      if (!alone) state.picked.add(page);
      sheetAnchor = alone ? null : page;
    }
    renderSheet();
  }

  // Dragging happens on the grip rather than on the page, so that a tap on a
  // phone still selects and the panel still scrolls under the finger. Pointer
  // events, so one path serves mouse, pen and touch.
  //
  // The page being dragged follows the pointer as a picture of itself. Without
  // it the only sign anything is happening is a faded tile and an outline
  // somewhere else, and on a grid of thumbnails that reads as a glitch rather
  // than as carrying something: there is nothing in the hand.
  function wireSheetPage(item, page, button, grip) {
    button.addEventListener('click', event => {
      event.preventDefault();
      selectPage(page, event);
    });

    grip.addEventListener('pointerdown', event => {
      event.preventDefault();
      const held = event.pointerId;
      // Capture keeps the pointer reporting to the grip once it has left it,
      // which is most of what makes a drag feel attached. It is also allowed
      // to fail — a pointer the browser no longer considers active throws —
      // and an exception here used to take the whole gesture with it: no
      // copy in the hand, no drop, nothing. So it is asked for, not relied
      // on, and the listeners below sit on the window either way.
      try { grip.setPointerCapture(held); } catch (error) { /* not essential */ }
      const host = el('sheet');
      const moving = state.picked.has(page) ? pickedInOrder() : [page];
      item.classList.add('dragging');
      document.body.classList.add('dragging-page');
      // Which gap the page would go into, counted in the layout as it stands:
      // 0 is before the first page, n is after the last. A gap rather than a
      // tile, because that is what the line drawn on screen is showing and the
      // two must not be able to disagree — a tile means "before this one" when
      // you drag backwards and "after this one" when you drag forwards, which
      // is a rule nobody should have to know.
      const gapOf = point => {
        const tiles = [...host.querySelectorAll('.sheetpage')];
        let best = 0;
        let nearest = Infinity;
        for (let i = 0; i < tiles.length; i++) {
          const box = tiles[i].getBoundingClientRect();
          const inside = point.clientX >= box.left && point.clientX <= box.right
            && point.clientY >= box.top && point.clientY <= box.bottom;
          const dx = point.clientX - (box.left + box.width / 2);
          const dy = point.clientY - (box.top + box.height / 2);
          const away = inside ? -1 : dx * dx + dy * dy;
          if (away < nearest) { nearest = away; best = dx >= 0 ? i + 1 : i; }
          if (inside) break;
        }
        return best;
      };

      const ghost = liftGhost(page, moving.length, event);
      let target = gapOf(event);
      // Where the pointer last was, so the sheet scrolling underneath a still
      // finger can still answer "which gap is this now" — the tiles move even
      // when the pointer does not.
      let last = event;
      const mark = () => {
        target = gapOf(last);
        showDropAt(target, host);
      };
      const move = ev => {
        if (ev.pointerId !== held) return;
        last = ev;
        carryGhost(ghost, ev);
        edgeScroll(host, ev, mark);
        mark();
      };
      const done = ev => {
        // A second finger landing on the sheet must not end the drag the
        // first one is in the middle of.
        if (ev.pointerId !== held) return;
        try {
          if (grip.hasPointerCapture && grip.hasPointerCapture(held)) {
            grip.releasePointerCapture(held);
          }
        } catch (error) { /* it was never captured */ }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', done);
        window.removeEventListener('pointercancel', done);
        stopEdgeScroll();
        item.classList.remove('dragging');
        document.body.classList.remove('dragging-page');
        clearDropMark();
        // A cancelled drag is not a drop. A pointercancel is the system taking
        // the gesture away — a call arriving, the browser deciding it was a
        // scroll after all — and moving the page on the strength of wherever
        // the finger happened to be is a change nobody asked for.
        if (ev.type === 'pointercancel') { dropGhost(ghost, null); return; }
        const gap = gapOf(ev);
        const tiles = [...host.querySelectorAll('.sheetpage')];
        dropGhost(ghost, tiles[Math.min(gap, tiles.length - 1)]);
        moveTo(moving, gap);
      };
      mark();
      // On the window rather than on the grip, so the drag survives both a
      // capture that was refused and a pointer let go somewhere off the sheet
      // entirely — over the document, over the header, outside the tab.
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', done);
      window.addEventListener('pointercancel', done);
    });
  }

  // Dragging towards a page you cannot see.
  //
  // The sheet is a few rows tall with the rest scrolled away, so moving a page
  // to the end of a long document meant dropping it as far down as the window
  // went, scrolling, picking it up again, and repeating. Holding the pointer
  // near an edge scrolls the sheet under it instead, the way a file manager
  // does — and when the sheet has no more to give, the panel behind it takes
  // over, so the last row is reachable even when the sheet itself is short.
  const CREEP_EDGE = 44;    // how close to an edge starts it
  const CREEP_STEP = 14;    // pixels per frame at the very edge
  let edgeTimer = null;

  function edgeScroll(host, event, onScroll) {
    stopEdgeScroll();
    const box = host.getBoundingClientRect();
    const above = event.clientY - box.top;
    const below = box.bottom - event.clientY;
    let way = 0;
    if (above < CREEP_EDGE) way = -(1 - Math.max(0, above) / CREEP_EDGE);
    else if (below < CREEP_EDGE) way = 1 - Math.max(0, below) / CREEP_EDGE;
    if (!way) return;

    const step = () => {
      const by = Math.round(way * CREEP_STEP);
      const before = host.scrollTop;
      host.scrollTop += by;
      // Nothing left in the sheet: push the panel instead, so the tail of a
      // long document is reachable rather than merely nearly reachable.
      if (host.scrollTop === before) {
        const panel = host.closest('.panel') || scrollerFor(host);
        if (panel && panel !== host) {
          if (panel === window) window.scrollBy(0, by);
          else panel.scrollTop += by;
        }
      }
      if (onScroll) onScroll();
      edgeTimer = requestAnimationFrame(step);
    };
    edgeTimer = requestAnimationFrame(step);
  }

  function stopEdgeScroll() {
    if (edgeTimer !== null) cancelAnimationFrame(edgeTimer);
    edgeTimer = null;
  }

  // The thing in the hand. A copy of the page, tilted a little and lifted off
  // the panel, following the pointer.
  function liftGhost(page, count, event) {
    const ghost = document.createElement('div');
    ghost.className = 'sheetghost';
    const thumb = thumbFor(page);
    const face = document.createElement('canvas');
    face.width = thumb.width;
    face.height = thumb.height;
    face.getContext('2d').drawImage(thumb, 0, 0);
    ghost.append(face);
    // Dragging four pages should look like dragging four pages, not like
    // dragging the one that happened to be grabbed.
    if (count > 1) {
      ghost.classList.add('stacked');
      const badge = document.createElement('span');
      badge.className = 'ghostcount';
      badge.textContent = String(count);
      ghost.append(badge);
    }
    document.body.append(ghost);
    carryGhost(ghost, event);
    return ghost;
  }

  function carryGhost(ghost, event) {
    if (!ghost) return;
    const x = event.clientX - ghost.offsetWidth / 2;
    const y = event.clientY - ghost.offsetHeight / 2;
    ghost.style.transform = 'translate(' + x + 'px, ' + y + 'px) rotate(-4deg)';
  }

  // Dropped, rather than switched off. The copy shrinks into the slot it
  // landed in, so the eye is told where the page went — the sheet is about to
  // renumber itself and every tile after the drop is about to change what it
  // says, and without this the page appears to vanish and something else
  // appears to move.
  function dropGhost(ghost, into) {
    if (!ghost) return;
    const box = into && into.getBoundingClientRect();
    if (box) {
      ghost.style.transition = 'transform .16s ease-out, opacity .16s ease-out';
      ghost.style.transform = 'translate(' + box.left + 'px, ' + box.top + 'px) '
        + 'rotate(0deg) scale(' + (box.width / Math.max(1, ghost.offsetWidth)) + ')';
    }
    ghost.style.opacity = '0';
    setTimeout(() => ghost.remove(), 180);
  }

  // Where the page will go, drawn as a line in the gap it will land in.
  //
  // Fixed to the viewport, like the copy in the hand, so that a sheet which
  // has scrolled needs no arithmetic to stay lined up: the tile is measured
  // where it actually is on screen and the line is put there.
  function showDropAt(gap, host) {
    const tiles = [...(host || el('sheet')).querySelectorAll('.sheetpage')];
    if (!tiles.length) return;
    let line = document.querySelector('.dropline');
    if (!line) {
      line = document.createElement('div');
      line.className = 'dropline';
      document.body.append(line);
    }
    const past = gap >= tiles.length;
    const box = tiles[past ? tiles.length - 1 : gap].getBoundingClientRect();
    // Centred in the gutter between two pages rather than against an edge, so
    // it reads as "between these" and not as "this one is selected".
    const x = (past ? box.right + 4 : box.left - 4) - 1.5;
    line.style.transform = 'translate(' + x + 'px, ' + (box.top - 3) + 'px)';
    line.style.height = (box.height + 6) + 'px';
  }

  function clearDropMark() {
    const line = document.querySelector('.dropline');
    if (line) line.remove();
  }

  // Moves a run of pages into `gap`, a position in the list as it stands right
  // now: 0 is before the first page, n is after the last. That is the same
  // thing the line on screen is pointing at, which is the point — the marker
  // and the move read the same number, so they cannot come apart.
  //
  // Pages that are moving and sit before the gap have to be discounted, since
  // lifting them out closes the space behind them. Getting this wrong is what
  // made a page dropped forwards land one slot short.
  function moveTo(moving, gap) {
    const set = new Set(moving);
    const rest = state.pages.filter(page => !set.has(page));
    const ahead = state.pages.filter((page, i) => !set.has(page) && i < gap).length;
    const at = Math.max(0, Math.min(rest.length, ahead));
    const next = rest.slice(0, at).concat(moving, rest.slice(at));
    if (next.every((page, i) => page === state.pages[i])) return;
    setOrder(next, moving.length === 1 ? 'moving a page' : 'moving pages');
  }

  function nudge(delta) {
    const moving = pickedInOrder();
    if (!moving.length) return;
    if (delta < 0 && moving[0].index === 0) return;
    if (delta > 0 && moving[moving.length - 1].index === state.pages.length - 1) return;
    // Back: into the gap in front of the page before this run. On: into the
    // gap after the page that follows it, which is two along because the gap
    // immediately after the run is the one it already occupies.
    moveTo(moving, delta < 0
      ? moving[0].index - 1
      : moving[moving.length - 1].index + 2);
  }

  function keepOnlyPicked() {
    const keep = pickedInOrder();
    if (!keep.length || keep.length === state.pages.length) return;
    const going = state.pages.length - keep.length;
    setOrder(keep, 'keeping ' + keep.length + ' of ' + (keep.length + going) + ' pages');
  }

  function dropPicked() {
    const going = pickedInOrder();
    if (!going.length || going.length === state.pages.length) return;
    const keep = state.pages.filter(page => !state.picked.has(page));
    state.picked = new Set();
    setOrder(keep, going.length === 1 ? 'removing a page' : 'removing ' + going.length + ' pages');
  }

  // Merging another document in. The new pages go after the last selected
  // page, so that "put these in the middle" needs no second step; with nothing
  // selected they go on the end, which is what appending means.
  async function addDocument(file) {
    if (!file) return;
    let fresh = [];
    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        busy(true, 'Reading the PDF…');
        busyNote('Your file is being rendered locally on your device. Nothing is uploaded.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        fresh = await renderPdf(bytes, (n, total) =>
          pageProgress(n - 1, total, 'Rendering pages'));
      } else if (/^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
        busy(true, 'Reading the image…');
        fresh = [await loadImage(file)];
      } else {
        fail('Pages can be added from a PDF or an image. A text file has no pages to add.');
        return;
      }
    } catch (error) {
      if (error && error.blindedCancelled) return;
      fail('That file could not be added: '
        + (error && error.message ? error.message : String(error)));
      return;
    } finally {
      busy(false);
    }

    const added = fresh.map(p => ({
      ...p,
      uid: nextPageUid++,
      source: p.canvas,
      canvas: null,
      findings: [],
      hits: [],
      imageHits: [],
      manual: [],
      dismissed: new Set(),
    }));
    const picked = pickedInOrder();
    const at = picked.length ? picked[picked.length - 1].index + 1 : state.pages.length;
    const next = state.pages.slice(0, at).concat(added, state.pages.slice(at));
    setOrder(next, added.length === 1 ? 'adding a page' : 'adding ' + added.length + ' pages');
  }

  // ---------- detection ----------

  function acceptedKinds() {
    return Array.from(state.enabled).filter(k => k !== 'term');
  }

  // Everything an enabled detector proposes is covered.
  //
  // There used to be a second switch here, "include lower-confidence matches",
  // and it asked the reviewer a question they had no way to answer: two
  // detectors were useless with it off and noisy with it on, and which was
  // which was not written anywhere. The tick box is gone and the detectors it
  // was propping up were tightened until they could stand without it — a
  // five-digit number is only a postal code now if something in the text says
  // so. Confidence still exists inside findAll, where it decides which of two
  // overlapping spans wins, but it is no longer a setting.
  function scanText(text) {
    return Detect.findAll(text, { kinds: acceptedKinds(), terms: state.terms });
  }

  // Recomputes everything downstream of the settings. Cheap enough to run on
  // every keystroke for documents of a sane size, and being always-consistent
  // is worth more than being clever about it.
  // `settled` means the question has not changed in a way that needs looking
  // again — taking a word off the list, for instance. What it found goes, and
  // what every other word found still stands.
  function rescan(options) {
    if (state.kind === 'text') {
      state.findings = scanText(state.text);
      drawTextView();
    } else {
      for (const page of state.pages) {
        page.findings = scanText(page.text);
        page.dismissed = new Set(Array.from(page.dismissed));
        page.hits = onePerPlace(page.findings.map(f => ({
          finding: f,
          rects: Boxes.boxesForSpans(page.items, [f], { advance: measure }),
        })));
        drawPage(page);
      }
    }
    markDuplicates();
    renderKinds();
    renderTermCounts();
    renderSectionNotes();
    applyLabels();
    // A rescan usually happens because the reviewer changed what should be
    // looked for — a term, a detector, the confidence setting — so what was
    // found no longer answers the question and the document goes back to
    // before the search. Removing a word is the exception: nothing new needs
    // finding, and sending the reviewer back to Search to be told the same
    // thing about the words they kept is a search they did not ask for.
    if (options && options.settled) markPending();
    else needsSearch();
  }

  // ---------- marking up, then redacting ----------

  // Anything that changes what would be covered puts the document back into
  // review. Appearance-only settings — how a placeholder is spelled, whether a
  // legend page is appended — deliberately do not, since they cannot make the
  // bars on screen wrong.
  // The document is no longer redacted, but what was found still stands.
  // Dismissing a mark, drawing a box by hand, undoing — review actions, which
  // change what gets covered rather than what was looked for.
  function markPending() {
    if (!state.applied) { refreshApply(); return; }
    state.applied = false;
    redrawAll();
    refreshApply();
  }

  // What to look for has changed, so what was found no longer answers it.
  // Back to the beginning: nothing is drawn until the reviewer asks again.
  function needsSearch() {
    state.searched = false;
    state.applied = false;
    state.openTally = null;
    // And the tallies go with it: they counted an answer to a question that
    // is no longer the one being asked.
    renderTermCounts();
    redrawAll();
    refreshApply();
  }

  // Whether a document still needs reading before its terms can be found.
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

    // One button, three states, and it says which one it is in: Search finds
    // things and proposes them, Redact covers what was proposed, and Redacted
    // is a state the reviewer can step back out of rather than a dead end.
    button.textContent = !state.searched ? 'Search'
      : state.applied ? 'Redacted' : 'Redact';
    // How many red question marks are on the panel right now. A word that no
    // search has counted yet and a picked image nothing has looked for each
    // draw one, and this is the same predicate the circles themselves render
    // from, so the two cannot disagree.
    const unanswered = state.terms.filter(t => !state.countedTerms.includes(t)).length
      + state.templates.filter(t => !t.searched).length;

    // The button wears the panel's red only while there is a red ? for it to
    // answer. Red with nothing outstanding is an alarm about nothing: the
    // reviewer who has just deleted their last word does not need the footer
    // shouting at them. With nothing to find it is an ordinary blue button,
    // which is what it will be for the next press anyway.
    button.classList.toggle('hunt', !state.searched && unanswered > 0);
    button.classList.toggle('done', state.applied);
    button.title = state.applied ? 'Press to uncover and look at the marks again' : '';
    // Not while the comprehensive check is running: it is a pass over the same
    // pages, and the two cannot both own the document. Stopping it is a button
    // in the panel, not a dialog thrown in front of this one.
    button.disabled = state.sweepRunning || (!state.searched
      ? state.kind !== 'text' && !state.pages.length
      : !state.applied && marks === 0 && unsearched === 0);
    if (state.sweepRunning) {
      button.title = 'The comprehensive check is running \u2014 let it finish, '
        + 'or stop it in the panel';
    }

    el('export').disabled = !state.applied || marks === 0;

    // The thorough sweep is offered on the back of a finished redaction, so
    // whether it shows at all follows the same state this button reflects.
    renderSweep();

    const note = el('exportnote');
    const unread = state.pages.filter(page => !page.ocrItems).length;
    if (state.sweepRunning) {
      note.textContent = 'The comprehensive check is running. Let it finish, or '
        + 'stop it in the panel.';
    } else if (!state.searched) {
      // Named by what the reviewer can see. Every word and every picked image
      // that nothing has looked for yet wears a red question mark in the
      // panel, and this is the button that answers them.
      // The mark itself, not a description of it. "2 red ? marks above" asks
      // the reviewer to translate a sentence into a thing on screen; showing
      // the thing skips the translation.
      note.textContent = '';
      if (unanswered === 0) {
        note.textContent = 'Press Search to find what is in this document.';
      } else {
        const mark = document.createElement('span');
        mark.className = 'qmark';
        mark.textContent = '?';
        // Read aloud as the sentence it stands in for, since a screen reader
        // announcing "question mark" says nothing about what is on the panel.
        mark.setAttribute('role', 'img');
        mark.setAttribute('aria-label', unanswered === 1
          ? 'one unanswered mark' : unanswered + ' unanswered marks');
        note.append(
          document.createTextNode(unanswered === 1 ? 'One ' : unanswered + ' '),
          mark,
          document.createTextNode(unanswered === 1
            ? ' above. Press Search to find it.'
            : ' above. Press Search to find them.'));
      }
    } else if (state.applied) {
      note.textContent = marks === 0 ? 'Nothing is covered.' : '';
    } else if (unread && unread < state.pages.length && ocrPending()) {
      // A paused run. Say how much of the document has actually been looked
      // at, because the marks on screen are the answer for part of it only.
      note.textContent = (state.pages.length - unread) + ' of ' + state.pages.length
        + ' pages read \u2014 press Search to carry on.';
    } else if (unsearched) {
      note.textContent = unsearched === 1
        ? '1 search still to run.'
        : unsearched + ' searches still to run.';
    } else if (marks === 0) {
      note.textContent = 'Nothing marked yet.';
    } else {
      note.textContent = 'Outlined \u2014 press Redact to cover them.';
    }
  }

  // How many things are currently marked, whether or not they have been
  // applied. Image matches only exist once their search has run.
  function plannedCount() {
    if (state.kind === 'text') {
      if (!state.searched) return 0;
      return state.findings.filter(f => !dismissedText.has(f.id)).length;
    }
    if (!state.searched) {
      return state.pages.reduce((sum, page) => sum + page.manual.length, 0);
    }
    return state.pages.reduce((sum, page) =>
      sum + page.hits.filter(h => !page.dismissed.has(h.finding.id)).length
        + liveImageHits(page).filter(m => !page.dismissed.has(m.id)).length
        + page.manual.length, 0);
  }

  // Runs every search that has not run yet and proposes what it found. This is
  // the first of the three presses; it does not cover anything.
  async function runSearch() {
    // The comprehensive check and a search are two passes over the same pages,
    // and they cannot both own the document. Pressing Search used to put a
    // dialog in the way offering to stop the check — a question asked at the
    // worst moment, about work the reviewer had not been thinking about. The
    // button is simply not pressable while the check runs, and the panel says
    // why and offers the Stop button that was always there.
    if (state.sweepRunning) return;

    state.redacting = true;
    state.paused = false;

    // The overlay goes up here rather than inside the reading pass.
    //
    // It used to be raised by readPages, which only runs when there are pages
    // left to read — so on a document already read, pressing the button did
    // nothing visible at all while several seconds of searching went by, and
    // then the marks simply appeared. From the outside that is a dead button.
    busy(true, 'Working…');
    refreshApply();

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
    const unread = state.pages.filter(p => !p.ocrItems).length;
    // The text leg covers both halves of the text work, because from the
    // outside they are one thing. On a document already read there is nothing
    // to read, but every page is still walked to match the words against it —
    // and showing only "Searching images" for a run that was plainly handling
    // a new word as well reads as the tool ignoring half of what was asked.
    const willRead = ocrPending() ? (unread || pages) : 0;
    const willSearch = pendingTemplates().length ? pages : 0;
    legs([
      // Named by what it is doing for the reviewer rather than by how. It
      // reads the pages, but what the reviewer asked for is the text found.
      { key: 'read', label: unread ? 'Searching text' : 'Matching words',
        total: willRead },
      { key: 'search', label: 'Searching images', total: willSearch },
    ]);
    // And a frame to actually draw it in. Everything below this line runs in
    // one go until it hits its own awaits, and the overlay that was just made
    // visible would not be on screen for any of it.
    await nextPaint();
    // Reading the pages comes first, because failing at it changes what else
    // has to run: the shape matcher is the fallback, so the list of templates
    // cannot be decided until it is known whether the reader worked.
    if (ocrPending()) {
      try {
        await readPages(done => leg('read', done));
        matchOcr(done => leg('read', done));
        markDuplicates();
        renderTermCounts();
        renderSectionNotes();
      } catch (error) {
        // Not an error to report and stop on. The reader is an optimisation
        // over hunting for the word's shape, and the shape search still works,
        // so fall back to it and say so rather than leaving the reviewer with
        // an alert and no marks.
        state.ocrFailed = true;
        state.useOcr = false;
        showWordControls();
        console.warn('the page reader could not be loaded', error);
      }
      // Deliberately not lowered here. The overlay belongs to the whole run,
      // and this pass is the first half of it: taking it down between reading
      // and searching left the second half with nothing on screen, which is
      // exactly what a dead button looks like. It comes down once, at the end
      // of the run, however the run ends.
    }

    // A paused run stops here rather than going on to the image search, and
    // does not claim the document is redacted: the marks found so far are
    // shown, still red, and Redact picks up where it left off.
    if (state.paused) {
      state.paused = false;
      state.redacting = false;
      busy(false);
      redrawAll();
      refreshApply();
      return;
    }

    const entries = pendingTemplates();
    try {
      if (entries.length) await runSearches(entries, done => leg('search', done));
    } catch (error) {
      state.redacting = false;
      busy(false);
      alert('The image search could not finish: ' + (error && error.message ? error.message : error));
      return;
    }
    // Found, proposed, and drawn — but not covered. Covering is the next
    // press, so that the reviewer sees what is about to disappear before it
    // does, which is the whole point of reviewing.
    state.searched = true;
    // Which words this search answered. A word added afterwards has no number
    // yet, and must not borrow the confidence of the ones that do.
    state.countedTerms = state.terms.slice();
    state.redacting = false;
    // The word list shows a tally only once something has counted, so it has
    // to be redrawn when that becomes true.
    renderTermCounts();
    // And the image rows, whose sliders may have moved themselves: a bar that
    // came down without the control following it would be a reading that
    // disagrees with the thing it reads.
    renderTemplates();
    // Whatever ran or did not run below, the overlay comes down here: the
    // passes each lower it on their own way out, and a search where neither
    // had anything to do would otherwise leave it up for good.
    busy(false);
    applyLabels();
    redrawAll();
    refreshApply();
  }

  // One frame, so that something just made visible is actually on screen
  // before the next stretch of work begins.
  function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    }));
  }

  // The second press: what was proposed becomes what is covered. No work,
  // just a decision — everything was found by the search.
  function coverMarks() {
    if (!state.searched) return;
    state.applied = true;
    applyLabels();
    redrawAll();
    refreshApply();
  }

  // And the third: stepping back out of it. "Redacted" is a state, not a dead
  // end — a reviewer who wants one more look at what a bar is covering should
  // not have to redo the search to get it.
  function uncoverMarks() {
    if (!state.applied) return;
    state.applied = false;
    redrawAll();
    refreshApply();
  }

  // Which of the three the button means this time.
  async function applyButton() {
    if (state.applied) { uncoverMarks(); return; }
    if (state.searched) { coverMarks(); return; }
    await runSearch();
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

  // ---------- reading the pages ----------
  //
  // OCR runs once per document and is kept: the words on a page do not change
  // when the reviewer edits the terms list, so re-reading would be pure cost.
  // Matching those words against the terms is cheap and rerun freely.
  async function readPages(report) {
    const progress = report || ((done, of) => pageProgress(done, of, 'Searching text'));
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
    // wanted. The overlay used to say so, from when this was an optional extra
    // a reviewer had just switched on and might wonder about. It is not
    // optional any more, the bar below says which page it is on, and a size in
    // megabytes is not something a reviewer can do anything with.
    const alreadyDone = total - outstanding.length;
    busy(true, 'Working…');
    progress(0, outstanding.length);
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

  function describeTime(seconds) {
    if (seconds < 90) {
      const whole = Math.max(1, Math.round(seconds));
      return whole + (whole === 1 ? ' second' : ' seconds');
    }
    const minutes = Math.round(seconds / 60);
    return minutes + (minutes === 1 ? ' minute' : ' minutes');
  }

  // Terms found in what OCR read, as the same kind of proposal the picture
  // search produces — keyed to the word, so a placeholder is shared with the
  // written occurrences and duplicates are folded together.
  function matchOcr(report) {
    let done = 0;
    for (const page of state.pages) {
      // Everything this function owns is rebuilt from the current terms, so
      // the old set goes first — but the thorough sweep's marks are not this
      // function's to throw away. They cost minutes to find, and wiping them
      // here meant a reviewer who edited one word and pressed Redact lost
      // every amber mark while the note still said they were on the page.
      page.imageHits = page.imageHits.filter(m => !m.term || m.bySweep);
      done++;
      if (report) report(done);
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
      entries.push({ key: 'logo:' + template.id, template: template.cut, logo: template,
                     // Its own bar, not a shared one: this is the whole point
                     // of the slider sitting on the row.
                     threshold: sensFor(template) });
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
    const progress = report || ((done, of) => pageProgress(done, of, 'Searching images'));
    progress(0, state.pages.length);
    allowPause();
    let results;
    try {
      // No shared threshold: every entry carries its own — a picked image from
      // its row's slider, a word from what its shape is worth.
      results = await ImageSearch.searchAllParallel(state.pages, entries, {},
        (done, total) => progress(done, total));
    } finally {
      busy(false);
    }

    // Logos: one entry each, so the results land directly.
    for (const entry of entries.filter(e => e.logo)) {
      const found = results.get(entry.key);

      // Nothing at the bar it was set to, but something just under it.
      //
      // The reviewer has no way to know where to put a slider before the
      // first search — 0.75 is a starting point, not an answer — and being
      // told "no match" about a mark that is plainly on the page is the
      // wrong end of the exchange. Every candidate here has already been
      // verified at full resolution, so lowering the bar costs nothing: the
      // answer is already in hand, on the wrong side of a number.
      //
      // Only when the search found nothing. A bar that found something is a
      // bar the reviewer is entitled to keep, and moving it under them would
      // overrule a decision they made.
      const autoBar = lowerBarIfEmpty(found, sensFor(entry.logo));
      if (autoBar !== null) {
        entry.logo.sens = autoBar;
        entry.logo.autoBar = autoBar;
      }

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
      reportSearch(found, sensFor(entry.logo), autoBar);
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
  function reportSearch(found, bar, autoBar) {
    const hint = el('pickhint');
    // A match that worked needs no commentary: the marks are on the page and
    // the count is beside the picked image. What is worth saying is what
    // happened when nothing matched, which is below.
    if (found.matches.length) {
      // What the matches scored, worst first in the reviewer's mind: the
      // weakest one is the number the bar has to clear to drop it.
      //
      // Measured on a deck whose footnotes are circular letter badges: the F
      // badges scored 1.00 down to 0.948 and the E badges beside them 0.927.
      // Two hundredths apart, and nothing on screen said so — the reviewer
      // moved the slider, re-ran, counted boxes and guessed again. The numbers
      // were there the whole time.
      const scores = found.matches.map(m => m.score);
      const low = Math.min(...scores), high = Math.max(...scores);
      let text = found.matches.length === 1
        ? 'One match, scoring ' + high.toFixed(2) + '.'
        : found.matches.length + ' matches, scoring ' + high.toFixed(2)
          + ' down to ' + low.toFixed(2) + '.';

      // And what the bar turned away, which is the half that tells a reviewer
      // where to put it. Looking at two marks where seven were expected, the
      // useful fact is not that both scored 0.99 — it is that five more scored
      // 0.95 down to 0.93 and are one nudge of the slider away.
      // Only the ones close enough to be worth a nudge. A picked mark turns up
      // dozens of weak echoes of itself all over a page — 0.67 against a bar
      // of 0.99 is not a near miss, and counting it in makes the sentence say
      // "30 more" when five of them are the point.
      //
      // Measured from the bar, not from the weakest match that cleared it.
      // Those are different numbers whenever the matches sit well above the
      // setting — one copy at 1.00 against a bar of 0.93 left a window that
      // started at 0.92, so a match at 0.919 that the bar had turned away by
      // a hundredth was reported as nothing at all.
      const NEARLY = 0.08;
      const near = (found.near || [])
        .map(hit => hit.score)
        .filter(s => s >= clampSens(bar) - NEARLY)
        .sort((a, b) => b - a);
      if (near.length) {
        const top = near[0], bottom = near[near.length - 1];
        text += ' ' + near.length + (near.length === 1 ? ' more scored ' : ' more scored ')
          + (near.length === 1 || top.toFixed(2) === bottom.toFixed(2)
            ? top.toFixed(2)
            : top.toFixed(2) + ' down to ' + bottom.toFixed(2))
          + ' and ' + (near.length === 1 ? 'was' : 'were')
          + ' left out — lower the bar past ' + top.toFixed(2) + ' to include '
          + (near.length === 1 ? 'it.' : 'them.');
      }
      // And when it turned nothing away, say so — because the silence looks
      // like an omission.
      //
      // "15 matches, scoring 0.99 down to 0.78" beside a slider reading 0.75
      // invites the obvious question: is 0.78 the real setting, and why is the
      // control saying something else? It is not. The bar is a floor, 0.78 is
      // simply where the weakest true match happened to land, and the space
      // between them is empty — which is worth knowing, because it is room the
      // bar can move into without losing anything.
      if (!near.length && low - clampSens(bar) > 0.015) {
        text += ' Nothing landed between the bar at ' + clampSens(bar).toFixed(2)
          + ' and the weakest of these, so it has room to move up.';
      }

      if (autoBar !== null && autoBar !== undefined) {
        text = 'Nothing matched at the setting it was on, so the bar came down '
          + 'to ' + autoBar.toFixed(2) + '. ' + text
          + ' Move the slider if that is not what you wanted.';
      }
      hint.textContent = text;
      hint.hidden = false;
      hint.classList.remove('warnhint');
      return;
    }
    const near = found.best > 0 ? found.best.toFixed(2) : null;
    hint.textContent = near
      ? 'No match at ' + clampSens(bar).toFixed(2) + '. The closest thing scored '
        + near + ' — lower the sensitivity below that to include it.'
      : 'Nothing resembling that was found anywhere in the document.';
    hint.hidden = false;
    hint.classList.add('warnhint');
  }

  // Where the bar wants to be, read off what the search actually saw.
  //
  // A picked mark scores near 1.00 against its own copies and drops away
  // sharply against everything else, so the scores arrive in clumps with a
  // gap between them. The bar belongs in the widest gap: above it are the
  // copies, below it is the rest of the document.
  //
  // Never below this floor, however tempting the gap. Correlation at 0.6 will
  // find something resembling almost anything, and a redaction tool that
  // quietly covers whatever it likes is worse than one that finds nothing and
  // says so.
  const AUTO_FLOOR = 0.62;

  // How wide a gap has to be before it is a gap rather than the ordinary
  // scatter between copies of one mark.
  const REAL_GAP = 0.03;

  function barFromScores(scores) {
    const sorted = scores.filter(s => s >= AUTO_FLOOR).sort((a, b) => b - a);
    if (!sorted.length) return null;
    // One candidate, or several with no gap worth speaking of: take them all,
    // just under the weakest. A clump of copies of the same mark scores within
    // a hundredth or two of itself, and splitting that on the widest of
    // several tiny gaps would keep one copy and drop the rest for no reason
    // anyone could see.
    let cut = sorted[sorted.length - 1];
    let widest = REAL_GAP;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i] - sorted[i + 1];
      if (gap > widest) { widest = gap; cut = sorted[i]; }
    }
    // A hundredth of clearance, and rounded to where the slider can actually
    // stand — a bar the reviewer cannot reproduce by moving the control is a
    // bar they cannot undo.
    const bar = Math.max(AUTO_FLOOR, Math.floor((cut - 0.005) * 100) / 100);
    return Math.min(0.99, bar);
  }

  // Moves the bar down to whatever the search actually saw, and promotes the
  // candidates it had turned away. Returns the new bar, or null for "leave it
  // alone" — which is the answer whenever the search found something, because
  // a bar that found something is a bar the reviewer is entitled to keep.
  //
  // `found` is edited in place: the promoted hits move from near to matches.
  // They must move rather than be copied, or the note below ends up saying
  // "4 matches, and 4 more were left out" about one set of four.
  function lowerBarIfEmpty(found, bar) {
    if (found.matches.length) return null;
    if (!found.near || !found.near.length) return null;
    const suggested = barFromScores(found.near.map(hit => hit.score));
    if (suggested === null || suggested >= bar) return null;
    found.matches = found.near.filter(hit => hit.score >= suggested);
    found.near = found.near.filter(hit => hit.score < suggested);
    return suggested;
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
    set('kind-note', kinds + ' of ' + Detect.KINDS.length, false);

    if (el('organise-note')) refreshSheetBar();

    set('label-note', state.labelling
      ? (state.labels.entries.length || 0) + ' labels'
      : 'off', state.labelling);
  }

  // One mark per place on the page.
  //
  // A slide deck exported to PDF can carry the same text run many times over,
  // stacked at identical coordinates — a shape duplicated, a shadow drawn as a
  // second copy of the words, a layer left behind by whatever made the file.
  // Measured on one page of a real deck: the word appeared six times to a
  // reader and thirty-two times in the text layer, one spot carrying eleven
  // copies of itself.
  //
  // Every copy is a true find, so none of them is wrong — but they are all the
  // same occurrence, and the reviewer gets one box drawn eleven times (which
  // is why the outline looked doubled) and a list of eleven identical page
  // numbers to check.
  //
  // The first one at each place stands and the rest are dropped, before
  // anything downstream counts them, labels them or lets them be dismissed
  // one at a time.
  const SAME_PLACE = 0.92;

  function onePerPlace(hits) {
    const kept = [];
    for (const hit of hits) {
      const here = hit.rects && hit.rects[0];
      // A finding with no box on the page cannot be a duplicate of one, and
      // must not be dropped: it still counts, and the tally says where it is.
      if (!here) { kept.push(hit); continue; }
      const already = kept.some(other => {
        const there = other.rects && other.rects[0];
        if (!there) return false;
        // Both ways round: the same word at the same size in the same spot,
        // not merely one sitting inside another.
        return Match.coveredFraction(here, there) > SAME_PLACE
          && Match.coveredFraction(there, here) > SAME_PLACE;
      });
      if (!already) kept.push(hit);
    }
    return kept;
  }

  // ---------- one occurrence, one mark ----------

  // How much of a mark must already be covered for it to be the same find.
  //
  // Measured against the mark's own area, so this is "nearly all of me is
  // inside that" and the number has to be near one. It was a half, from when
  // the question was asked as a fraction of whichever box was smaller — and at
  // a half a logo whose wordmark was separately redacted came out 0.64
  // covered, was called a duplicate of the word, and vanished. The third of it
  // that stuck out was the company's red triangle, left showing on every page.
  //
  // A tenth of slack, for a box drawn a few pixels differently around the same
  // thing. Anything more than that sticking out is something the bar is not
  // covering, and a mark that covers it is not a duplicate.
  const SAME_MARK = 0.9;

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

      // Superseded means "already covered", and that is a question about this
      // match's own area — how much of it lies inside something else — not
      // about the overlap as a fraction of whichever box is smaller.
      //
      // The difference is the whole bug. Redacting the word "VinaCapital" and
      // the VinaCapital logo, the word's mark sat inside the logo's: measured
      // against the smaller box that is a perfect overlap, so all four logo
      // matches were dropped as duplicates of it. The panel said "4 matches"
      // and the tally said 0, and on the page the wordmark was covered while
      // the red triangle beside it was left showing.
      const kept = [];
      for (const match of page.imageHits) {
        const overText = textRects.some(
          rect => Match.coveredFraction(match.rect, rect) > SAME_MARK);
        const overImage = kept.some(
          other => Match.coveredFraction(match.rect, other.rect) > SAME_MARK);
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
    for (const page of state.pages) if (isLive(page)) drawPage(page);
    if (state.kind === 'text') drawTextView();
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
      for (const f of all) tally[f.kind] = (tally[f.kind] || 0) + 1;
    }
    return tally;
  }

  function renderKinds() {
    const tally = countsByKind();
    // Only the detectors are listed. Words the reviewer typed were once a
    // tenth row with a tick box of its own, which invited exactly one
    // question — why would I type a word and then ask for it not to be
    // covered? Typing a word is the instruction; there is nothing left to
    // agree to. It is always on, and the terms box above shows its own count.
    const rows = Detect.KINDS;
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

  // The panel used to end with a tally of everything — so many text matches,
  // so many image matches, so many boxes you drew. Every one of those numbers
  // is already beside the thing it counts, and a second copy of them in a
  // different order at the foot of the panel was one more thing to read and
  // one more thing to keep in step. Whether Export is available was never
  // decided here; refreshApply owns that, because it depends on the phase
  // rather than only on the count.

  // ---------- page rendering ----------

  // How many pages is more than this was built for.
  //
  // Each page keeps its rendered pixels for as long as the document is open —
  // that is what a redaction is measured against — and at about seven and a
  // half megabytes a page it adds up. The on-screen copies are given back when
  // they scroll away, but the pages themselves cannot be: measured, a sixty
  // page document sits at 456 MB. Past a few hundred pages a tab will die, and
  // dying halfway through a review is worse than being told first.
  const MANY_PAGES = 250;

  async function warnIfHuge(pages) {
    if (pages <= MANY_PAGES) return;
    busy(false);
    await confirmAction({
      title: 'That is a long document',
      body: pages + ' pages. Every page is kept as an image for as long as the '
        + 'document is open, which is roughly '
        + Math.round(pages * 7.5 / 100) / 10 + ' GB of memory, and the tab may '
        + 'run out and close. Redacting it in parts is safer.',
      confirmLabel: 'Carry on anyway',
    });
  }

  // ---------- what is actually held in memory ----------
  //
  // Every page used to keep two canvases at the full rendered resolution: the
  // pristine source and an on-screen copy the same size. Measured on a sixty
  // page document that is 888 MB of bitmap, 14.8 MB a page, from a PDF of
  // nineteen kilobytes — and it grows with the document until the tab dies.
  //
  // Two things fix it, and neither may touch `source`. That canvas is what a
  // redaction is measured against and what the export flattens; it stays
  // exactly as it was. What changes is the copy on screen:
  //
  //   it is sized to how big it is actually displayed, not to the source —
  //   1224 pixels of bitmap were being shown in a box 796 wide — and
  //
  //   pages far from the viewport give theirs up altogether, and get it back
  //   when they come near.
  //
  // Everything drawn into it is still in source coordinates; drawPage scales
  // once at the top and the rest of the drawing code is untouched.
  const NEAR_PAGES = 2;

  // How wide the on-screen copy should be. Capped at the source, because
  // drawing a page larger than it was rendered buys nothing but memory.
  function displayWidthFor(page) {
    const wrap = page.canvas && page.canvas.parentElement;
    const css = wrap ? wrap.getBoundingClientRect().width : 0;
    const dpr = window.devicePixelRatio || 1;
    const wanted = Math.round((css || 800) * dpr);
    return Math.max(1, Math.min(page.source.width, wanted));
  }

  // Gives a page its bitmap, at the size it is being shown. Returns whether
  // anything changed, so a caller can avoid a needless redraw.
  function fitCanvas(page) {
    if (!page.canvas) return false;
    const width = displayWidthFor(page);
    const height = Math.max(1, Math.round(width * (page.source.height / page.source.width)));
    if (page.canvas.width === width && page.canvas.height === height) return false;
    page.canvas.width = width;
    page.canvas.height = height;
    return true;
  }

  // Takes it away again. The wrapper keeps its shape because its aspect ratio
  // is set from the source, so the document does not shudder as pages come and
  // go and a scroll position stays where the reviewer put it.
  function releaseCanvas(page) {
    if (!page.canvas || !page.canvas.width) return;
    page.canvas.width = 0;
    page.canvas.height = 0;
  }

  function isLive(page) {
    return Boolean(page.canvas && page.canvas.width > 0);
  }

  // Which pages are worth holding. Near the viewport, plus a margin either
  // side so that scrolling meets a drawn page rather than a blank one.
  function updateLivePages() {
    if (!state.pages.length) return;
    // The window the reviewer is actually looking through, which is the
    // scrolling column — not the list of pages inside it, whose box is the
    // whole document and would call every page near.
    const stage = el('pages').closest('.stage');
    const view = stage
      ? stage.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight, height: window.innerHeight };
    let first = Infinity;
    let last = -Infinity;
    for (const page of state.pages) {
      const wrap = page.canvas && page.canvas.parentElement;
      if (!wrap) continue;
      const box = wrap.getBoundingClientRect();
      // A screen either side of what is on screen, so that a flick of the
      // wheel meets a drawn page rather than a blank one.
      if (box.bottom >= view.top - view.height && box.top <= view.bottom + view.height) {
        first = Math.min(first, page.index);
        last = Math.max(last, page.index);
      }
    }
    if (first === Infinity) { first = 0; last = 0; }
    first = Math.max(0, first - NEAR_PAGES);
    last = Math.min(state.pages.length - 1, last + NEAR_PAGES);

    for (const page of state.pages) {
      const near = page.index >= first && page.index <= last;
      if (!near) { releaseCanvas(page); continue; }
      const wasBlank = !isLive(page);
      if (fitCanvas(page) || wasBlank) drawPage(page);
    }
  }

  function buildPageElements() {
    const host = el('pages');
    host.textContent = '';

    for (const page of state.pages) {
      const wrap = document.createElement('div');
      wrap.className = 'page';
      // The wrapper holds the shape, so releasing a canvas does not collapse
      // the document under the reviewer's scroll position.
      wrap.style.aspectRatio = page.source.width + ' / ' + page.source.height;

      const canvas = document.createElement('canvas');
      page.canvas = canvas;

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = 'Page ' + (page.index + 1);

      wrap.append(canvas, num);
      host.append(wrap);
      attachDrawing(page, canvas);
    }
    // Once, now, so the first pages are drawn — and again after a frame, when
    // the wrappers have been laid out and it is possible to tell which pages
    // are actually on screen. Before layout every box is at zero and every
    // page looks near.
    updateLivePages();
    requestAnimationFrame(() => updateLivePages());
  }

  function activeBoxes(page) {
    // Before the search has run there is nothing to show but what the reviewer
    // drew themselves. Everything else would be an answer to a question they
    // have not asked yet — and while they were still typing a word, an answer
    // to half of it.
    //
    // The comprehensive check's marks are no exception: they answered the
    // search that has just been set aside, so they come off the page with
    // everything else. They are not thrown away, though — the next search
    // keeps them and puts them back, because re-running a check that takes
    // minutes to say the same thing is not a reasonable price for moving a
    // slider.
    if (!state.searched) return page.manual.map(box => ({ ...box }));

    const live = page.hits.filter(h => !page.dismissed.has(h.finding.id));
    const images = liveImageHits(page).filter(m => !page.dismissed.has(m.id));

    if (!state.labelling) {
      // Merged across findings, which closes the gaps between adjacent bars.
      return Boxes.boxesForSpans(page.items, live.map(h => h.finding), { advance: measure })
        // The flag rides along with the rect: this is the path the page draws
        // through unless labelling is on, so dropping it here would mean the
        // sweep's marks were amber only for reviewers using placeholders.
        .concat(images.map(m => ({ ...m.rect, sweep: Boolean(m.bySweep) })))
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
      boxes.push({ ...match.rect, label: state.labels.byId[match.id],
                   sweep: Boolean(match.bySweep) });
    }
    for (const box of page.manual) {
      boxes.push({ ...box, label: state.labels.byId[box.id] });
    }
    return boxes;
  }

  function drawPage(page, preview) {
    // A page that has given up its bitmap has nothing to draw on. Its marks
    // live in the state, not in the canvas, so it loses nothing by waiting:
    // updateLivePages draws it when it comes back.
    if (!page.canvas || !page.canvas.width) return;

    const ctx = page.canvas.getContext('2d', { alpha: false });
    // One transform, and then every coordinate below is the page's own. The
    // canvas may be smaller than the page it shows.
    const scale = page.canvas.width / page.source.width;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // Stroke widths are given in the page's units, so the transform would thin
    // them along with everything else and an outline drawn two pixels wide
    // would land at one. This converts a width in screen pixels back into
    // page units, so a mark looks the same as it always did.
    const stroke = device => Math.max(0.5, device) / scale;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, page.source.width, page.source.height);
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
      ctx.lineWidth = stroke(Math.max(2, page.source.width / 600));
      for (const box of boxes) {
        // Amber for what the thorough check added, green for everything else.
        // Both will be covered when Redact is pressed — the colour says where
        // the mark came from, not whether it counts. A reviewer who has just
        // asked "did you miss anything" needs the answer to be visible on the
        // page without hunting for it.
        //
        // Green rather than red, which is what these were. Red is the colour
        // of a mistake, and a proposed redaction is the opposite: it is the
        // tool doing what it was asked. A page of red boxes over someone's
        // document reads as a page of errors.
        ctx.strokeStyle = box.sweep ? '#d98b1f' : MARK_GREEN;
        ctx.fillStyle = box.sweep ? 'rgba(217, 139, 31, 0.18)' : MARK_GREEN_FILL;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
      }
      ctx.restore();
    }

    // Dismissed marks: the same outline, dashed, so a mistaken dismissal is
    // obvious and can be clicked back on.
    //
    // In the same colour it was drawn in, which it was not: everything
    // dismissed came out amber, so clicking a green mark off turned it into
    // something that looked like a find from the comprehensive check. Dashed
    // is what says "not going to be covered"; the colour goes on saying where
    // the mark came from.
    //
    // And only while the marks are still a proposal. Once Redact is pressed
    // the page is meant to be what the file will be, and a dashed box round a
    // word that is still there — and still readable — is a mark on a document
    // that has none.
    const off = state.applied ? [] : page.hits.filter(h => page.dismissed.has(h.finding.id));
    const offImages = state.applied
      ? [] : liveImageHits(page).filter(m => page.dismissed.has(m.id));
    if (off.length || offImages.length) {
      ctx.save();
      ctx.lineWidth = stroke(Math.max(1.5, page.source.width / 700));
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = MARK_GREEN;
      for (const hit of off) for (const r of hit.rects) ctx.strokeRect(r.x, r.y, r.w, r.h);
      for (const m of offImages) {
        ctx.strokeStyle = m.bySweep ? '#d98b1f' : MARK_GREEN;
        ctx.strokeRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
      }
      ctx.restore();
    }

    if (preview) {
      ctx.save();
      ctx.strokeStyle = MARK_GREEN;
      ctx.fillStyle = 'rgba(17, 138, 78, 0.2)';
      ctx.lineWidth = stroke(Math.max(2, page.source.width / 600));
      ctx.fillRect(preview.x, preview.y, preview.w, preview.h);
      ctx.strokeRect(preview.x, preview.y, preview.w, preview.h);
      ctx.restore();
    }
  }

  // ---------- drawing and clicking on a page ----------

  // Is this drag drawing a box, or moving the page?
  //
  // Picking a logo is always a drag-a-box gesture whatever the tool says: the
  // reviewer has just pressed a button that asks them to draw one, and
  // refusing to because the hand tool is selected would be obtuse.
  function marking() {
    return state.mode === 'pick' || state.tool === 'mark';
  }

  // What actually scrolls under this canvas.
  //
  // It used to be the window, and the hand tool simply called scrollBy on it.
  // Once the document got a scrolling column of its own that stopped moving
  // anything, so the element is found rather than assumed.
  function scrollerFor(node) {
    for (let at = node.parentElement; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      const scrolls = /(auto|scroll)/.test(style.overflowY + ' ' + style.overflowX);
      if (scrolls && (at.scrollHeight > at.clientHeight || at.scrollWidth > at.clientWidth)) {
        return at;
      }
    }
    return window;
  }

  function attachDrawing(page, canvas) {
    let start = null;
    let panning = null;

    // Every pointer position is converted to the page's own pixels — the
    // source, not the canvas showing it. Those were the same size once, and
    // taking the canvas as the reference worked by coincidence; now that the
    // view is scaled to how big it is actually displayed, a mark measured
    // against it would be placed wrong by exactly that scale.
    const at = event => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (page.source.width / rect.width),
        y: (event.clientY - rect.top) * (page.source.height / rect.height),
      };
    };

    canvas.addEventListener('pointerdown', event => {
      // A second finger turns whatever was happening into a pinch. Whatever
      // the first one had started — a pan, half a box — is abandoned, because
      // finishing it with the hand that is now zooming is not what anyone
      // meant.
      if (pinching()) { panning = null; start = null; drawPage(page); return; }
      if (!marking()) {
        // Screen coordinates, not canvas ones: this moves the window, and the
        // relationship between the two changes as it moves.
        panning = { x: event.clientX, y: event.clientY };
        try { canvas.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
        return;
      }
      start = at(event);
      // Capture keeps a drag alive if the pointer leaves the canvas, but it
      // throws for a pointer the browser is not currently tracking. That must
      // not take the rest of the handler down with it — losing `start` would
      // mean the drag silently never began.
      try { canvas.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
    });

    canvas.addEventListener('pointermove', event => {
      if (pinching()) { panning = null; start = null; return; }
      if (panning) {
        const dx = panning.x - event.clientX;
        const dy = panning.y - event.clientY;
        const scroller = scrollerFor(canvas);
        if (scroller === window) window.scrollBy(dx, dy);
        else { scroller.scrollLeft += dx; scroller.scrollTop += dy; }
        panning = { x: event.clientX, y: event.clientY };
        return;
      }
      if (!start) return;
      const now = at(event);
      drawPage(page, Boxes.rectFromDrag(start.x, start.y, now.x, now.y));
    });

    canvas.addEventListener('pointerup', event => {
      // Lifting one finger of a pinch is not a click, and must not dismiss a
      // mark or leave a box behind.
      if (pinching()) { panning = null; start = null; return; }
      // A drag that moved the page leaves nothing behind, and neither does a
      // click while the hand is held: nothing on the page changes unless the
      // reviewer has asked for the tool that changes it.
      if (panning) { panning = null; return; }
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
        // Shown back before it is used. What was drawn at reviewing size is a
        // few dozen pixels, and the difference between a box that fits and one
        // that clips the mark is not visible there.
        confirmCrop(page, rect).then(chosen => {
          if (chosen) addTemplate(page, chosen);
          else drawPage(page);
        });
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
    });

    canvas.addEventListener('pointercancel', () => { start = null; panning = null; drawPage(page); });
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

  // Where a newly picked image starts. It used to be a slider at the foot of
  // the Images section governing every picked image at once, which meant two
  // things a reviewer never asked for: a wordmark that matches cleanly at 0.85
  // and a scanned signature that needs 0.60 could not both be set right, and
  // moving the slider to tune one threw away the finished results for all the
  // others. Each image now carries its own bar, on its own row.
  const DEFAULT_SENS = Match.THRESHOLD;

  function clampSens(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_SENS;
    return Math.min(0.99, Math.max(0.45, n));
  }

  // The bar a picked image has to clear. Older drafts have no per-image value,
  // so they fall back to what the one slider was set to when they were saved.
  function sensFor(template) {
    return clampSens(template && template.sens !== undefined
      ? template.sens : DEFAULT_SENS);
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

  // ---------- one thing at a time, on a small screen ----------
  //
  // Side by side, the panel and the document each got about 300 pixels of a
  // phone. On a narrow screen one of them is open and the other is a strip
  // down the side, tapped or swiped to trade places — a strip rather than
  // nothing at all, because a pane that vanishes is a pane you have to
  // remember is there.
  const NARROW = '(max-width: 900px)';

  function onPhone() {
    return window.matchMedia(NARROW).matches;
  }

  function setPane(name) {
    const pane = name === 'doc' ? 'doc' : 'edit';
    state.pane = pane;
    document.body.dataset.pane = pane;
    const narrow = onPhone();
    // Each strip is the way back to the half it names, so it shows only while
    // that half is shut.
    el('peek-edit').hidden = !narrow || pane === 'edit';
    el('peek-doc').hidden = !narrow || pane === 'doc';
    // The document column has no size while it is a strip, so every page gave
    // up its bitmap; coming back needs them drawn again.
    if (pane === 'doc') updateLivePages();
  }

  // The toolbar belongs above both halves on a phone, because which half is
  // open has no bearing on wanting to undo something or zoom in — and because
  // it would otherwise be inside the panel, and the panel is sometimes a strip
  // 46 pixels wide. Moved rather than duplicated: two copies would be two sets
  // of the same ids and two sets of listeners to keep in step.
  function placeToolbar() {
    const head = document.querySelector('.panel-head');
    const review = el('view-review');
    const panel = document.querySelector('.panel');
    if (!head || !review || !panel) return;
    if (onPhone()) {
      if (head.parentElement !== review) {
        head.classList.add('afloat');
        review.insertBefore(head, review.firstChild);
      }
    } else if (head.parentElement !== panel) {
      head.classList.remove('afloat');
      panel.insertBefore(head, panel.firstChild);
    }
  }

  // Swiping between them.
  //
  // Deliberately not any horizontal drag: with the hand tool a drag across a
  // page is a pan, and stealing that would make a zoomed-in document
  // impossible to move around. So a swipe counts when it starts anywhere but
  // on a page — the panel, the strip, the gap — or when it starts at the very
  // edge of the screen, which is the gesture everybody already knows.
  const SWIPE_MIN = 55;
  const EDGE = 28;

  function watchSwipes() {
    const review = el('view-review');
    let from = null;

    review.addEventListener('pointerdown', event => {
      if (!onPhone()) return;
      const onPage = event.target.closest && event.target.closest('.page');
      const fromEdge = event.clientX <= EDGE
        || event.clientX >= window.innerWidth - EDGE;
      if (onPage && !fromEdge) { from = null; return; }
      from = { x: event.clientX, y: event.clientY };
    });

    review.addEventListener('pointerup', event => {
      if (!from) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      from = null;
      // Sideways, and decisively so: a scroll that wanders is not a swipe.
      if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      setPane(dx < 0 ? 'doc' : 'edit');
    });

    review.addEventListener('pointercancel', () => { from = null; });
  }

  // Zooming.
  //
  // The pages are drawn at the width of the column and scaled from there, so
  // this changes nothing about the canvases themselves — a mark is still
  // measured in the page's own pixels, and a reviewer who leans in to check a
  // bar is looking at the same bar that will be burned in.
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

  // The colour of a proposed redaction. Red once, which read as a page full of
  // mistakes; a proposal is the tool doing what it was asked.
  const MARK_GREEN = '#118a4e';
  const MARK_GREEN_FILL = 'rgba(17, 138, 78, 0.13)';

  // Which page the reviewer is looking at, and how far down it, so zooming can
  // put them back there.
  //
  // Every page changes height when the zoom does, so a scroll position measured
  // in pixels means something different afterwards: on a hundred-page document
  // the same scrollTop that showed page nine shows page seven once the pages
  // grow, and leaning in to look closer at something takes you somewhere else
  // entirely. The position is remembered as a page and a fraction down it,
  // which survives the resize.
  function anchorOn(scroller) {
    const pages = [...el('pages').children];
    if (!pages.length) return null;
    const edge = scroller === window ? 0 : scroller.getBoundingClientRect().top;
    // The page under the top edge of the view, or the first one below it if the
    // view is in the gap between two.
    let found = pages[0];
    for (const page of pages) {
      const box = page.getBoundingClientRect();
      found = page;
      if (box.bottom > edge) break;
    }
    const box = found.getBoundingClientRect();
    return { page: found, into: box.height ? (edge - box.top) / box.height : 0 };
  }

  function returnTo(anchor, scroller) {
    if (!anchor || !anchor.page.isConnected) return;
    const edge = scroller === window ? 0 : scroller.getBoundingClientRect().top;
    const box = anchor.page.getBoundingClientRect();
    const by = box.top + anchor.into * box.height - edge;
    if (!by) return;
    if (scroller === window) window.scrollBy(0, by);
    else scroller.scrollTop += by;
  }

  function setZoom(zoom) {
    const wanted = ZOOM_STEPS.reduce((best, step) =>
      Math.abs(step - zoom) < Math.abs(best - zoom) ? step : best, ZOOM_STEPS[0]);
    const scroller = scrollerFor(el('pages'));
    const was = state.zoom === wanted ? null : anchorOn(scroller);
    state.zoom = wanted;
    el('pages').style.setProperty('--zoom', String(wanted));
    // Zooming changes how big a page is shown, so it changes how much bitmap
    // is worth holding. Without this, leaning in would enlarge a canvas that
    // had been sized for the smaller view and show it soft.
    updateLivePages();
    // After the pages have their new size, not before.
    returnTo(was, scroller);
    el('zoom-out').disabled = wanted === ZOOM_STEPS[0];
    el('zoom-in').disabled = wanted === ZOOM_STEPS[ZOOM_STEPS.length - 1];
    const percent = Math.round(wanted * 100) + '%';
    el('zoom-in').title = 'Zoom in (now ' + percent + ')';
    el('zoom-out').title = 'Zoom out (now ' + percent + ')';
  }

  // ---------- pinching the document ----------
  //
  // Two fingers on the document mean the document, not the app around it. The
  // browser's own pinch is turned off in the viewport tag, so this is the only
  // thing that answers the gesture — and only here: a pinch on the panel, the
  // toolbar or the header now does nothing, which is the point.
  //
  // It drives the same ladder of sizes the zoom buttons use rather than a
  // continuous scale, so a pinch and a button press leave the document in the
  // same state and the reading beside the buttons stays true.
  const PINCH_IN = 1.28;        // how far apart before it counts as a step
  const PINCH_OUT = 1 / PINCH_IN;

  // The pointers currently down on the document, the span between the first
  // two of them when the current zoom step began, and where their midpoint
  // was on the last move.
  const pinchPointers = new Map();
  let pinchSpan = 0;
  let pinchMid = null;

  function pinching() {
    return pinchPointers.size >= 2;
  }

  function spanOf() {
    const [a, b] = [...pinchPointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function midOf() {
    const [a, b] = [...pinchPointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function watchPinch(stage) {
    const track = event => {
      if (event.pointerType === 'mouse') return;
      pinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinching() && !pinchSpan) { pinchSpan = spanOf(); pinchMid = midOf(); }
    };
    const drop = event => {
      pinchPointers.delete(event.pointerId);
      if (!pinching()) { pinchSpan = 0; pinchMid = null; }
    };

    // Capture, so the gesture is recognised before a canvas underneath starts
    // treating the first finger as a drag.
    stage.addEventListener('pointerdown', track, true);
    stage.addEventListener('pointermove', event => {
      if (event.pointerType === 'mouse') return;
      if (!pinchPointers.has(event.pointerId)) return;
      pinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!pinching() || !pinchSpan) return;
      event.preventDefault();

      // Two fingers do two things, told apart by which of them changed.
      //
      // Moving together is a scroll. That is the only way to move the document
      // while a box is being drawn, because the one finger that would
      // ordinarily drag it is busy drawing — which left a reviewer on a phone
      // able to mark the part of the page they could already see and nothing
      // else.
      const mid = midOf();
      if (pinchMid) {
        const dx = pinchMid.x - mid.x;
        const dy = pinchMid.y - mid.y;
        if (Math.hypot(dx, dy) > 0) {
          // From what the fingers are on, not from the stage: scrollerFor
          // starts at its argument's parent, so asking it about the stage
          // looks straight past the stage — which is the thing that scrolls.
          const scroller = scrollerFor(event.target || stage);
          if (scroller === window) window.scrollBy(dx, dy);
          else { scroller.scrollLeft += dx; scroller.scrollTop += dy; }
        }
      }
      pinchMid = mid;

      // Moving apart or together is a zoom. One step per gesture-worth of
      // movement, then the span is re-baselined so a long pinch keeps stepping
      // rather than stopping at one.
      const ratio = spanOf() / pinchSpan;
      if (ratio > PINCH_IN) { stepZoom(1); pinchSpan = spanOf(); }
      else if (ratio < PINCH_OUT) { stepZoom(-1); pinchSpan = spanOf(); }
    }, true);
    stage.addEventListener('pointerup', drop, true);
    stage.addEventListener('pointercancel', drop, true);
    // A pointer that leaves the element without an up — which is what a finger
    // sliding off the edge of the document column does — would otherwise sit
    // in the map for ever and leave the app permanently mid-pinch.
    stage.addEventListener('lostpointercapture', drop, true);
  }

  // A page at a time, from wherever the reviewer is.
  //
  // Scrolling lands somewhere in a page; this lands on one, which is what is
  // wanted when the job is "check the next one". The page it counts from is
  // the one under the top of the view — the same anchor zooming uses.
  function stepPage(by) {
    const pages = [...el('pages').children];
    if (!pages.length) return;
    const here = anchorOn(scrollerFor(el('pages')));
    const at = here ? pages.indexOf(here.page) : 0;
    const next = Math.max(0, Math.min(pages.length - 1, (at < 0 ? 0 : at) + by));
    goToPage(next);
    refreshPaging();
  }

  function refreshPaging() {
    const only = el('pages').children.length <= 1;
    const prev = el('page-prev');
    const next = el('page-next');
    if (prev) prev.disabled = only;
    if (next) next.disabled = only;
  }

  function stepZoom(by) {
    const at = ZOOM_STEPS.indexOf(state.zoom);
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (at < 0 ? 2 : at) + by));
    setZoom(ZOOM_STEPS[next]);
  }

  function setTool(tool) {
    state.tool = tool === 'mark' ? 'mark' : 'pan';
    el('tool-pan').setAttribute('aria-pressed', String(state.tool === 'pan'));
    el('tool-mark').setAttribute('aria-pressed', String(state.tool === 'mark'));
    document.body.classList.toggle('tool-pan', state.tool === 'pan');
    // Picking a logo has its own instruction and must not be written over.
    if (state.mode !== 'pick') setTip();
  }

  // The panel used to explain what dragging does, in a sentence that changed
  // with the tool. The tools say that themselves now, on hover and to a screen
  // reader, and a paragraph restating the button you are looking at is a
  // paragraph people stop reading.
  //
  // What is left is the one case with nothing else to say it: picking a logo
  // is a mode the reviewer has just entered by pressing a button somewhere
  // else in the panel, and the page gives no sign of it.
  // Nothing is said in the panel any more. The button that enters this mode
  // says what it does, the cursor changes, and a sentence appearing under the
  // toolbar to restate it was one more thing on screen.
  function setTip() {
    const tip = el('tip');
    // One sentence, and only where the gestures are not obvious. On a phone
    // the finger that would ordinarily drag the document is busy drawing the
    // box, so how to move the page is a genuine question; with a mouse it is
    // not, and a line about fingers there is noise.
    const say = state.mode === 'pick' && onPhone();
    tip.textContent = say ? 'One finger to draw the box, two to scroll.' : '';
    tip.hidden = !say;
  }

  function setMode(mode) {
    state.mode = mode;
    const button = el('pick');
    const picking = mode === 'pick';
    button.classList.toggle('on', picking);
    // Only the words inside the row, or the plus beside them would be written
    // over along with the label.
    el('picklabel').textContent = picking ? 'Cancel' : 'Select an image to redact';
    button.title = picking
      ? 'Stop picking'
      : 'Draw a box around a logo, stamp, signature or face';
    // Everything but the document and this section gets out of the way. Drawing
    // a box around a logo is the one thing in this tool that happens on the
    // page rather than in the panel, and dimming says so better than a sentence
    // nobody reads.
    document.body.classList.toggle('picking', picking);
    for (const page of state.pages) {
      if (page.canvas) page.canvas.parentElement.classList.toggle('picking', picking);
    }

    // Zooming stays live while picking, and nothing else does.
    //
    // A logo is often small, and drawing a box round it is the one job in this
    // tool that needs a close look. The toolbar was dimmed along with the rest
    // of the panel, so the reviewer had to leave picking, zoom, and start
    // again. The other four would each take them somewhere else mid-pick —
    // a different tool, a step undone, a draft saved, a new file — so they go
    // quiet rather than becoming traps.
    // Paging stays live with zooming: both are ways of getting to the mark
    // being picked, and neither takes the reviewer anywhere else.
    for (const id of ['tool-pan', 'tool-mark', 'undo', 'savedraft', 'reset-top']) {
      const button = el(id);
      if (!button) continue;
      if (picking) { button.disabled = true; }
      else if (id === 'undo') { refreshUndo(); }
      else { button.disabled = false; }
    }

    // On a phone the panel and the document take turns, and the box has to be
    // drawn on the document — so picking moves there, and finishing or
    // cancelling brings the panel back with the image in it. Without this the
    // reviewer tapped the button and nothing they could reach did anything.
    if (onPhone()) setPane(picking ? 'doc' : 'edit');

    // And a way out that is over the document rather than in the panel, which
    // on a phone is a strip down the side while the box is being drawn. Under
    // the toolbar on the left, where the hand is — measured rather than
    // guessed, because the toolbar floats to the top of the review on a phone
    // and sits inside the panel on a laptop.
    const stop = el('pickstop');
    stop.hidden = !picking;
    stop.dataset.show = picking ? 'yes' : 'no';

    // The tip line goes in first: it lives inside the toolbar's own block and
    // makes it taller, so measuring before it is written puts the cross where
    // the toolbar used to end.
    setTip();
    if (picking) {
      const head = document.querySelector('.panel-head');
      const at = head && head.getBoundingClientRect();
      if (at && at.height) {
        stop.style.top = Math.round(at.bottom + 10) + 'px';
        stop.style.left = Math.round(at.left + 2) + 'px';
      }
    }
  }

  // ---------- confirming a pick ----------
  //
  // A box drawn on the page at reviewing size is drawn at a few dozen pixels,
  // where a box a little too wide looks exactly like one that fits. That
  // matters more than it sounds: a pick that clips the mark, or carries a
  // strip of the thing beside it, is the difference between finding every
  // copy and finding two — measured on a deck of letter badges, where a pick
  // offset by four pixels turned a clean separation into an impossible one.
  //
  // So the pick is shown large enough to judge, with its corners in hand.
  const CROP_MARGIN = 0.6;      // how much of the surroundings to show
  const CROP_VIEW = 520;        // the stage's widest, in CSS pixels
  // And its tallest. A pick that is taller than it is wide was being drawn at
  // whatever height its shape asked for, which pushed the buttons below it off
  // the bottom of a phone — a dialog you cannot accept or cancel.
  const CROP_TALL = 0.46;       // of the window's height
  const CROP_GRAB = 14;         // how near a corner counts as grabbing it

  function confirmCrop(page, picked) {
    return new Promise(resolve => {
      const box = el('cropbox');
      const view = el('cropview');
      const ctx = view.getContext('2d');
      const size = el('cropsize');

      // What is on show: the pick plus a margin of its surroundings, so the
      // corners have somewhere to go and the mark has context.
      const pad = { x: picked.w * CROP_MARGIN, y: picked.h * CROP_MARGIN };
      const area = {
        x: Math.max(0, picked.x - pad.x),
        y: Math.max(0, picked.y - pad.y),
      };
      area.w = Math.min(page.source.width - area.x, picked.w + pad.x * 2);
      area.h = Math.min(page.source.height - area.y, picked.h + pad.y * 2);

      // Big enough to judge, never so big it leaves the screen — in both
      // directions.
      //
      // This used to fit the width only, and force the zoom to at least 1. A
      // wide pick then laid the canvas out wider than the stage, where
      // max-width shrank the width and left the height alone: the mark came
      // out squashed, and every corner ended up somewhere other than where it
      // was drawn, which is why they could not be grabbed. One number now
      // fits both sides, so nothing overrides it afterwards.
      // The dialog goes up first so the stage can be measured rather than
      // guessed at. Guessing was the last of this bug: a width taken from the
      // window was wider than the stage actually is, max-width clamped it, and
      // the inline height stayed — which is a squashed mark however carefully
      // the ratio was worked out beforehand.
      box.hidden = false;
      // clientWidth counts the stage's own padding, and a canvas sized to
      // include it overflows by exactly that much — where max-width clamps the
      // width and the inline height stays put, which is the squashing again.
      const stage = el('cropstage');
      const inset = (() => {
        const s = getComputedStyle(stage);
        return (parseFloat(s.paddingLeft) || 0) + (parseFloat(s.paddingRight) || 0);
      })();
      const roomW = Math.max(160, Math.min(CROP_VIEW,
        (stage.clientWidth || window.innerWidth - 90) - inset));
      const roomH = Math.max(180, window.innerHeight * CROP_TALL);
      const zoom = Math.min(6, roomW / area.w, roomH / area.h);
      const dpr = window.devicePixelRatio || 1;
      const wide = Math.round(area.w * zoom);
      const tall = Math.round(area.h * zoom);
      view.style.width = wide + 'px';
      view.style.height = tall + 'px';
      view.width = Math.round(wide * dpr);
      view.height = Math.round(tall * dpr);

      const rect = { ...picked };
      const toView = p => ({ x: (p.x - area.x) * zoom, y: (p.y - area.y) * zoom });

      const draw = () => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, view.width, view.height);
        ctx.drawImage(page.source, area.x, area.y, area.w, area.h,
          0, 0, area.w * zoom, area.h * zoom);

        const at = toView(rect);
        const w = rect.w * zoom, h = rect.h * zoom;

        // Everything outside the box goes quiet, so what is inside is the
        // thing being judged.
        ctx.fillStyle = 'rgba(13, 17, 23, 0.45)';
        ctx.fillRect(0, 0, area.w * zoom, at.y);
        ctx.fillRect(0, at.y + h, area.w * zoom, area.h * zoom - at.y - h);
        ctx.fillRect(0, at.y, at.x, h);
        ctx.fillRect(at.x + w, at.y, area.w * zoom - at.x - w, h);

        ctx.strokeStyle = MARK_GREEN;
        ctx.lineWidth = 2;
        ctx.strokeRect(at.x, at.y, w, h);

        ctx.fillStyle = '#fff';
        ctx.strokeStyle = MARK_GREEN;
        ctx.lineWidth = 2;
        for (const corner of corners(at, w, h)) {
          ctx.beginPath();
          ctx.arc(corner.x, corner.y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }

        size.textContent = Math.round(rect.w) + ' by ' + Math.round(rect.h)
          + ' pixels' + (zoom > 1.05 ? ', shown ' + zoom.toFixed(1)
            + ' times larger' : '') + '.';
      };

      let holding = null;
      // Measured against the canvas as it actually sits on the page, not
      // against the size it was asked for. A stylesheet that clamps it — or a
      // browser that rounds differently — must not put every corner a few
      // pixels from where the finger goes.
      const where = event => {
        const r = view.getBoundingClientRect();
        const k = r.width > 0 ? (area.w * zoom) / r.width : 1;
        return { x: (event.clientX - r.left) * k, y: (event.clientY - r.top) * k };
      };

      // Capture keeps a drag alive when the pointer leaves the canvas, which
      // is exactly what happens when a corner is dragged outwards. It is not
      // essential — a drag without it simply stops at the edge — so a browser
      // that refuses must not take the dialog down with it.
      const hold = event => {
        try { view.setPointerCapture(event.pointerId); } catch { /* not vital */ }
      };

      // Which corner the pointer is on, or -1 for none. The corners are drawn
      // on the canvas rather than being elements of their own, so nothing can
      // carry a cursor: what the pointer is over has to be worked out and the
      // cursor set to match.
      const cornerUnder = event => {
        const p = where(event);
        const list = corners(toView(rect), rect.w * zoom, rect.h * zoom);
        for (let i = 0; i < list.length; i++) {
          if (Math.hypot(p.x - list[i].x, p.y - list[i].y) <= CROP_GRAB) return i;
        }
        return -1;
      };

      // A crosshair says "draw a box", which is right over the picture and
      // wrong over a corner — the corners are for picking up and moving, and
      // an open hand is what says so. Nothing about it was discoverable
      // before: the corners were draggable and looked identical to the rest.
      const showCursor = event => {
        if (holding) {
          view.style.cursor = holding.fresh ? 'crosshair' : 'grabbing';
          return;
        }
        view.style.cursor = cornerUnder(event) >= 0 ? 'grab' : 'crosshair';
      };

      const down = event => {
        const p = where(event);
        const at = toView(rect);
        const list = corners(at, rect.w * zoom, rect.h * zoom);
        for (let i = 0; i < list.length; i++) {
          if (Math.hypot(p.x - list[i].x, p.y - list[i].y) <= CROP_GRAB) {
            holding = { corner: i };
            hold(event);
            showCursor(event);
            event.preventDefault();
            return;
          }
        }
        // Not a corner: drawing a new box from scratch, which is quicker than
        // dragging four corners when the first attempt was badly off.
        holding = { fresh: { x: area.x + p.x / zoom, y: area.y + p.y / zoom } };
        hold(event);
        event.preventDefault();
      };

      const move = event => {
        // The cursor answers on every move, held or not: hovering a corner has
        // to show that it can be taken before it is taken.
        showCursor(event);
        if (!holding) return;
        const p = where(event);
        const onPage = {
          x: Math.max(area.x, Math.min(area.x + area.w, area.x + p.x / zoom)),
          y: Math.max(area.y, Math.min(area.y + area.h, area.y + p.y / zoom)),
        };
        if (holding.fresh) {
          Object.assign(rect, Boxes.rectFromDrag(
            holding.fresh.x, holding.fresh.y, onPage.x, onPage.y));
        } else {
          // The corner opposite the one being dragged stays put, which is what
          // makes dragging a corner feel like resizing rather than moving.
          const fixed = corners({ x: rect.x, y: rect.y }, rect.w, rect.h)[3 - holding.corner];
          Object.assign(rect, Boxes.rectFromDrag(fixed.x, fixed.y, onPage.x, onPage.y));
        }
        draw();
      };

      const up = event => {
        holding = null;
        if (event) showCursor(event);
      };

      const done = value => {
        box.hidden = true;
        view.removeEventListener('pointerdown', down);
        view.removeEventListener('pointermove', move);
        view.removeEventListener('pointerup', up);
        view.removeEventListener('pointercancel', up);
        el('cropuse').removeEventListener('click', use);
        el('cropcancel').removeEventListener('click', cancel);
        document.removeEventListener('keydown', key);
        resolve(value);
      };
      const use = () => {
        // Too small to match on, which the old path only discovered after the
        // dialog had closed and the pick was gone.
        if (rect.w < 8 || rect.h < 8) {
          el('cropnote').textContent = 'That box is too small to match on. '
            + 'Draw one around the whole mark.';
          el('cropnote').classList.add('warnhint');
          return;
        }
        done({ ...rect });
      };
      const cancel = () => done(null);
      const key = event => {
        if (event.key === 'Enter') { event.preventDefault(); use(); }
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      };

      el('cropnote').textContent = 'Drag a corner to fit the box to it, or draw '
        + 'a new one. A box drawn tightly around the mark finds it far more '
        + 'reliably than a loose one.';
      el('cropnote').classList.remove('warnhint');
      view.addEventListener('pointerdown', down);
      view.addEventListener('pointermove', move);
      view.addEventListener('pointerup', up);
      view.addEventListener('pointercancel', up);
      el('cropuse').addEventListener('click', use);
      el('cropcancel').addEventListener('click', cancel);
      document.addEventListener('keydown', key);

      draw();
    });
  }

  // The four corners of a box, in the order top-left, top-right, bottom-left,
  // bottom-right — so index 3 - i is always the one diagonally opposite.
  function corners(at, w, h) {
    return [
      { x: at.x, y: at.y }, { x: at.x + w, y: at.y },
      { x: at.x, y: at.y + h }, { x: at.x + w, y: at.y + h },
    ];
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
      // Which page it was cut from. Without this a draft could record where a
      // logo was but not what it was cut out of, so restoring one silently
      // skipped every picked image — and there is now a second reader of it,
      // the full-size view behind the thumbnail.
      pageIndex: page.index,
      thumbnail: thumbnailOf(page.source, rect),
      matches: 0,
      // Its own bar, starting where the matcher does. A logo picked next is
      // unaffected by whatever this one is tuned to.
      sens: DEFAULT_SENS,
      // Not searched yet, and deliberately so: sweeping the document here is
      // what made picking a second logo mean waiting through the first.
      searched: false,
    };
    state.templates.push(template);
    pushUndo('picking that logo', () => dropTemplate(template.id));
    renderTemplates();
    renderSectionNotes();
    needsSearch();
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
  // The picked image, at the size it actually is on the page.
  //
  // The thumbnail in the panel is 42 pixels wide — enough to tell two picks
  // apart, not enough to check that the right thing was picked. This draws the
  // same region from the page it was cut from, scaled up if it is small and
  // down only if it would not otherwise fit.
  function showTemplate(templateId) {
    const template = state.templates.find(t => t.id === templateId);
    if (!template) return;
    const page = state.pages[template.pageIndex];
    const canvas = el('imagefull');
    const rect = template.rect;
    const wide = Math.max(1, Math.round(rect.w));
    const tall = Math.max(1, Math.round(rect.h));

    // Small picks are the common case — a stamp, a signature — and showing one
    // at its own size in a 560px box would answer nothing.
    const room = 500;
    const scale = Math.min(4, Math.max(1, room / wide));
    canvas.width = Math.round(wide * scale);
    canvas.height = Math.round(tall * scale);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (page && page.source) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(page.source, rect.x, rect.y, wide, tall,
        0, 0, canvas.width, canvas.height);
    }

    el('imagenote').textContent = wide + ' by ' + tall + ' pixels, from page '
      + ((template.pageIndex || 0) + 1)
      + (scale > 1 ? ', shown ' + (Math.round(scale * 10) / 10) + ' times larger.' : '.');
    el('imagebox').hidden = false;
    el('imageclose').focus();
  }

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
    // The column heading goes with the column: with nothing picked there are
    // no sliders for it to head.
    el('senshead').hidden = !state.templates.length;

    if (!state.templates.length) {
      const hint = el('pickhint');
      hint.hidden = true;
      hint.textContent = '';
      hint.classList.remove('warnhint');
    }

    for (const template of state.templates) {
      const row = document.createElement('li');
      // Counted from what survives, not from what the search returned: a
      // match already covered by a text mark is not a second thing found.
      const live = state.pages.reduce((sum, page) =>
        sum + liveImageHits(page).filter(m => m.templateId === template.id).length, 0);

      // Nothing in words at all. The thumbnail says which image this is and
      // the number says how many of it were found; "picked image" beside a
      // picture of it was a caption for something already on screen. What sits
      // between them is this image's own bar, because that is the one setting
      // that belongs to this image and nothing else.
      const bar = document.createElement('span');
      bar.className = 'rowsens';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '45';
      // Up to 0.99, not 0.95. Measured on a row of circular letter badges of
      // the kind decks use for footnotes: the F badge matched itself at 1.00
      // and the E badge beside it at 0.943 — the circle is most of the tile
      // and only the glyph differs. The whole range that separates them was
      // above the old ceiling, so at the highest setting the reviewer could
      // reach, the E was still being proposed.
      slider.max = '99';
      slider.step = '1';
      slider.value = String(Math.round(sensFor(template) * 100));
      slider.title = 'How closely something must resemble this image to be '
        + 'proposed. Lower finds more, including things that only resemble it. '
        + 'Two marks that differ by one letter need a bar above 0.95.';
      slider.setAttribute('aria-label', 'Sensitivity for this image');
      const reading = document.createElement('span');
      reading.className = 'v';
      reading.textContent = sensFor(template).toFixed(2);
      bar.append(slider, reading);

      const count = document.createElement('button');
      count.type = 'button';
      // Green, the same as a word's tally: both answer "how many were found",
      // and a picked image's answer is no less of an answer for being a
      // picture. Grey read as a disabled control.
      count.className = template.searched ? 'n dot-green' : 'n unknown';
      count.textContent = template.searched ? String(live) : '?';
      count.disabled = !template.searched || live === 0;
      if (!template.searched) count.title = 'Not searched for yet \u2014 press Search';
      if (!count.disabled) {
        count.title = 'Where ' + (live === 1 ? 'it is' : 'they are');
        count.setAttribute('aria-expanded', String(state.openTally === template.id));
        count.addEventListener('click', () => {
          state.openTally = state.openTally === template.id ? null : template.id;
          renderTemplates();
        });
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      // Named, because the row now holds two buttons and "the button in the
      // row" stopped meaning anything.
      remove.className = 'templatedrop';
      remove.textContent = '\u00d7';
      remove.title = 'Stop matching this image';
      remove.addEventListener('click', () => removeTemplate(template.id));

      // The thumbnail is the way to a proper look at what was picked.
      template.thumbnail.title = 'See the picked image full size';
      template.thumbnail.style.cursor = 'zoom-in';
      template.thumbnail.onclick = () => showTemplate(template.id);

      // Moving it is a different question about this image, so its answer
      // goes — and only its answer. Every other picked image keeps the
      // results it already has, which is what the one shared slider could not
      // do: tuning a stubborn signature threw away three finished logos.
      //
      // The row is not re-rendered here. A drag fires this on every pixel of
      // travel, and rebuilding the list under the reviewer's thumb takes the
      // slider out from under it. The two things that go stale are edited in
      // place instead.
      // Moving it is undoable, like everything else that changes what will be
      // covered. A slider is the easiest control on the panel to knock by
      // accident — a stray drag on a phone, a scroll wheel over it on a
      // laptop — and without this the way back was to remember the old number
      // and everything the old number had found.
      //
      // What is remembered is taken before the first pixel of movement, not
      // when the drag ends: by then the marks it is about have already been
      // thrown away. And one entry per gesture, not per pixel: `input` fires
      // continuously and would bury the rest of the stack.
      let beforeDrag = null;
      const remember = () => {
        if (beforeDrag) return;
        beforeDrag = {
          sens: sensFor(template),
          searched: template.searched,
          matches: template.matches,
          rawMatches: template.rawMatches,
          best: template.best,
          // The marks this image had, page by page, so undoing the setting
          // brings back what it had found rather than only the number.
          hits: state.pages.map(page =>
            page.imageHits.filter(m => m.templateId === template.id)),
        };
      };
      for (const start of ['pointerdown', 'keydown', 'focus']) {
        slider.addEventListener(start, remember);
      }
      // `change` is the end of the gesture: the release, or the key.
      slider.addEventListener('change', () => {
        const was = beforeDrag;
        beforeDrag = null;
        if (!was || Math.abs(was.sens - sensFor(template)) < 1e-9) return;
        pushUndo('that sensitivity change', () => {
          template.sens = was.sens;
          template.searched = was.searched;
          template.matches = was.matches;
          template.rawMatches = was.rawMatches;
          template.best = was.best;
          state.pages.forEach((page, i) => {
            page.imageHits = page.imageHits
              .filter(m => m.templateId !== template.id)
              .concat(was.hits[i]);
          });
          // The document counts as searched again only if nothing else is
          // waiting to be looked for. Forcing it true because this one image
          // was searched would claim an answer for a word typed since, or for
          // another image picked since — both of which the button is
          // supposed to still be asking about.
          if (was.searched && !pendingTemplates().length && !ocrPending()) {
            state.searched = true;
          }
        });
      });

      slider.addEventListener('input', () => {
        remember();
        template.sens = clampSens(Number(slider.value) / 100);
        reading.textContent = sensFor(template).toFixed(2);
        if (template.searched) {
          template.searched = false;
          template.matches = 0;
          template.rawMatches = 0;
          // What this image found was found at the old bar. The comprehensive
          // check's marks are not this slider's to throw away: they cost
          // minutes, and they are not about this image.
          for (const page of state.pages) {
            page.imageHits = page.imageHits.filter(
              m => m.bySweep || m.templateId !== template.id);
          }
        }
        count.className = 'n unknown';
        count.textContent = '?';
        count.disabled = true;
        count.removeAttribute('aria-expanded');
        count.title = 'Not searched for yet \u2014 press Search';
        // needsSearch closes the open tally, but the list it drew is already
        // on screen and only a re-render would take it off.
        const open = row.nextSibling;
        if (open && open.classList && open.classList.contains('tally')) open.remove();
        needsSearch();
      });

      row.append(template.thumbnail, bar, count, remove);
      host.append(row);

      if (state.openTally === template.id && !count.disabled) {
        host.append(tallyList(template.id, placesFor(template.id)));
      }
    }
  }

  // Where a picked image was found, page by page. The same question the tally
  // beside a word answers, and the same answer: a page number to go and look
  // at rather than a count to take on trust.
  function placesFor(templateId) {
    const out = [];
    for (const page of state.pages) {
      for (const match of liveImageHits(page)) {
        if (match.templateId !== templateId) continue;
        out.push({ pageIndex: page.index, kind: 'image',
                   // What it actually scored. Without this the slider is a
                   // dial with no reading: the reviewer moves it, re-runs,
                   // counts the marks, and guesses again. With it, the
                   // weakest match on the list is the number to set it above.
                   score: typeof match.score === 'number' ? match.score : null,
                   at: match.rect ? match.rect.y : 0 });
      }
    }
    out.sort((a, b) => a.pageIndex - b.pageIndex || a.at - b.at);
    return out;
  }

  // ---------- what each typed term actually matched ----------
  //
  // A term that matched nothing looks exactly like one that matched: the box
  // just sits there. Saying so is the difference between a reviewer noticing
  // they typed a name wrong and shipping a document with it still in.
  // Where each occurrence of a word actually is.
  //
  // Sorted by page, and each one carries how it was found: read out of the
  // text or the page's lettering, which is marked red, or turned up by the
  // thorough shape check, which is marked amber. The two are shown apart here
  // for the same reason they are drawn apart on the page — a mark the reading
  // found and a mark a shape matcher guessed at do not deserve equal trust.
  function occurrencesFor(term) {
    const out = [];
    if (state.kind === 'text') {
      for (const span of Detect.findTerms(state.text, [term])) {
        out.push({ pageIndex: 0, kind: 'text', at: span.start });
      }
      return out;
    }
    for (const page of state.pages) {
      for (const span of Detect.findTerms(page.text, [term])) {
        out.push({ pageIndex: page.index, kind: 'text', at: span.start });
      }
      for (const match of liveImageHits(page)) {
        if (match.term !== term) continue;
        out.push({
          pageIndex: page.index,
          kind: match.bySweep ? 'shape' : 'text',
          at: match.rect ? match.rect.y : 0,
        });
      }
    }
    out.sort((a, b) => a.pageIndex - b.pageIndex || a.at - b.at);
    return out;
  }

  // Brings a page into view in the document column. The panel scrolls
  // separately, so this has to move the right one.
  function goToPage(pageIndex, options) {
    const page = state.pages[pageIndex];
    if (!page || !page.canvas) return;
    // On a phone the page being named is behind the toggle, so following a
    // page number has to bring the document forward or the tap does nothing.
    //
    // `stay` is for the Organise sheet, where the tap is part of a longer job.
    // Throwing the reviewer out of the panel every time they select a
    // thumbnail would make the sheet unusable on a phone: they are choosing
    // pages, not going to read one.
    if (!(options && options.stay)
      && state.pane === 'edit' && window.matchMedia('(max-width: 900px)').matches) {
      setPane('doc');
    }
    page.canvas.parentElement.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function renderTermCounts() {
    const host = el('termcounts');
    host.textContent = '';
    const empty = el('termempty');
    if (empty) empty.hidden = state.terms.length > 0;
    if (!state.terms.length) return;

    for (const term of state.terms) {
      const where = occurrencesFor(term);
      const total = where.length;

      const row = document.createElement('li');
      // "Not found" is only true once something has looked. Before the search
      // every word would wear it, which reads as an answer and is not one.
      row.className = 'word'
        + (state.countedTerms.includes(term) && total === 0 ? ' none' : '');

      const label = document.createElement('span');
      label.className = 't';
      label.textContent = term;

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'termdrop';
      drop.textContent = '\u00d7';
      drop.title = 'Remove "' + term + '"';
      drop.setAttribute('aria-label', 'Remove "' + term + '"');
      drop.addEventListener('click', () => dropTerm(term));

      // One number, not two.
      //
      // It used to read "200 + 50 as picture", which split the answer along a
      // line the reviewer has no use for: they asked how many times the word
      // is in the document, and where each one happened to be written is the
      // tool's business rather than theirs. Counting them together also stops
      // the number moving about as the picture pass catches up.
      //
      // Where they are is a different question, and it is answered by asking
      // rather than by making every row carry a list nobody has looked at.
      // Two circles, not one number.
      //
      // The reading and the comprehensive check are different kinds of answer
      // — one recognised the letters, the other matched a shape — and they are
      // already drawn apart on the page in green and amber. Adding them
      // together in the panel asked the reviewer to hold a distinction the
      // page was at pains to make. The green circle is what the reading found;
      // the amber one beside it, only when there is one, is what the check
      // added.
      const counted = state.countedTerms.includes(term);
      const byReading = where.filter(spot => spot.kind !== 'shape');
      const byShape = where.filter(spot => spot.kind === 'shape');

      const circle = (kind, places) => {
        const key = term + '::' + kind;
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'n dot-' + kind;
        if (!counted && kind === 'green') {
          dot.classList.add('unknown');
          dot.textContent = '?';
          dot.disabled = true;
          dot.title = 'Not searched for yet \u2014 press Search';
          return dot;
        }
        dot.textContent = String(places.length);
        dot.disabled = places.length === 0 || state.kind === 'text';
        if (!dot.disabled) {
          dot.title = kind === 'shape'
            ? 'Where the comprehensive check found it'
            : 'Where it is';
          dot.setAttribute('aria-expanded', String(state.openTally === key));
          dot.addEventListener('click', () => {
            state.openTally = state.openTally === key ? null : key;
            renderTermCounts();
          });
        }
        return dot;
      };

      const count = circle('green', byReading);
      const shapeCount = byShape.length ? circle('shape', byShape) : null;
      row.append(label, count);
      if (shapeCount) row.append(shapeCount);
      row.append(drop);
      host.append(row);

      if (state.openTally === term + '::green' && !count.disabled) {
        host.append(tallyList(term, byReading));
      }
      if (shapeCount && state.openTally === term + '::shape' && !shapeCount.disabled) {
        host.append(tallyList(term, byShape));
      }
    }
  }

  function tallyList(term, where) {
    const box = document.createElement('li');
    box.className = 'tally';

    const list = document.createElement('ul');
    list.className = 'tallywhere';
    for (const spot of where) {
      const item = document.createElement('li');
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'tallyspot ' + spot.kind;
      const dot = document.createElement('span');
      dot.className = 'dot';
      const text = document.createElement('span');
      text.textContent = 'Page ' + (spot.pageIndex + 1);
      const how = document.createElement('span');
      how.className = 'how';
      // Every row in a picked image's list was found as a picture, so saying
      // so said nothing. What it scored is the thing the reviewer can act on.
      how.textContent = spot.kind === 'shape' ? 'by shape'
        : spot.kind === 'image'
          ? (spot.score === null ? 'as a picture' : spot.score.toFixed(2))
          : 'in the text';
      jump.append(dot, text, how);
      jump.addEventListener('click', () => goToPage(spot.pageIndex));
      item.append(jump);
      list.append(item);
    }
    box.append(list);
    return box;
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
      });
      view.append(mark);
      cursor = f.end;
    }
    view.append(document.createTextNode(state.text.slice(cursor)));
  }

  // ---------- export ----------

  function download(blob, filename) {
    // Recorded here rather than where the export was asked for: a build that
    // throws half way through has saved nothing, and telling the reviewer
    // their work is safe when it is not is the one thing this flag must never
    // do.
    state.exported = true;
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

  // ---------- drafts ----------
  //
  // A review can take a long while on a hundred-page document, and closing the
  // tab loses it — deliberately, since nothing is stored anywhere. A draft is
  // the way to come back to it.
  //
  // What a draft holds is the work, not the document: the words, the marks,
  // the boxes drawn by hand, the logos picked out, the settings. Not a single
  // page of content. That keeps it a few kilobytes instead of the size of the
  // original, and — the reason that matters — it means the draft carries
  // nothing confidential. A draft with the document inside it would be a file
  // that looks like a redaction and is the opposite of one, and sooner or
  // later somebody sends one on.
  //
  // The price is that reopening needs the original file again, which is why
  // the draft records enough to be sure it is the right one.
  const DRAFT_VERSION = 1;

  // Names the source file exactly enough to catch the wrong one being picked.
  // The digest is the real test; name and size are what the message quotes,
  // and are the fallback where crypto.subtle is missing (it needs a secure
  // context, which a file:// page is not).
  async function fingerprint(bytes) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].slice(0, 8)
        .map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  function draftData() {
    return {
      blindedDraft: DRAFT_VERSION,
      savedAt: new Date().toISOString(),
      source: { name: state.name, size: state.sourceSize || 0,
                digest: state.sourceDigest || null, kind: state.kind,
                pages: state.pages.length },
      terms: state.terms.slice(),
      settings: {
        labelling: state.labelling,
        labelOverrides: state.labelOverrides,
        zoom: state.zoom,
      },
      sweptTerms: state.sweptTerms,
      sweepAdded: state.sweepAdded,
      // A logo is stored as where it was cut from, not as the pixels: the
      // pixels are in the document, and the document is not in the draft.
      templates: state.templates.map(t => ({
        id: t.id, pageIndex: t.pageIndex, rect: t.rect,
        // Each image's own bar. It used to be one number for the whole
        // document, kept under settings.
        sens: sensFor(t),
      })),
      pages: state.pages.map(page => ({
        index: page.index,
        manual: page.manual,
        dismissed: [...page.dismissed],
        // Only marks that came from a word or a logo. Anything the text
        // scanner found is rebuilt from the words themselves on reopening.
        imageHits: page.imageHits.map(m => ({
          id: m.id, term: m.term, templateId: m.templateId, rect: m.rect,
          score: m.score, inverted: m.inverted, bySweep: m.bySweep, read: m.read,
        })),
      })),
      dismissedText: [...dismissedText],
    };
  }

  function draftName() {
    const base = state.name.replace(/\.[^.]+$/, '') || 'document';
    return base + '.blinded.json';
  }

  async function saveDraft() {
    if (!state.pages.length && !state.text) return;
    const data = draftData();
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      draftName());
    // Saving a draft is not exporting a redaction, and the flag that decides
    // whether the reviewer is warned about losing work must not be set by it.
    state.exported = false;
    draftNote('Draft saved. It holds your marks, not the document \u2014 reopen '
      + 'it and choose ' + state.name + ' again to carry on.');
  }

  function draftNote(text) {
    const note = el('draftnote');
    if (!note) return;
    note.textContent = text || '';
    note.hidden = !text;
    clearTimeout(draftNoteTimer);
    if (text) draftNoteTimer = setTimeout(() => { note.hidden = true; }, 9000);
  }
  let draftNoteTimer = null;

  // A draft picked at the drop screen. Held until the document it belongs to
  // is chosen.
  let pendingDraft = null;

  function looksLikeDraft(text) {
    try {
      const data = JSON.parse(text);
      return data && typeof data === 'object' && data.blindedDraft ? data : null;
    } catch { return null; }
  }

  function takeDraft(data) {
    if (data.blindedDraft > DRAFT_VERSION) {
      fail('That draft was saved by a newer version of Blinded than this one.');
      return;
    }
    pendingDraft = data;
    show('drop');
    // Asked properly rather than shouted in red. Nothing has gone wrong: the
    // reviewer has handed over the half of the pair that is not the document,
    // and the tool needs the other half.
    const name = (data.source && data.source.name) || 'the original document';
    el('draftbody').textContent = 'This draft was saved against "' + name
      + '". Choose that file, or drop it here, and your marks go back onto it.';
    el('draftbox').hidden = false;
  }

  function dropDraftPrompt() {
    el('draftbox').hidden = true;
  }

  // Puts a draft back onto a freshly opened document.
  async function restoreDraft(data) {
    const source = data.source || {};
    if (source.digest && state.sourceDigest && source.digest !== state.sourceDigest) {
      const ok = await confirmAction({
        title: 'This is a different file',
        body: 'The draft was saved against "' + source.name + '", and this file '
          + 'is not it. Marks are placed by position, so putting them on another '
          + 'document would cover the wrong things.',
        confirmLabel: 'Use the draft anyway',
      });
      if (!ok) return false;
    }

    // Older drafts wrote the words as the contents of a textarea.
    state.terms = Array.isArray(data.terms)
      ? data.terms.slice()
      : String(data.terms || '').split('\n').map(t => t.trim()).filter(Boolean);

    const settings = data.settings || {};
    // A draft saved before the bar moved onto the row carries one number for
    // every image. It is still the right answer for all of them, so it stands
    // in for the per-image values those drafts do not have.
    const wasShared = settings.sensitivity
      ? clampSens(Number(settings.sensitivity) / 100) : DEFAULT_SENS;
    state.labelling = Boolean(settings.labelling);
    if (el('labelling')) el('labelling').checked = state.labelling;
    state.labelOverrides = settings.labelOverrides || {};
    if (settings.zoom) setZoom(settings.zoom);

    state.sweptTerms = data.sweptTerms || [];
    state.sweepAdded = data.sweepAdded || 0;

    for (const saved of data.pages || []) {
      const page = state.pages[saved.index];
      if (!page) continue;
      page.manual = saved.manual || [];
      page.dismissed = new Set(saved.dismissed || []);
      page.imageHits = (saved.imageHits || []).filter(m => m && m.rect);
    }
    dismissedText.clear();
    for (const id of data.dismissedText || []) dismissedText.add(id);

    // Logos are re-cut from the document they were picked from, since the
    // draft holds where they were, not what they looked like.
    for (const saved of data.templates || []) {
      const page = state.pages[saved.pageIndex];
      if (!page || !saved.rect) continue;
      const cut = ImageSearch.templateFrom(page.source, saved.rect);
      if (!cut) continue;
      state.templates.push({
        id: saved.id, cut, rect: saved.rect, pageIndex: saved.pageIndex,
        thumbnail: thumbnailOf(page.source, saved.rect),
        sens: saved.sens !== undefined ? clampSens(saved.sens) : wasShared,
        matches: 0, rawMatches: 0, best: 0, searched: true,
      });
    }

    rescan();
    renderTemplates();
    renderTermCounts();
    renderSectionNotes();
    redrawAll();
    refreshApply();
    refreshPaging();
    draftNote('Draft restored.');
    return true;
  }

  // Everything being covered inside the document, as plain strings.
  //
  // The typed words, and whatever the detectors matched — an address, a card
  // number — but only the ones that are actually going to be covered, since a
  // match the reviewer has clicked off is a match they have decided to keep.
  function coveredText() {
    const out = new Set();
    for (const term of state.terms) if (term) out.add(term);
    const pages = state.kind === 'text'
      ? [{ findings: state.findings, dismissed: dismissedText }]
      : state.pages;
    for (const page of pages) {
      for (const finding of page.findings || []) {
        if (page.dismissed && page.dismissed.has(finding.id)) continue;
        if (finding.text) out.add(finding.text);
      }
    }
    return [...out].filter(s => s.trim().length >= 3);
  }

  // The same words, taken out of the file name.
  //
  // A document can be redacted perfectly and still name its own secret in the
  // title bar of whoever opens it, in the attachment line of an email, in a
  // shared folder listing. Nothing inside the file is wrong; the leak is the
  // name. So the name is cleaned before it is offered, and the reviewer sees
  // what happened and can edit it further.
  function cleanName(name, covered) {
    let out = String(name || '');
    for (const phrase of covered || coveredText()) {
      const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(pattern, '');
    }
    // Whatever punctuation the removal left stranded.
    out = out.replace(/[ \t]{2,}/g, ' ')
      .replace(/[-_\u2013\u2014]{2,}/g, '-')
      .replace(/\s*[-_\u2013\u2014]\s*(?=[-_\u2013\u2014.]|$)/g, '')
      .replace(/^[\s\-_\u2013\u2014.]+/, '')
      .replace(/[\s\-_\u2013\u2014]+$/, '')
      .trim();
    return out;
  }

  // Asking before something is thrown away.
  //
  // A reload, a closed tab or a followed link all pass through beforeunload,
  // and the browser offers to stop them. Opening another file does not: it
  // discards the document on screen without navigating anywhere, so nothing
  // fires and the browser has nothing to offer. The tool has to ask itself,
  // and the thing being lost is a document the reviewer may have spent minutes
  // marking up.
  function confirmAction(options) {
    const opts = options || {};
    return new Promise(resolve => {
      const box = el('confirmbox');
      const yes = el('confirmyes');
      const no = el('confirmno');
      el('confirmhead').textContent = opts.title || 'Are you sure?';
      el('confirmbody').textContent = opts.body || '';
      yes.textContent = opts.confirmLabel || 'Discard';
      box.hidden = false;
      // The cancel button takes focus, not the destructive one: a stray Enter
      // should not be the thing that loses the document.
      no.focus();

      const done = answer => {
        box.hidden = true;
        yes.removeEventListener('click', accept);
        no.removeEventListener('click', reject);
        document.removeEventListener('keydown', key, true);
        resolve(answer);
      };
      const accept = () => done(true);
      const reject = () => done(false);
      const key = event => {
        if (event.key === 'Escape') { event.preventDefault(); reject(); }
      };
      yes.addEventListener('click', accept);
      no.addEventListener('click', reject);
      document.addEventListener('keydown', key, true);
    });
  }

  // Offers the name, and resolves to the one to save under, or null if the
  // reviewer changes their mind.
  // Asks for the password to a locked PDF.
  //
  // It is typed here and used here: handed to pdf.js in this tab to open the
  // reviewer's own file. Nothing about it leaves, which is the same promise
  // the document itself gets, and the dialog says so — a password box on a
  // web page is exactly the thing people are right to be wary of.
  function askPassword(wrong) {
    return new Promise(resolve => {
      const box = el('passbox');
      const input = el('password');
      const note = el('passnote');
      input.value = '';
      note.textContent = wrong
        ? 'That password did not open the file. The password is used here, in '
          + 'this tab, and is never sent anywhere.'
        : 'The password is used here, in this tab, to open the file. Like the '
          + 'file, it is never sent anywhere.';
      note.classList.toggle('warnhint', Boolean(wrong));
      box.hidden = false;
      input.focus();

      const done = value => {
        box.hidden = true;
        // Not left sitting in the DOM once it has been used.
        input.value = '';
        el('passgo').removeEventListener('click', go);
        el('passcancel').removeEventListener('click', cancel);
        input.removeEventListener('keydown', key);
        resolve(value);
      };
      const go = () => { if (input.value) done(input.value); else input.focus(); };
      const cancel = () => done(null);
      const key = event => {
        if (event.key === 'Enter') { event.preventDefault(); go(); }
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      };
      el('passgo').addEventListener('click', go);
      el('passcancel').addEventListener('click', cancel);
      input.addEventListener('keydown', key);
    });
  }

  // Renders a PDF, asking for a password if it turns out to need one.
  //
  // The rest of the app works from the rendered pages, so a file opened this
  // way is unlocked for every purpose that follows: the export is built from
  // pixels and carries no encryption of its own.
  async function renderPdf(bytes, onProgress) {
    let password = null;
    let wrong = false;
    for (;;) {
      try {
        // A fresh copy every attempt. pdf.js hands the buffer to its worker by
        // transfer, which detaches it here — so a second attempt with the same
        // bytes fails with "ArrayBuffer is already detached" rather than with
        // anything about passwords, and the reviewer is told their file is
        // broken when they have simply mistyped.
        return await PdfRead.load(bytes.slice(), onProgress,
          password ? { password } : undefined);
      } catch (error) {
        if (!error || !error.blindedLocked) throw error;
        wrong = error.blindedLocked === PdfRead.WRONG_PASSWORD;
        // The overlay is in front of the dialog, and a reviewer cannot type
        // into something they cannot see.
        busy(false);
        password = await askPassword(wrong);
        if (password === null) {
          const stopped = new Error('The file was not opened.');
          stopped.blindedCancelled = true;
          throw stopped;
        }
        busy(true, 'Reading the PDF…');
      }
    }
  }

  function askName(suggested) {
    return new Promise(resolve => {
      const box = el('namebox');
      const input = el('savename');
      const note = el('namenote');
      const covered = coveredText();
      const extension = (suggested.match(/\.[^.]+$/) || [''])[0];
      const stem = suggested.slice(0, suggested.length - extension.length);
      const cleaned = cleanName(stem, covered);
      const changed = cleaned !== stem;

      input.value = (cleaned || 'document') + extension;
      note.hidden = !changed;
      if (changed) {
        note.textContent = 'The name of the file you opened contained something '
          + 'this redaction covers, so it has been taken out of the name as well.';
      }
      box.hidden = false;
      input.focus();
      // The stem only, so typing replaces the name and not the extension.
      input.setSelectionRange(0, Math.max(0, input.value.length - extension.length));

      const done = value => {
        box.hidden = true;
        el('namesave').removeEventListener('click', save);
        el('namecancel').removeEventListener('click', cancel);
        input.removeEventListener('keydown', key);
        resolve(value);
      };
      const save = () => {
        const typed = input.value.trim();
        if (!typed) { input.focus(); return; }
        done(typed.endsWith(extension) ? typed : typed + extension);
      };
      const cancel = () => done(null);
      const key = event => {
        if (event.key === 'Enter') { event.preventDefault(); save(); }
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      };
      el('namesave').addEventListener('click', save);
      el('namecancel').addEventListener('click', cancel);
      input.addEventListener('keydown', key);
    });
  }

  async function exportFile() {
    const extension = state.kind === 'text' ? 'txt' : state.kind === 'image' ? 'png' : 'pdf';
    const chosen = await askName(redactedName(extension));
    if (!chosen) return;                 // changed their mind; nothing is built
    state.saveAs = chosen;
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
          })), 'replacement');
        } else {
          out = Detect.applyToText(state.text, spans, 'block');
        }
        download(new Blob([out], { type: 'text/plain' }), state.saveAs);
      } else if (state.kind === 'image') {
        const page = state.pages[0];
        const flat = Render.flatten(page.source, activeBoxes(page));
        download(await Render.canvasToBlob(flat, 'image/png'), state.saveAs);
      } else {
        const lossless = el('lossless').checked;
        const searchable = el('searchable').checked;
        // Placeholders are written as invisible text over the bars whenever
        // labelling is on. It was a checkbox, ticked, and turning it off made
        // the labels a picture of themselves — which is not a trade anyone was
        // choosing on purpose.
        const machineReadable = state.labelling;
        const built = [];

        // The flattened pages are kept while the text layer is read off them,
        // rather than encoded and dropped one at a time, because the reader
        // works several pages at once and wants them together.
        const flats = [];
        for (const page of state.pages) {
          pageProgress(page.index, state.pages.length, 'Flattening pages');
          const boxes = activeBoxes(page);
          flats.push({ page, boxes, flat: Render.flatten(page.source, boxes) });
        }

        // Read back what the redacted pages actually say.
        //
        // The reader is pointed at the flattened canvas, never at the
        // original: a word under a bar is not in those pixels, so it cannot
        // come back as text. That is the whole safety argument, and it is the
        // same one the placeholder layer rests on — what goes into the file is
        // what a reader of the finished page can see.
        //
        // It is a second reading, not the one done during review: that one
        // read the document as it arrived, bars and all still to come.
        let readBack = null;
        if (searchable) {
          const canvases = flats.map(f => f.flat);
          busy(true, 'Working…');
          legs([{ key: 'ocr', label: 'Reading the redacted pages',
                  total: canvases.length }]);
          await nextPaint();
          readBack = await Ocr.readPages(canvases, done => leg('ocr', done));
          legs([]);
        }

        for (let i = 0; i < flats.length; i++) {
          const { page, boxes, flat } = flats[i];
          pageProgress(i, flats.length, 'Writing pages');
          const placeholders = machineReadable ? textLayerFor(page, boxes) : [];
          const words = readBack ? wordLayerFor(page, readBack[i]) : [];
          const labels = placeholders.concat(words);
          built.push({
            widthPt: page.widthPt,
            heightPt: page.heightPt,
            image: await Render.encodeForPdf(flat, lossless),
            labels: labels.length ? labels : undefined,
          });
        }

        const bytes = PdfWrite.build(built);
        download(new Blob([bytes], { type: 'application/pdf' }), state.saveAs);
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

  // The words the reader found on a redacted page, in the writer's coordinates.
  //
  // Same conversion as the placeholders — canvas pixels run from the top left
  // and PDF user space from the bottom left — but sized and placed per word
  // rather than per bar, so selecting a line in a viewer selects roughly where
  // the line is.
  //
  // Very short scraps of ink are dropped. A single character the reader was
  // unsure of is more often a speck than a word, and a text layer full of
  // stray letters makes a search for a real word harder rather than easier.
  function wordLayerFor(page, items) {
    if (!items || !items.length) return [];
    const scaleX = page.widthPt / page.source.width;
    const scaleY = page.heightPt / page.source.height;

    return items
      .filter(item => item.rect && String(item.str || '').trim().length
        && (item.confidence === undefined || item.confidence >= 40))
      .map(item => {
        const height = item.rect.h * scaleY;
        return {
          text: String(item.str),
          x: item.rect.x * scaleX,
          // The bottom of the ink is the closest thing the reader gives to a
          // baseline, which is what Td wants.
          y: page.heightPt - (item.rect.y + item.rect.h) * scaleY,
          size: Math.max(1, height),
        };
      });
  }

  // The legend, rendered as one more page image.
  //
  // Categories only. A legend inside the document that mapped a placeholder
  // back to the name it replaced would undo the redaction completely, which is
  // why the mapping is a separate download and why Labels.legend() is the
  // function used here rather than Labels.key().
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
  // Pages come and go with the scroll, and change size with the window.
  //
  // Both are throttled to a frame: the work is cheap but it is not free, and
  // doing it once per scroll event on a hundred-page document is how a smooth
  // scroll becomes a stuttering one.
  let liveTimer = null;
  const refreshLive = () => {
    if (liveTimer) return;
    liveTimer = requestAnimationFrame(() => {
      liveTimer = null;
      updateLivePages();
    });
  };
  el('pages').addEventListener('scroll', refreshLive);
  const stageOf = () => document.querySelector('.stage');
  if (stageOf()) stageOf().addEventListener('scroll', refreshLive, { passive: true });
  window.addEventListener('scroll', refreshLive, { passive: true });
  window.addEventListener('resize', refreshLive);

  window.addEventListener('dragover', e => e.preventDefault());

  // The prompt asking for a draft's document covers the drop box, so dropping
  // the file onto it has to work too — the prompt says "or drop it here", and
  // a message that names a gesture the page then swallows is worse than no
  // message.
  el('draftbox').addEventListener('dragover', e => e.preventDefault());
  el('draftbox').addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
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
      // And held inside the viewport whatever the button did. Flipping above
      // only helps a button near the bottom edge; a button scrolled past the
      // bottom edge put the bubble past it too, which is a hint nobody can
      // read. Both ends are clamped, so it lands somewhere visible.
      top = Math.min(top, window.innerHeight - size.height - margin);
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
  // The toolbar icons explain themselves through `title`, which is a hover,
  // and a phone has no hover: on a touch screen those six buttons were six
  // unlabelled glyphs with no way at all to find out what they did. Holding
  // one shows the same bubble the "?" hints use, and the press that revealed
  // it does not also fire the button — finding out what a control does must
  // not be the same gesture as using it.
  const HOLD = 420;
  for (const button of document.querySelectorAll('.tool, .tool .half')) {
    let timer = null;
    let shown = false;
    const say = () => {
      const text = button.getAttribute('title') || button.getAttribute('data-tip');
      if (!text) return;
      button.setAttribute('data-tip', text);
      shown = true;
      tip.open(button);
    };
    const drop = () => { if (timer) clearTimeout(timer); timer = null; };
    button.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse') return;   // hover already answers this
      drop();
      shown = false;
      timer = setTimeout(say, HOLD);
    });
    for (const end of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) {
      button.addEventListener(end, drop);
    }
    // Capture, so the button's own handler never sees a click that was only
    // ever a question.
    button.addEventListener('click', event => {
      if (!shown) return;
      shown = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
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

  // Adding a word is a decision, not a keystroke.
  //
  // The list used to be a textarea read on every input event, so a name being
  // typed was searched for at every prefix — "J", "Ja", "Jan" — and the tally
  // flickered through the matches for each. A word now joins the list when the
  // reviewer says so, with Enter or the button beside the box.
  function addTerm(raw) {
    const word = String(raw || '').trim();
    if (!word) return false;
    // Silently, because re-adding a word you already have is not an error and
    // a message saying so is one more thing to dismiss.
    if (state.terms.includes(word)) { el('termbox').value = ''; return false; }
    state.terms = state.terms.concat([word]);
    el('termbox').value = '';
    renderTermCounts();
    rescan();
    return true;
  }

  function dropTerm(word) {
    if (!state.terms.includes(word)) return;
    // Everything found for a word the reviewer has just taken off the list
    // goes with it, whichever pass found it.
    state.terms = state.terms.filter(t => t !== word);
    state.searchedTerms = state.searchedTerms.filter(t => t !== word);
    state.sweptTerms = state.sweptTerms.filter(t => t !== word);
    for (const page of state.pages) {
      page.imageHits = page.imageHits.filter(m => !m.term || m.term !== word);
    }
    // The open list is keyed by word and by which circle it belongs to.
    if (state.openTally && state.openTally.split('::')[0] === word) {
      state.openTally = null;
    }
    state.countedTerms = state.countedTerms.filter(t => t !== word);
    renderTermCounts();
    rescan({ settled: true });
  }

  function refreshTermBox() {
    el('termgo').disabled = !el('termbox').value.trim();
  }

  el('termbox').addEventListener('input', refreshTermBox);
  el('termbox').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addTerm(el('termbox').value);
    refreshTermBox();
  });
  el('termgo').addEventListener('click', () => {
    addTerm(el('termbox').value);
    refreshTermBox();
    el('termbox').focus();
  });
  refreshTermBox();

  // The sheet has the panel to itself.
  //
  // A grid of thumbnails is the tallest thing in the panel by a wide margin,
  // and opened underneath four other sections it lands mostly below the fold:
  // the reviewer opens Organise and sees the bottom of Placeholders. So
  // opening it shuts the rest — and opening any of the rest shuts it, because
  // half a sheet under an open Terms box is the same problem arrived at from
  // the other side.
  for (const section of document.querySelectorAll('details.sect')) {
    section.addEventListener('toggle', () => {
      if (!section.open) return;
      const sheet = el('organisesect');
      // Closing a section fires this again with open false, which returns
      // above, so there is no loop to break out of.
      if (section === sheet) {
        for (const other of document.querySelectorAll('details.sect')) {
          if (other !== sheet) other.open = false;
        }
        sheet.scrollIntoView({ block: 'nearest' });
      } else if (sheet.open) {
        sheet.open = false;
      }
    });
  }

  el('page-left').addEventListener('click', () => nudge(-1));
  el('page-right').addEventListener('click', () => nudge(1));
  el('page-keep').addEventListener('click', keepOnlyPicked);
  el('page-drop').addEventListener('click', dropPicked);
  el('page-add').addEventListener('click', () => el('addfile').click());
  el('addfile').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    // Cleared before the read, so choosing the same file twice in a row still
    // fires a change event the second time.
    event.target.value = '';
    await addDocument(file);
  });
  // The modifier is named in the hint, and it is a different key on a Mac.
  if (/Mac|iPhone|iPad/.test(navigator.platform || '')) {
    for (const why of document.querySelectorAll('[data-tip*="Ctrl-click"]')) {
      why.setAttribute('data-tip',
        why.getAttribute('data-tip').replace('Ctrl-click', 'Cmd-click'));
    }
  }

  // The box and the state start from the same value, rather than each
  // asserting a default of its own.
  showWordControls();

  el('busy-pause').addEventListener('click', requestPause);
  el('sweep').addEventListener('click', runSweep);
  el('sweepstop').addEventListener('click', () => {
    state.sweepStopped = true;
    el('sweepprogress').textContent = 'Stopping\u2026';
  });

  // How long a sweep takes, per megapixel of page, per word.
  //
  // Measured, not guessed: 96 pages of 1.94 megapixels for one word took 66.8
  // seconds on four cores, which is 0.36. It was four times that when the
  // sweep drew eight typefaces instead of two.
  const SWEEP_SECONDS_PER_MP = 0.36;

  // ---------- the thorough sweep ----------
  //
  // Reading the pages finds the words, and on the documents this was built
  // against it finds nearly all of them. Nearly is the problem: a word set in
  // a typeface the reader stumbles over, or small, or at an angle, can be read
  // as something else and then it is simply not there.
  //
  // The tool used to guess at this, flagging every place the reader sounded
  // unsure. On a hundred-page deck that was 583 amber boxes over 96 pages, and
  // a warning at that volume is not a warning — it is a texture the reviewer
  // learns to scroll past. Worse, it asked the reviewer to adjudicate
  // something they have no way to judge.
  //
  // So nothing is flagged on suspicion any more. Instead this searches the
  // whole document for the shape of each word, in every typeface, and anything
  // it turns up that the reading missed becomes an ordinary mark, drawn in
  // amber so it is obvious which ones are new. A found word is a fact a
  // reviewer can check at a glance; a doubtful spot was a question they could
  // not answer.
  //
  // It is slow, which is why it is a button and not the default.

  // Every typed word, in two typefaces, whether or not it has been looked for
  // already: the point is to look again, differently.
  //
  // Eight at first, one for every face the tool can draw. That was four times
  // the cost for a second opinion on work the reader has already done well.
  // Which two, and why bold, is measured in lib/textimage.js.
  function sweepTemplates() {
    const entries = [];
    for (const term of state.terms) {
      TextImage.templatesFor(term, TextImage.SWEEP_FACES).forEach((template, i) => {
        entries.push({
          key: 'sweep:' + term + ':' + i, template, term,
          threshold: wordBarFor(term),
          smallText: true,
        });
      });
    }
    return entries;
  }

  // Is this spot already accounted for? A sweep that re-proposes what the
  // reader already found would bury the handful of genuine additions in
  // hundreds of duplicates, which is the failure this feature replaces.
  function alreadyCovered(page, rect) {
    for (const hit of page.hits || []) {
      for (const r of hit.rects) if (Match.overlapFraction(r, rect) > 0.3) return true;
    }
    for (const match of page.imageHits || []) {
      if (match.rect && Match.overlapFraction(match.rect, rect) > 0.3) return true;
    }
    for (const box of page.manual || []) {
      if (Match.overlapFraction(box, rect) > 0.3) return true;
    }
    return false;
  }

  // Does the reader already know this is a different word?
  //
  // Measured on a fifteen-page report, looking for "jared": the search found
  // all fifteen occurrences from the text, and the comprehensive check then
  // proposed fifty-four more — every single one of them wrong. They were
  // "offered", "scared", "faced", "shared", "paired", "considered",
  // "separate", "hundred", "rigorous", "validated". A five-letter word's
  // shape lives inside a great many longer words, and at 0.65 correlation
  // does not tell them apart.
  //
  // The reader is the better source wherever it worked, and it had read every
  // one of those words at confidence 91 to 96. So where it placed words over
  // the spot and none of them is the term, the proposal is refused: it is not
  // a second opinion, it is contradicting a first-hand reading.
  //
  // What this must not do is silence the case the check exists for —
  // lettering baked into a picture, which the reader does not see at all.
  // That case has no words over the spot, so nothing vetoes it.
  // Measured twice, and the second measurement moved it. On a text report the
  // words the reader used to refuse a guess came back at 91 to 96. On a deck,
  // looking for "KAS", the check proposed the title "KAG's" — and the reader
  // had read that title correctly at 70, so a bar of 75 let the wrong mark
  // through by five points. Large coloured display type is read correctly and
  // scored lower than body text, which is a property of the reader rather
  // than of the page.
  //
  // Below this is where Tesseract is genuinely unsure, and an unsure reading
  // is exactly what the shape matcher is there to second-guess — so a doubtful
  // word never gets to veto.
  const READER_SURE = 60;
  const READER_OVER = 0.25;

  function readerContradicts(page, rect, term) {
    const placed = page.ocrPlaced;
    if (!placed || !placed.length || !page.ocrText) return false;

    const over = placed.filter(item => item.rect
      && Match.overlapFraction(item.rect, rect) > READER_OVER);
    // The reader saw nothing here, so it has no opinion to contradict with.
    if (!over.length) return false;

    // Only a confident reading gets a veto. A word the reader was unsure of
    // is exactly the kind of word the shape matcher is there to second-guess.
    if (!over.every(item => typeof item.confidence === 'number'
      && item.confidence >= READER_SURE)) return false;

    // Asked the same way the reading itself asks, so the two cannot disagree
    // about what counts as the term appearing in a word.
    const said = over.map(item => page.ocrText.slice(item.start, item.end)).join(' ');
    return Detect.findTerms(said, [term]).length === 0;
  }

  // The running sweep, so that anything which has to come after it can wait
  // for it rather than race it.
  let sweepTask = null;

  async function runSweep() {
    if (state.sweepRunning) return 0;
    if (state.redacting) return 0;
    sweepTask = sweepNow();
    try { return await sweepTask; } finally { sweepTask = null; }
  }

  // Stops a running sweep and waits for it to put down what it found. Safe to
  // call when nothing is running.
  async function settleSweep() {
    if (!sweepTask) return;
    state.sweepStopped = true;
    try { await sweepTask; } catch { /* it reports its own failure */ }
  }

  async function sweepNow() {
    const entries = sweepTemplates();
    if (!entries.length) return 0;
    // Which words this run is answering. The reviewer can edit the list while
    // it runs, and a mark for a word they have since deleted is a mark they
    // never asked for, so the answer is filtered against the list as it stands
    // when the run finishes rather than as it stood when it started.
    const asked = state.terms.slice();

    // No overlay. Every other long pass in this tool blocks the document
    // because nothing useful can be done while it runs; this one is a second
    // opinion on a redaction that already exists, so the reviewer keeps the
    // document and a bar in the panel says how far it has got.
    state.sweepRunning = true;
    state.sweepStopped = false;
    sweepProgress(0, state.pages.length);
    renderSweep();
    // The Search button greys out for as long as this runs, so it has to be
    // told the moment it starts and not only when it ends.
    refreshApply();

    let results;
    try {
      results = await ImageSearch.searchAllParallel(state.pages, entries,
        { stop: () => state.sweepStopped },
        done => sweepProgress(done, state.pages.length));
    } catch (error) {
      state.sweepRunning = false;
      renderSweep();
      alert('The thorough check could not finish: '
        + (error && error.message ? error.message : error));
      return 0;
    }

    const reached = typeof results.stoppedAfter === 'number'
      ? results.stoppedAfter : state.pages.length;

    // Several typefaces finding the same word in the same place is one find,
    // so they are pooled per page and suppressed before anything is proposed.
    let added = 0;
    let refused = 0;
    for (const term of new Set(entries.map(e => e.term))) {
      if (!state.terms.includes(term)) continue;
      const perPage = new Map();
      for (const entry of entries.filter(e => e.term === term)) {
        const found = results.get(entry.key);
        if (!found) continue;
        for (const hit of found.matches) {
          if (!perPage.has(hit.pageIndex)) perPage.set(hit.pageIndex, []);
          perPage.get(hit.pageIndex).push(hit);
        }
      }
      for (const [pageIndex, hits] of perPage) {
        const page = state.pages[pageIndex];
        if (!page) continue;
        for (const hit of Match.suppress(hits, 0.3)) {
          const rect = { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
          if (alreadyCovered(page, rect)) continue;
          if (readerContradicts(page, rect, term)) { refused++; continue; }
          page.imageHits.push({
            id: 'sweep:' + term + ':' + pageIndex + ':'
              + Math.round(hit.x) + ':' + Math.round(hit.y),
            term, rect, score: hit.score,
            inverted: Boolean(hit.inverted),
            // What makes it amber on the page and countable in the note.
            bySweep: true,
          });
          added++;
        }
      }
    }

    state.sweepRunning = false;
    // A run that was stopped part way has not answered the document, so it
    // does not get to claim it has: the offer stands, and the note says how
    // far it reached.
    state.sweptTerms = state.sweepStopped ? [] : asked.filter(t => state.terms.includes(t));
    state.sweepAdded = added;
    // How many proposals the reader threw out. Not shown anywhere; kept so a
    // measurement of this check does not have to be a guess.
    state.sweepRefused = refused;
    state.sweepReached = reached;
    // New marks are not yet covered, so the document is no longer redacted.
    if (added) markPending();
    markDuplicates();
    renderTermCounts();
    renderSweep();
    redrawAll();
    refreshApply();
    return added;
  }

  function sweepProgress(done, total) {
    state.sweepDone = done;
    state.sweepTotal = total;
    const fill = el('sweepfill');
    if (fill) fill.style.width = (total ? (done / total) * 100 : 0).toFixed(1) + '%';
    const line = el('sweepprogress');
    if (line) {
      line.textContent = 'Checking page ' + Math.min(done + 1, total) + ' of ' + total
        + ' \u2014 you can carry on reviewing.';
    }
  }

  // The button, and what it says afterwards.
  //
  // Offered only once a redaction has been done, because it is the second
  // opinion on that redaction: there is nothing to be thorough about before
  // there is a result to check.
  function renderSweep() {
    const box = el('sweepbox');
    const note = el('sweepnote');
    const button = el('sweep');
    const swept = state.sweptTerms.length
      && state.sweptTerms.length === state.terms.length
      && state.sweptTerms.every((t, i) => t === state.terms[i]);

    // Offered from the moment there is a search to check, rather than waiting
    // for the redaction to be applied. It is a second opinion on what the
    // first pass found, and that exists as soon as the first pass has run —
    // asking the reviewer to cover everything before they can ask whether
    // anything was missed had the order backwards.
    //
    // It stays up afterwards too: the marks it finds un-apply the redaction,
    // and at first that hid the very note saying what it had found.
    // Only while there is a search to check. Once the reviewer changes what to
    // look for, the button says Search again and this has nothing to be a
    // second opinion about — the marks it found last time are still on the
    // page, but the offer belongs to a search that no longer stands.
    //
    // A check that is actually running is the exception, and it has to be:
    // changing a setting sets the document back to un-searched, and that was
    // taking the progress bar of a running check off the screen with it. The
    // work carried on in the background with nothing to show for it, which is
    // the same dead-button problem in a different place — and worse here,
    // because the only way to stop it had gone too.
    box.hidden = !((state.searched || state.sweepRunning)
      && state.terms.length && state.kind !== 'text');
    if (box.hidden) return;

    const running = el('sweeprun');
    running.hidden = !state.sweepRunning;
    if (state.sweepRunning) {
      button.hidden = true;
      note.textContent = '';
      return;
    }

    if (!swept) {
      button.hidden = false;
      button.textContent = 'Comprehensive Check';
      // Honest about the cost, because it is the whole reason this is a
      // button rather than the default.
      //
      // Scaled by the document's own page size rather than assuming one.
      const first = state.pages[0];
      const megapixels = first ? (first.source.width * first.source.height) / 1e6 : 2;
      const seconds = Math.round(
        state.pages.length * state.terms.length * megapixels * SWEEP_SECONDS_PER_MP);
      if (state.sweepStopped && state.sweepReached) {
        note.textContent = 'Stopped after ' + state.sweepReached
          + ' of ' + state.pages.length + ' pages'
          + (state.sweepAdded
            ? ', having added ' + state.sweepAdded
              + (state.sweepAdded === 1 ? ' mark' : ' marks') + ' in amber. '
            : ', having found nothing new. ')
          + 'Start it again to check the whole document \u2014 about '
          + describeTime(seconds) + '.';
        return;
      }
      note.textContent = 'The initial redaction may make mistakes. This check '
        + 'inspects every page again by shape and works in the background. It '
        + 'may take a couple of minutes and suggested redactions will appear '
        + 'in amber.';
      return;
    }

    button.hidden = true;
    note.textContent = state.sweepAdded === 0
      ? 'The thorough check found nothing the reading had missed.'
      : 'The thorough check added ' + state.sweepAdded
        + (state.sweepAdded === 1 ? ' mark' : ' marks')
        + ', outlined in amber. Press Redact to cover '
        + (state.sweepAdded === 1 ? 'it' : 'them') + '.';

    // And what it found but stood down from.
    //
    // The check refuses a spot the page reader has already read as a different
    // word, which is right far more often than it is wrong: on a text report
    // it threw out fifty-four wrong guesses. But when it is wrong — a heading
    // the reader misread confidently — the mark simply never appears, and
    // there is no way to tell that from the check having found nothing there.
    // Saying how many were refused is the difference between "it missed this"
    // and "it decided against this", which are different problems with
    // different answers.
    if (state.sweepRefused) {
      note.textContent += ' ' + state.sweepRefused
        + (state.sweepRefused === 1 ? ' other spot was' : ' other spots were')
        + ' left alone because the page reader had already read '
        + (state.sweepRefused === 1 ? 'it' : 'them')
        + ' as something else. If a mark you expected is missing, that is where'
        + ' to look.';
    }
  }


  el('pick').addEventListener('click', () => setMode(state.mode === 'pick' ? 'box' : 'pick'));
  el('peek-edit').addEventListener('click', () => setPane('edit'));
  el('peek-doc').addEventListener('click', () => setPane('doc'));
  watchSwipes();
  {
    // The document column, which is the only place a pinch means anything.
    const stage = document.querySelector('.stage');
    if (stage) watchPinch(stage);
  }
  // Safari ignores user-scalable and zooms on a pinch anyway, through its own
  // gesture events. Refusing them outright is the only way to keep the whole
  // app from swelling; the document's own pinch is a pointer gesture and is
  // unaffected.
  for (const kind of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(kind, event => event.preventDefault(), { passive: false });
  }
  // The same for a two-finger double tap, which some browsers treat as a zoom
  // even when the viewport forbids scaling.
  document.addEventListener('dblclick', event => {
    if (event.touches || event.pointerType === 'touch') event.preventDefault();
  }, { passive: false });
  placeToolbar();
  setPane(state.pane);
  // Crossing the breakpoint moves the toolbar and decides whether the strips
  // mean anything.
  window.matchMedia(NARROW).addEventListener('change', () => {
    placeToolbar();
    setPane(state.pane);
    updateLivePages();
  });

  el('zoom-in').addEventListener('click', () => stepZoom(1));
  el('zoom-out').addEventListener('click', () => stepZoom(-1));
  setZoom(state.zoom);
  el('tool-pan').addEventListener('click', () => setTool('pan'));
  el('tool-mark').addEventListener('click', () => setTool('mark'));
  setTool(state.tool);

  el('labelling').addEventListener('change', e => {
    state.labelling = e.target.checked;
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
  el('apply').addEventListener('click', applyButton);
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      // Not while typing into a text box — there, undo means the box's own.
      // This used to name TEXTAREA alone, from when the words were typed into
      // one; the words box is an input now, and so are the file name and the
      // placeholder fields, where an undo that quietly reinstated a redaction
      // instead of undoing a keystroke would be the worst kind of surprise.
      const focused = document.activeElement;
      const tag = focused && focused.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || (focused && focused.isContentEditable)) {
        return;
      }
      event.preventDefault();
      undoLast();
    }
  });

  el('export').addEventListener('click', exportFile);
  el('savedraft').addEventListener('click', saveDraft);
  // The sample slide on the front page, shown large.
  //
  // Anyone deciding whether to hand this a confidential document should be
  // able to see what it produces first, and at thumbnail size the labels —
  // which are the point — are not readable.
  {
    const box = el('samplebox');
    const show = () => {
      box.hidden = false;
      el('sampleclose').focus();
    };
    const hide = () => {
      if (box.hidden) return;
      box.hidden = true;
      el('sample-open').focus();
    };
    el('sample-open').addEventListener('click', show);
    el('sampleclose').addEventListener('click', hide);
    // The backdrop is the other way out, and the one people reach for.
    box.addEventListener('click', event => { if (event.target === box) hide(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') hide();
    });
  }

  el('pickstop').addEventListener('click', () => setMode('box'));
  el('imageclose').addEventListener('click', () => { el('imagebox').hidden = true; });
  el('draftpick').addEventListener('click', () => el('file').click());
  el('draftcancel').addEventListener('click', () => {
    pendingDraft = null;
    dropDraftPrompt();
  });
  el('imagebox').addEventListener('click', event => {
    // Clicking the backdrop closes it, the way every other overlay of this
    // shape behaves.
    if (event.target === el('imagebox')) el('imagebox').hidden = true;
  });

  // The answers are a view, not a page.
  //
  // They used to be their own document, and following a link to it unloaded
  // this one — which threw away the open file and its marks, and put the
  // browser's "leave site?" warning in the way of a reviewer who only wanted
  // to read what the tool does. Nothing navigates now, so nothing is lost and
  // there is nothing to warn about.
  const closeFaq = () => show(viewBefore);
  el('faq-open').addEventListener('click', () => {
    if (views.faq.hidden) show('faq'); else closeFaq();
  });
  el('faq-back-bottom').addEventListener('click', closeFaq);

  el('page-prev').addEventListener('click', () => stepPage(-1));
  el('page-next').addEventListener('click', () => stepPage(1));
  el('reset-top').addEventListener('click', async () => {
    // Nothing open means nothing to lose, and a confirmation for that would be
    // the kind of prompt people learn to click through.
    if (state.pages.length || state.text) {
      const exported = state.applied && state.exported;
      const ok = await confirmAction({
        title: 'Open a different file?',
        body: 'The document on screen will be closed, along with every mark on '
          + 'it. Nothing is saved anywhere, so this cannot be undone'
          + (exported ? '.' : ' — and you have not exported it yet.'),
        confirmLabel: 'Close it and choose a file',
      });
      if (!ok) return;
    }
    pendingDraft = null;
    dropDraftPrompt();
    state.pages = [];
    state.text = '';
    state.findings = [];
    dismissedText.clear();
    el('termbox').value = '';
    state.terms = [];
    state.templates = [];
    state.labelOverrides = {};
    state.labels = { byId: {}, entries: [] };
    state.applied = false;
    state.exported = false;
    state.searchedTerms = [];
    undoStack.length = 0;
    refreshUndo();
    setMode('box');
    renderTemplates();
    renderTermCounts();
    show('drop');
  });

  window.Blinded = { state, rescan, loadFile, exportFile, setMode, addTemplate,
    undoLast, undoStack, applyLabels, labelItems, downloadKey,
    sensFor, barFromScores, lowerBarIfEmpty, AUTO_FLOOR, REAL_GAP,
    anchorOn, returnTo, stepPage, refreshPaging,
    watchPinch, pinching, PINCH_IN, wordSensitivity, wordBarFor,
    setZoom, stepZoom, ZOOM_STEPS,
    MARK_GREEN,
    cleanName, coveredText, askName, askPassword, renderPdf, wordLayerFor,
    confirmCrop, redactedName,
    confirmAction, showTemplate,
    addTerm, dropTerm,
    saveDraft, draftData, restoreDraft, looksLikeDraft, fingerprint, takeDraft,
    occurrencesFor, placesFor, renderTermCounts, renderTemplates, goToPage,
    updateLivePages, fitCanvas, releaseCanvas, isLive, displayWidthFor, NEAR_PAGES,
    setPane, placeToolbar, onPhone,
    scrollerFor, setTool, marking,
    runSearch, applyRedaction: runSearch, coverMarks, uncoverMarks, applyButton,
    activeBoxes,
    renderSheet, setOrder, moveTo, nudge, keepOnlyPicked, dropPicked,
    edgeScroll, stopEdgeScroll, CREEP_EDGE,
    addDocument, pickedInOrder, selectPage, thumbFor, organiseStamp,
    markPending, needsSearch, markDuplicates, onePerPlace, plannedCount,
    pendingTemplates,
    termsNeedingPictures,
    readPages, matchOcr, ocrPending, ocrMatchStale, showWordControls,
    sweepTemplates, runSweep, renderSweep, alreadyCovered, readerContradicts,
    READER_SURE, sweepProgress,
    settleSweep,
    redrawAll, legs, leg, busyNote,
    describeTime,
    busy, pageProgress, requestPause,
    renderTermCounts };
})();
