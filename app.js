// Blinded's controller: file in, review, redacted file out.
//
// The review step is the product. Detection is a suggestion engine and it is
// wrong in both directions, so every proposal is visible on the document
// itself and every one of them can be turned off by clicking it. Nothing is
// covered that the reviewer has not seen.
(function () {
  'use strict';

  // Not inside somebody else's page.
  //
  // A meta Content-Security-Policy governs everything the page may reach, but
  // frame-ancestors is the one directive a meta tag cannot carry: it has to
  // arrive with the response, because by the time the markup is being parsed
  // the framing has already happened. The header is sent from render.yaml —
  // and a header is a promise about one deployment, while this is a promise
  // about the program. A copy served from anywhere that forgets it still
  // refuses to run in a frame.
  //
  // What framing buys an attacker here is not the document: a file picker
  // needs a real gesture and the file never leaves the tab either way. It is
  // the chrome around it. Blinded's whole claim is that the reviewer can see
  // what is about to be covered and press Redact themselves, and a page that
  // owns the frame owns everything around that decision — which button the
  // finger lands on, what the screen says the tool is doing, whether the
  // "Blinded" the reviewer thinks they are trusting is this program at all.
  if (window.top !== window.self) {
    document.addEventListener('DOMContentLoaded', () => {
      const say = document.createElement('div');
      say.className = 'framed';
      const head = document.createElement('h1');
      head.textContent = 'Blinded does not run inside another page.';
      const body = document.createElement('p');
      body.textContent = 'You are looking at it through a frame belonging to '
        + 'some other site, which could change what this looks like and what '
        + 'the buttons appear to do. Open it directly instead.';
      const link = document.createElement('a');
      link.href = 'https://blinded.onrender.com/';
      link.target = '_top';
      link.rel = 'noopener';
      link.textContent = 'Open blinded.onrender.com';
      say.append(head, body, link);
      document.body.textContent = '';
      document.body.append(say);
    });
    return;
  }

  const Detect = window.BlindedDetect;
  const PageRole = window.BlindedPageRole;
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
    pages: [],         // { index, source, canvas, widthPt, heightPt, items, findings, hits, manual, texts, dismissed }
    text: '',
    // Which detectors are on. None of them, to begin with.
    //
    // They were all on, which meant a document opened with five red question
    // marks and a red button before the reviewer had asked for anything —
    // five questions the tool had put to itself. Typing a word is an
    // instruction; ticking a detector is the same instruction in a different
    // form, and both should come from the reviewer. 'term' is not a detector
    // and is always on: a word in the list is already the decision.
    enabled: new Set(['term']),
    // Which detectors this search answered, the same way countedTerms records
    // which words it answered. A detector ticked afterwards has no number yet
    // and must not borrow the confidence of the ones that do.
    countedKinds: [],
    terms: [],
    // The pages the reviewer has selected in the Organise sheet. Page objects
    // rather than numbers, because a number stops meaning the same page the
    // moment anything is moved and a selection that quietly retargets is
    // worse than one that is lost.
    picked: new Set(),
    // Choosing several pages by tapping, entered by holding one. A phone has
    // no shift and no ctrl, so without a mode of its own there is no way to
    // select a second page at all.
    choosing: false,
    // Adding a note: the button has been pressed and the next tap on a page
    // says where it goes. One tap's worth of mode, cancelled by Escape.
    placingText: false,
    // The note under the reviewer's hand, and the one with the caret in it.
    // Only one of each, because both are answers to "which one am I talking
    // about" and there is only ever one.
    textSel: null,
    textEdit: null,
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
    // The one mark a tally row is pointing at, while the pointer is on it.
    spotlight: null,
    exported: false,
    redacting: false,
    sweepRunning: false,
    sweepStopped: false,
    sweepReached: 0,
    // True when Comprehensive found nothing left to correlate.
    sweepSkipped: false,
    // True once the post-Search Comprehensive offer was shown or skipped
    // for the current search, so it does not pop again on redraw.
    sweepOfferShown: false,
    // Spots the thorough check proposed and stood down from, so the note can
    // hand the reviewer each one rather than a number.
    sweepRefusedAt: [],
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

  // Whether there is a document open. It decides what the front page is: the
  // way in when there is none, and something to read when there is one.
  function hasDocument() {
    return Boolean(state.pages.length || state.text);
  }

  function show(name) {
    for (const key of Object.keys(views)) views[key].hidden = key !== name;

    // The front page, visited from an open document, is the same page with the
    // drop zone taken out. Offering somewhere to drop a file to someone who
    // has one open is offering to throw their work away, in the shape of an
    // invitation.
    const reading = name === 'drop' && hasDocument();
    el('drop').hidden = reading;
    if (reading) el('drop-error').hidden = true;

    // Away from the tool — on the questions page or on the front page while a
    // document waits — there is one thing worth offering, which is the way
    // back. Reset and Home belong beside the document, not on the pages you
    // read instead of it: Reset would offer to throw away work the reviewer is
    // not even looking at, and Home is where they already are.
    const away = name === 'faq' || reading;
    el('faq-open').textContent = away ? 'Back to the tool' : 'Q\u0026A';
    el('home-top').hidden = name !== 'review';
    el('reset-top').hidden = name !== 'review';
    // Reviewing is a fixed-height layout: the header and the export bar stay
    // put and the panel and the document each scroll on their own. The front
    // page is an ordinary scrolling page, so the class comes and goes with the
    // view rather than living on the body for good.
    document.body.classList.toggle('reviewing', name === 'review');
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
      if (error && error.blindedCancelled) { showTool('drop'); return; }
      // A failure here means the document was not fully understood, and a
      // partial review is worse than none: it looks complete.
      fail('That file could not be opened: ' + (error && error.message ? error.message : String(error))
        + '. Nothing was redacted.');
      showTool('drop');
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
    state.sweepRefused = 0;
    state.sweepRefusedAt = [];
    state.exported = false;
    state.searched = false;
    state.countedTerms = [];
    state.countedKinds = [];
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
      texts: [],
      turn: 0,
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
    // The panel a document opens into: the four that say what to cover, open;
    // the sheet of pages, shut. Set here rather than left to the markup,
    // because the markup is only right the first time — open a second
    // document after organising the first and the panel would still be in
    // whatever shape that left it.
    openSections();
    if (kind !== 'text') buildPageElements();
    renderSheet();
    showTool('review');
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
  let justAddedPages = null;

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
    // Adding pages re-renders detectors, which would otherwise un-hide that
    // heading while the four sections are rolled into one line above Organise.
    if (organising()) rollSections(true);
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
    document.body.classList.toggle('choosing', state.choosing);
    const fresh = justAddedPages;
    justAddedPages = null;
    for (const page of state.pages) {
      const item = document.createElement('li');
      item.className = 'sheetpage' + (state.picked.has(page) ? ' picked' : '')
        + (fresh && fresh.has(page) ? ' just-added' : '');
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
      // A tick box only while choosing. Shown always, it would say every tap
      // adds to a set, which outside this mode it does not.
      if (state.choosing) {
        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.setAttribute('aria-hidden', 'true');
        button.append(tick);
      }

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.title = 'Drag to move this page';
      grip.setAttribute('aria-hidden', 'true');

      item.append(button, grip);
      host.append(item);
      wireSheetPage(item, page, button, grip);
    }
    refreshSheetBar();
    fitSheet();
  }

  // The four other sections, rolled into one line while the sheet is open.
  //
  // Shutting them was already the rule; this takes the four headings they
  // leave behind and makes them one, which is four rows of the panel handed
  // to the thumbnails. The line says what it is standing in for, so nothing
  // has gone missing — it is a door back, and it says so by naming what is
  // behind it. Clicking it shuts the sheet, which brings all five back.
  // The four sections above the sheet, open, with the sheet shut. This is the
  // shape the panel opens in and the shape it comes back to when the sheet is
  // rolled away.
  function openSections() {
    for (const sect of document.querySelectorAll('details.sect')) {
      sect.open = sect !== el('organisesect');
    }
  }

  function organising() {
    const sheet = el('organisesect');
    return Boolean(sheet && sheet.open);
  }

  function rollSections(rolled) {
    const roll = el('sectroll');
    if (!roll) return;
    const others = [...document.querySelectorAll('details.sect')]
      .filter(sect => sect !== el('organisesect'));
    // Read off the headings themselves rather than written out here, so that
    // renaming a section cannot leave this line describing the old panel.
    const names = others
      .map(sect => (sect.querySelector('.s-title') || {}).textContent || '')
      .filter(Boolean);
    roll.textContent = names.join(', ');
    roll.hidden = !rolled;
    roll.setAttribute('aria-expanded', rolled ? 'false' : 'true');
    roll.title = rolled ? 'Show ' + names.join(', ') + ' again' : '';
    for (const sect of others) sect.hidden = rolled;
    if (!rolled) renderKinds();
  }

  // How tall the thumbnails may be: everything the panel has left below them.
  //
  // Measured rather than declared, because the CSS that would say this cannot
  // reach through a <details> — see the note in the stylesheet. The sheet is
  // the last thing in the panel, so where it starts does not depend on how
  // tall it is, and there is no loop to settle.
  function fitSheet() {
    const sheet = el('sheet');
    const panel = document.querySelector('.panel');
    if (!sheet || !panel) return;
    // On a phone the panel is the whole page and the page's own scroll is the
    // right one to use; capping the sheet there would put a small scrolling
    // box inside a screen that already scrolls.
    if (!el('organisesect').open || onPhone()) {
      sheet.style.maxHeight = '';
      return;
    }
    // A floor, so a short window leaves a sheet that can still be worked in
    // rather than a two-row slot; below that the panel scrolls again, which is
    // the lesser of the two problems.
    const FLOOR = 150;
    const room = panel.getBoundingClientRect();
    const from = sheet.getBoundingClientRect().top;
    let space = Math.max(FLOOR, room.bottom - from - 14);
    sheet.style.maxHeight = Math.round(space) + 'px';

    // Then check, rather than trust the arithmetic. Padding, borders and the
    // rounding of a sub-pixel layout each cost a little, and a panel left over
    // by two pixels has a scrollbar just as surely as one left over by fifty —
    // which is the whole thing this was meant to prevent. Measured: the first
    // pass came out a few pixels long every time.
    const over = panel.scrollHeight - panel.clientHeight;
    if (over > 0 && space - over >= FLOOR) {
      sheet.style.maxHeight = Math.round(space - over) + 'px';
    }
  }

  function refreshSheetBar() {
    const picked = pickedInOrder();
    const n = picked.length;
    const only = state.pages.length;
    const row = el('sheet-picked');
    row.hidden = n === 0 && !state.choosing;
    el('picked-note').textContent = !n
      ? 'Tap the pages you want.'
      : n === 1 ? 'Page ' + (picked[0].index + 1) + ' selected.'
        : n + ' pages selected.';
    el('choose-done').hidden = !state.choosing;
    el('page-turn').disabled = !n;
    // Keeping only everything is a no-op, and removing everything leaves no
    // document at all — neither is offered rather than refused after the fact.
    el('page-keep').disabled = !n || n === only;
    el('page-drop').disabled = !n || n === only;
  }

  // Click to select, shift-click for a run, ctrl or cmd-click to add one on
  // its own. The anchor is the last page clicked without shift, which is what
  // every file list does and therefore what the hand expects.
  let sheetAnchor = null;

  function selectPage(page, event) {
    // While choosing, a tap is a tick and nothing else. Following the page in
    // the document as well would send the reviewer somewhere new on every
    // page they add to a set, which is the opposite of what picking a set is.
    if (!state.choosing) goToPage(page.index, { stay: true });
    const spread = event && event.shiftKey;
    // Ctrl or cmd adds one where there is a keyboard; while choosing, every
    // tap does, which is the same rule with the modifier held down for you.
    const add = state.choosing || (event && (event.metaKey || event.ctrlKey));
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

  // Holding a page starts choosing several.
  //
  // Selecting more than one page needed shift or ctrl, which a phone does not
  // have — so on a phone the sheet could select exactly one page, and Keep
  // only these and Remove these were controls for a job that could not be
  // set up. Holding a thumbnail is how every photo roll answers this, and it
  // costs nothing on a laptop, where it sits alongside the modifiers rather
  // than replacing them.
  const CHOOSE_HOLD = 500;
  const CHOOSE_SLOP = 8;      // a press that wanders this far was a scroll

  // Held at module scope, not on the button, because entering the mode
  // rebuilds the sheet: the tile that was held no longer exists by the time
  // its own click arrives, and the fresh one in its place knows nothing about
  // the hold. Measured — holding a page ticked it and letting go un-ticked it
  // again, which looked exactly like the hold not working at all.
  let heldAt = 0;
  const HOLD_ECHO = 600;

  function startChoosing(page) {
    state.choosing = true;
    state.picked.add(page);
    sheetAnchor = page;
    heldAt = Date.now();
    renderSheet();
  }

  function stopChoosing() {
    if (!state.choosing) return;
    state.choosing = false;
    state.picked.clear();
    sheetAnchor = null;
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
    // The hold and the tap are the same gesture until they are not, so the
    // press is timed and the click is swallowed if the timer won.
    let holdTimer = null;
    let answered = false;
    let from = null;
    const forget = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };
    button.addEventListener('pointerdown', event => {
      forget();
      answered = false;
      from = { x: event.clientX, y: event.clientY };
      if (state.choosing) return;   // already choosing: a tap is enough
      holdTimer = setTimeout(() => {
        answered = true;
        startChoosing(page);
      }, CHOOSE_HOLD);
    });
    button.addEventListener('pointermove', event => {
      if (!from) return;
      const away = Math.hypot(event.clientX - from.x, event.clientY - from.y);
      if (away > CHOOSE_SLOP) forget();
    });
    for (const end of ['pointerup', 'pointercancel', 'pointerleave']) {
      button.addEventListener(end, forget);
    }
    button.addEventListener('click', event => {
      event.preventDefault();
      // The hold already did the choosing; the click that ends it is not a
      // second instruction. Answered by the clock rather than by this
      // closure, which the hold's own re-render has already thrown away.
      if (answered || Date.now() - heldAt < HOLD_ECHO) {
        answered = false;
        heldAt = 0;
        return;
      }
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
      const gapOf = point => sheetGapAt(point, host);

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

  // Where the sheet's edges actually are on screen.
  //
  // Not where its box says they are. On a laptop the sheet is capped to the
  // panel and the two agree; on a phone it is as tall as its contents and the
  // bottom of the box is somewhere below the fold — measured on a 20-page
  // document in a 844-pixel window, the box ended at 1990. So the edge the
  // code was watching was one no finger could ever reach, and dragging to the
  // bottom of the screen scrolled nothing at all.
  //
  // The edge that matters is where the sheet stops being visible: the box,
  // clipped by every scrolling ancestor and finally by the window.
  function creepEdges(host) {
    const box = host.getBoundingClientRect();
    let top = box.top;
    let bottom = box.bottom;
    for (let node = host.parentElement; node; node = node.parentElement) {
      if (!/(auto|scroll|hidden)/.test(getComputedStyle(node).overflowY)) continue;
      const around = node.getBoundingClientRect();
      top = Math.max(top, around.top);
      bottom = Math.min(bottom, around.bottom);
    }
    return { top: Math.max(top, 0), bottom: Math.min(bottom, window.innerHeight) };
  }

  // Scrolls whichever thing can actually move. The sheet where it has room,
  // then out through its ancestors, then the window — on a phone the sheet
  // does not scroll at all and the panel is what gives.
  function pushScroll(host, by) {
    for (let node = host; node; node = node.parentElement) {
      const before = node.scrollTop;
      node.scrollTop += by;
      if (node.scrollTop !== before) return true;
    }
    const before = window.scrollY;
    window.scrollBy(0, by);
    return window.scrollY !== before;
  }

  function edgeScroll(host, event, onScroll) {
    stopEdgeScroll();
    const edges = creepEdges(host);
    const above = event.clientY - edges.top;
    const below = edges.bottom - event.clientY;
    let way = 0;
    if (above < CREEP_EDGE) way = -(1 - Math.max(0, above) / CREEP_EDGE);
    else if (below < CREEP_EDGE) way = 1 - Math.max(0, below) / CREEP_EDGE;
    if (!way) return;

    const step = () => {
      pushScroll(host, Math.round(way * CREEP_STEP));
      if (onScroll) onScroll();
      edgeTimer = requestAnimationFrame(step);
    };
    edgeTimer = requestAnimationFrame(step);
  }

  function stopEdgeScroll() {
    if (edgeTimer !== null) cancelAnimationFrame(edgeTimer);
    edgeTimer = null;
  }

  // Which gap a pointer is over, counted as the drop line uses it: 0 is
  // before the first page, n is after the last. Shared by dragging a page
  // and dropping a file onto the sheet, so the two land in the same place.
  function sheetGapAt(point, host) {
    const tiles = [...(host || el('sheet')).querySelectorAll('.sheetpage')];
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
  }

  // Last gap a file-drag was over, so drop uses the line the reviewer saw
  // rather than a layout that has already moved.
  let lastFileGap = -1;

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

  // ---------- turning a page ----------
  //
  // A page arrives sideways often enough — a scan fed the wrong way, a
  // landscape exhibit in a portrait bundle — and until now the only answer
  // was to go back to whatever made the PDF. It matters more here than in a
  // viewer: the reader cannot read sideways lettering, so a sideways page is
  // a page the search is blind on.
  //
  // The turn is real. The pixels are rotated and the page is that shape from
  // then on, because everything downstream — the reader, the matcher, the
  // export — works on those pixels, and a page that was only *displayed*
  // turned would be searched in the orientation nobody can read.
  //
  // What rotates exactly, and what cannot:
  //
  //   Boxes rotate exactly. A mark, a picked logo's patch and a note are
  //   rectangles over pixels, and the pixels moved in a way rectangles
  //   survive.
  //
  //   The text layer does not. Its runs carry a position and an advance, and
  //   the advance is along the page's x axis; turned, the words run down the
  //   page and every rectangle built from them would be drawn across it. So
  //   the layer is dropped, along with what was read off the page, and the
  //   turned page is searched again from its new pixels. That is the cost,
  //   and it is stated here rather than hidden: turning a page after a search
  //   asks for the search again.
  function turnPage(page) {
    const was = page.source;
    const canvas = document.createElement('canvas');
    canvas.width = was.height;
    canvas.height = was.width;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Move the origin to the top right and turn: the old top-left corner ends
    // up there, which is what a quarter clockwise means.
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(was, 0, 0);

    const tall = was.height;
    page.source = canvas;
    page.thumb = null;
    page.thumbFrom = null;
    page.turn = ((page.turn || 0) + 90) % 360;
    const wide = page.widthPt;
    page.widthPt = page.heightPt;
    page.heightPt = wide;

    page.manual = page.manual.map(box => ({ ...box, ...Boxes.turn(box, tall) }));
    page.imageHits = page.imageHits.map(match =>
      match.rect ? { ...match, rect: Boxes.turn(match.rect, tall) } : match);
    // A note stays the right way up. Its words were written to be read, and a
    // page turned to be read should not turn them out of reach; only where
    // the note sits moves, by its middle, so it stays over what it was about.
    page.texts = notesOf(page).map(note => {
      const box = Render.textBox(note);
      const middle = Boxes.turn({ x: note.x, y: note.y, w: box.w, h: box.h }, tall);
      return { ...note,
        x: middle.x + middle.w / 2 - note.w / 2,
        y: middle.y + middle.h / 2 - box.h / 2 };
    });
    for (const template of state.templates) {
      if (state.pages[template.pageIndex] === page && template.rect) {
        template.rect = Boxes.turn(template.rect, tall);
      }
    }

    page.items = [];
    page.text = '';
    page.findings = [];
    page.hits = [];
    page.ocrItems = null;
    page.ocrText = null;
    page.ocrPlaced = null;
    page.ocrSkipped = false;
  }

  // Everything a turn changes about one page, kept so that Undo can put it
  // back. Turning three more times would not do it: the text layer and the
  // reading are thrown away by the first turn and no amount of turning brings
  // them back.
  const PAGE_KEPT = ['source', 'thumb', 'thumbFrom', 'widthPt', 'heightPt', 'turn',
    'items', 'text', 'findings', 'hits', 'manual', 'imageHits', 'texts',
    'ocrItems', 'ocrText', 'ocrPlaced', 'ocrSkipped'];

  function pageSnapshot(page) {
    const kept = {};
    for (const key of PAGE_KEPT) kept[key] = page[key];
    return kept;
  }

  function turnPages() {
    const turning = pickedInOrder();
    if (!turning.length) return;
    const before = turning.map(page => ({ page, kept: pageSnapshot(page) }));
    const templates = state.templates.map(t => ({ template: t, rect: t.rect }));
    const knew = { searched: state.searched, swept: state.sweptTerms.slice(),
      read: state.ocrRead };

    for (const page of turning) turnPage(page);
    // The turned pages have to be read again, and only they do: the reader
    // skips pages that already have their words. A search that has been run
    // no longer covers the document, so it is withdrawn rather than left
    // standing over pages it has never seen in this orientation.
    state.ocrRead = false;
    state.searched = false;
    state.sweptTerms = [];

    pushUndo(turning.length === 1 ? 'turning a page' : 'turning ' + turning.length + ' pages',
      () => {
        for (const { page, kept } of before) Object.assign(page, kept);
        for (const { template, rect } of templates) template.rect = rect;
        state.searched = knew.searched;
        state.sweptTerms = knew.swept;
        state.ocrRead = knew.read;
        rebuildAfterOrder();
      });
    rebuildAfterOrder();
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

  // Merging another document in. Dropped onto the sheet, the new pages go in
  // the gap under the pointer. From the toolbar button they go after the last
  // selected page, so that "put these in the middle" needs no second step;
  // with nothing selected they go on the end, which is what appending means.
  function isPageFile(file) {
    if (!file) return false;
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
      || /^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);
  }

  function wrapAddedPages(fresh) {
    return fresh.map(p => ({
      ...p,
      uid: nextPageUid++,
      source: p.canvas,
      canvas: null,
      findings: [],
      hits: [],
      imageHits: [],
      manual: [],
      texts: [],
      turn: 0,
      dismissed: new Set(),
    }));
  }

  async function pagesFromFile(file) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return renderPdf(bytes, (n, total) =>
        pageProgress(n - 1, total, 'Rendering pages'));
    }
    if (/^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
      return [await loadImage(file)];
    }
    return null;
  }

  async function addDocuments(files, at) {
    const wanted = [...(files || [])].filter(isPageFile);
    if (!wanted.length) {
      fail('Pages can be added from a PDF or an image. A text file has no pages to add.');
      return;
    }
    let added = [];
    try {
      busy(true, wanted.length === 1
        ? (/pdf/i.test(wanted[0].type || wanted[0].name) ? 'Reading the PDF…' : 'Reading the image…')
        : 'Reading the files…');
      busyNote('Your file is being rendered locally on your device. Nothing is uploaded.');
      for (const file of wanted) {
        const fresh = await pagesFromFile(file);
        if (fresh && fresh.length) added = added.concat(wrapAddedPages(fresh));
      }
    } catch (error) {
      if (error && error.blindedCancelled) return;
      fail('That file could not be added: '
        + (error && error.message ? error.message : String(error)));
      return;
    } finally {
      busy(false);
    }
    if (!added.length) return;
    const picked = pickedInOrder();
    let insertAt = typeof at === 'number'
      ? at
      : (picked.length ? picked[picked.length - 1].index + 1 : state.pages.length);
    insertAt = Math.max(0, Math.min(state.pages.length, insertAt));
    justAddedPages = new Set(added);
    const next = state.pages.slice(0, insertAt).concat(added, state.pages.slice(insertAt));
    setOrder(next, added.length === 1 ? 'adding a page' : 'adding ' + added.length + ' pages');
  }

  async function addDocument(file, at) {
    if (!file) return;
    return addDocuments([file], at);
  }

  // ---------- detection ----------

  function acceptedKinds() {
    return Array.from(state.enabled).filter(k => k !== 'term');
  }

  // Layout roles from OCR (preferred) or text-layer items. Used only to
  // suppress detector false positives in chart / logo-grid ink — never to
  // change what OCR reads or how Images search.
  function rolesForPage(page) {
    const ocr = page.ocrPlaced;
    if (ocr && ocr.length) {
      const w = (page.canvas && page.canvas.width) || page.width || page.widthPt || 1;
      const h = (page.canvas && page.canvas.height) || page.height || page.heightPt || 1;
      return PageRole.classify(ocr, w, h);
    }
    const items = page.items || [];
    if (!items.length) return null;
    const mapped = items.map(it => ({
      str: it.str,
      rect: {
        x: it.x,
        y: it.y - (it.h || 10),
        w: it.w,
        h: it.h || 10,
      },
    }));
    const w = page.width || page.widthPt || 1;
    const h = page.height || page.heightPt || 1;
    return PageRole.classify(mapped, w, h);
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
        const roles = rolesForPage(page);
        page.roles = roles;
        const proposed = scanText(page.text);
        page.findings = proposed.filter(f => {
          const rects = Boxes.boxesForSpans(page.items, [f], { advance: measure });
          const union = PageRole.unionRects(rects);
          return PageRole.allowDetector(roles, f.kind, union);
        });
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

  // What to look for has changed, so the current question is unanswered.
  // Outlines from the last search stay on the page; new work waits behind
  // a red ? until Search runs again.
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
        + 'italic and on small lettering – check the marks before exporting.';
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

  // Is there reading still to do?
  //
  // It used to ask only about typed words, which quietly made the detectors
  // second-class: on a document with a picked logo and nothing typed, the
  // pages were never read at all, so every detector was answered from the
  // text layer alone — and on a scan, where there is no text layer, answered
  // with nothing. The panel then reported no email addresses on a page that
  // plainly shows one, which is the failure this tool exists to prevent.
  //
  // The reading is one job with two customers. A word to find in the pictures
  // wants it, and so does every detector, since a detector can only read what
  // the page says once something has read it.
  function ocrPending() {
    if (state.kind === 'text' || !state.useOcr) return false;
    const wanted = (state.termImages && state.terms.length > 0)
      || acceptedKinds().length > 0;
    if (!wanted) return false;
    return !state.ocrRead || ocrMatchStale();
  }

  // Work Search still has to do, even if an earlier press already set
  // `searched`. Ticking detectors after a run that never read the pages used
  // to leave the button on Redact over a row of red ? marks.
  function searchPending() {
    if (state.kind === 'text') return !state.searched;
    const unsearched = state.templates.filter(t => !t.searched).length
      + termsNeedingPictures().length
      + (ocrPending() ? 1 : 0);
    return !state.searched || unsearched > 0 || unknownKinds() > 0;
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
    const searching = searchPending();

    // One button, three states, and it says which one it is in: Search finds
    // things and proposes them, Redact covers what was proposed, and Redacted
    // is a state the reviewer can step back out of rather than a dead end.
    button.textContent = searching ? 'Search'
      : state.applied ? 'Redacted' : 'Redact';
    // How many red question marks are on the panel right now. A word that no
    // search has counted yet and a picked image nothing has looked for each
    // draw one, and this is the same predicate the circles themselves render
    // from, so the two cannot disagree.
    const unanswered = state.terms.filter(t => !state.countedTerms.includes(t)).length
      + state.templates.filter(t => !t.searched).length
      + unknownKinds();

    // The button wears the panel's red only while there is a red ? for it to
    // answer. Red with nothing outstanding is an alarm about nothing: the
    // reviewer who has just deleted their last word does not need the footer
    // shouting at them. With nothing to find it is an ordinary blue button,
    // which is what it will be for the next press anyway.
    button.classList.toggle('hunt', searching && unanswered > 0);
    button.classList.toggle('done', !searching && state.applied);
    button.title = !searching && state.applied ? 'Press to uncover and look at the marks again' : '';
    // Not while the comprehensive check is running: it is a pass over the same
    // pages, and the two cannot both own the document. Stopping it is a button
    // in the panel, not a dialog thrown in front of this one.
    button.disabled = state.sweepRunning || (searching
      ? state.kind !== 'text' && !state.pages.length
      : !state.applied && marks === 0 && unsearched === 0);
    if (state.sweepRunning) {
      button.title = 'The comprehensive check is running  - let it finish, '
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
    } else if (searching) {
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
        + ' pages read  - press Search to carry on.';
    } else if (unsearched) {
      note.textContent = unsearched === 1
        ? '1 search still to run.'
        : unsearched + ' searches still to run.';
    } else if (marks === 0) {
      note.textContent = 'Nothing marked yet.';
    } else {
      note.textContent = 'Outlined  - press Redact to cover them.';
    }
  }

  // How many things are currently marked, whether or not they have been
  // applied. Image matches only exist once their search has run.
  function plannedCount() {
    if (state.kind === 'text') {
      return state.findings.filter(f => !dismissedText.has(f.id) && findingAnswered(f)).length;
    }
    return state.pages.reduce((sum, page) =>
      sum + page.hits.filter(h => !page.dismissed.has(h.finding.id)
          && findingAnswered(h.finding)).length
        + liveImageHits(page).filter(m => !page.dismissed.has(m.id)
          && imageHitAnswered(m)).length
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

    state.sweepOfferShown = false;
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
        detectOcr();
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
    // And which detectors. Only the ticked ones were looked for, so only they
    // have an answer.
    state.countedKinds = acceptedKinds();
    state.redacting = false;
    // The word list shows a tally only once something has counted, so it has
    // to be redrawn when that becomes true. The detectors are the same now
    // that they read what OCR read: they wait on this search too, and without
    // this they sat showing a question mark over an answer they already had.
    renderTermCounts();
    renderKinds();
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
    // Offer Comprehensive once the overlay is down so the choice is not
    // buried under "Working…". Skip stays available from the panel button.
    offerSweepAfterSearch();
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
    if (state.applied && !searchPending()) { uncoverMarks(); return; }
    if (searchPending()) {
      if (state.applied) markPending();
      await runSearch();
      return;
    }
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
      const spans = Detect.resolveOverlaps(Detect.findTerms(page.ocrText, state.terms, { fromOcr: true }));
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

  // The detectors, over what OCR read.
  //
  // They only ever ran on the PDF's own text layer, which means that on a
  // scanned page — the contact sheet at the back of a CIM, a photographed
  // slide — they found nothing at all. OCR was already reading those pages
  // and already mapping what it read back to boxes; it was just that only
  // typed words were being looked for in it. An email address painted into a
  // screenshot is as much an email address as one in the text layer.
  //
  // Kinds are not filtered here. A detector the reviewer has switched off
  // still has its findings collected and then dropped by acceptable(), so
  // that switching it back on does not require another pass over the
  // document.
  function detectOcr() {
    for (const page of state.pages) {
      page.imageHits = page.imageHits.filter(m => !m.detector);
      if (!page.ocrText || !page.ocrPlaced) continue;
      // Roles from this page's OCR layout — suppress chart/logo-grid FPs only.
      const roles = rolesForPage(page);
      page.roles = roles;
      const found = Detect.findAll(page.ocrText, { kinds: acceptedKinds(), fromOcr: true });
      // What the text layer already gave up, so that reading the page again
      // does not report it a second time.
      //
      // Compared by what it says rather than by where it sits. The geometric
      // check that catches a duplicate logo needs nine tenths of one box
      // inside another, and a text-layer box and an OCR box around the same
      // address never agree that closely — one comes from font metrics and
      // the other from ink. So every email on a contact page was found twice,
      // listed twice, and covered twice.
      const already = new Set((page.findings || [])
        .map(f => f.kind + '\u0000' + f.text.replace(/\s+/g, ' ').trim().toLowerCase()));

      for (const span of found) {
        const said = span.kind + '\u0000'
          + span.text.replace(/\s+/g, ' ').trim().toLowerCase();
        if (already.has(said)) continue;
        const wordRects = [];
        for (const item of page.ocrPlaced) {
          if (item.start >= span.end || item.end <= span.start) continue;
          wordRects.push(item.rect);
        }
        const union = PageRole.unionRects(wordRects);
        if (!PageRole.allowDetector(roles, span.kind, union)) continue;
        already.add(said);
        // One finding, however many words it is drawn in. The boxes are per
        // word because a box is what covers ink, but the thing found is one
        // thing and the panel counts things.
        const groupId = 'read:' + span.kind + ':' + page.index + ':' + span.start;
        for (const item of page.ocrPlaced) {
          if (item.start >= span.end || item.end <= span.start) continue;
          // Whole words, for the reason the term matcher covers whole words:
          // OCR reports one box per word, and dividing it by letter count is
          // wrong in the direction that leaves a letter showing.
          page.imageHits.push({
            id: groupId + ':' + Math.round(item.rect.x) + ':' + Math.round(item.rect.y),
            group: groupId,
            detector: span.kind,
            text: span.text,
            rect: { ...item.rect },
            score: 1,
            read: true,
          });
        }
      }
    }
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
      // Kept on the image it is about, and rendered on that image's row.
      // It used to be written into one line under the pick button, which
      // three picked images shared: the third search overwrote the second,
      // and what the reviewer read was the last one's story under all of
      // them, attributed to nothing.
      entry.logo.report = {
        scores: found.matches.map(m => m.score),
        near: (found.near || []).map(hit => hit.score),
        best: found.best,
        bar: sensFor(entry.logo),
        autoBar: autoBar === undefined ? null : autoBar,
      };
      // The line under the pick button described whichever image searched
      // last. It says nothing now: every sentence it carried belongs to one
      // image, and sits on that image's row.
      clearPickHint();
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
  // What one image's search found, as a sentence.
  //
  // Built from what was stored on the template rather than written at search
  // time, so it can be drawn again whenever the row is — when the slider
  // moves, when another image is picked, when the panel is rebuilt.
  function reportFor(template) {
    const report = template && template.report;
    if (!report) return null;
    const scores = report.scores || [];
    if (!scores.length) {
      const best = report.best > 0 ? report.best.toFixed(2) : null;
      return {
        warn: true,
        text: best
          ? 'No match at ' + clampSens(report.bar).toFixed(2) + '. The closest '
            + 'thing scored ' + best + ' \u2013 lower the bar below that to include it.'
          : 'Nothing resembling this was found anywhere in the document.',
      };
    }

    const low = Math.min(...scores), high = Math.max(...scores);
    let text = scores.length === 1
      ? 'One match, scoring ' + high.toFixed(2) + '.'
      : scores.length + ' matches, scoring ' + high.toFixed(2)
        + ' down to ' + low.toFixed(2) + '.';

    // And what the bar turned away, which is the half that says where to put
    // it. Only the ones close enough to be worth a nudge: a picked mark turns
    // up dozens of weak echoes of itself, and 0.67 against a bar of 0.99 is
    // not a near miss.
    const NEARLY = 0.08;
    const near = (report.near || [])
      .filter(score => score >= clampSens(report.bar) - NEARLY)
      .sort((a, b) => b - a);
    if (near.length) {
      const top = near[0], bottom = near[near.length - 1];
      text += ' ' + near.length + ' more scored '
        + (near.length === 1 || top.toFixed(2) === bottom.toFixed(2)
          ? top.toFixed(2)
          : top.toFixed(2) + ' down to ' + bottom.toFixed(2))
        + ' and ' + (near.length === 1 ? 'was' : 'were')
        + ' left out \u2013 lower the bar past ' + top.toFixed(2) + ' to include '
        + (near.length === 1 ? 'it.' : 'them.');
    } else if (low - clampSens(report.bar) > 0.015) {
      text += ' Nothing landed between the bar at ' + clampSens(report.bar).toFixed(2)
        + ' and the weakest of these, so it has room to move up.';
    }

    if (report.autoBar !== null && report.autoBar !== undefined) {
      text = 'Nothing matched at the setting it was on, so the bar came down to '
        + report.autoBar.toFixed(2) + '. ' + text
        + ' Move the slider if that is not what you wanted.';
    }
    return { warn: false, text };
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


    refreshSheetBar();

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
        .filter(f => !dismissedText.has(f.id) && findingAnswered(f))
        .map(f => ({ id: f.id, kind: f.kind, text: f.text, term: f.term }));
    }

    const items = [];
    for (const page of state.pages) {
      for (const hit of page.hits) {
        if (page.dismissed.has(hit.finding.id) || !findingAnswered(hit.finding)) continue;
        items.push({
          id: hit.finding.id,
          kind: hit.finding.kind,
          text: hit.finding.text,
          term: hit.finding.term,
        });
      }
      for (const match of liveImageHits(page)) {
        if (page.dismissed.has(match.id) || !imageHitAnswered(match)) continue;
        // A picture of a typed word is that word, so it is labelled as one and
        // shares a placeholder with every written occurrence of it. Anything
        // else is a picked logo.
        if (match.term) items.push({ id: match.id, kind: 'term', term: match.term, text: match.term });
        // Something a detector found in what OCR read. It is the same kind of
        // thing as the one found in the text layer, so it takes the same kind
        // of placeholder.
        else if (match.detector) items.push({ id: match.id, kind: match.detector, text: match.text });
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
      what.title = entry.description + (entry.value ? ' – "' + entry.value + '"' : '');

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
    const tally = {};
    const count = (text, seen) => {
      if (!text) return;
      for (const f of Detect.findAll(text, { terms: state.terms })) {
        // The same address in the text layer and again in what OCR read is
        // one address. Counted twice it would say the page holds twice what
        // it holds, and the number beside a detector is the only thing the
        // reviewer has to judge it by.
        const key = f.kind + '\u0000' + f.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tally[f.kind] = (tally[f.kind] || 0) + 1;
      }
    };
    if (state.kind === 'text') { count(state.text, new Set()); return tally; }
    for (const page of state.pages) {
      const seen = new Set();
      count(page.text, seen);
      count(page.ocrText, seen);
    }
    return tally;
  }

  // Whether those numbers are answers yet.
  //
  // They used to be, always: the detectors read the text layer, which is there
  // the moment the file opens. Now they also read what OCR reads, and OCR
  // happens during the search — so before it, a number would be a count of
  // half the document presented as a count of all of it. A red question mark
  // says the honest thing instead, which is the same thing the term counts and
  // the picked images say while they are waiting.
  // How many red question marks the detectors are showing.
  //
  // Every detector wears one until a search has run — that is the whole point
  // of them being question marks — and the button that answers them was not
  // counting them. A freshly opened document put five red marks on the panel
  // and left the button an ordinary blue, which says "nothing outstanding"
  // over a panel full of outstanding questions.
  function unknownKinds() {
    if (state.kind === 'text' || !state.pages.length) return 0;
    // Counted the way they are drawn: a detector wears a red ? only if it is
    // ticked and nothing has looked for it yet, so the number here is the
    // number on screen.
    return acceptedKinds().filter(kind => !kindAnswered(kind)).length;
  }

  // Has this detector been looked for, as things stand?
  //
  // Per detector rather than per document, because they are now ticked one at
  // a time: ticking Names of people after a search is the same act as typing
  // a new word, and it has the same answer — nothing knows yet, press Search.
  function kindAnswered(kind) {
    return state.kind === 'text' || state.countedKinds.includes(kind);
  }

  // A mark from a search that has already run. New terms, detectors and
  // images wait behind a red ? until Search, but the outlines already on
  // the page stay put rather than vanishing with the button.
  function findingAnswered(finding) {
    if (!finding) return false;
    if (finding.kind === 'term') {
      return state.terms.includes(finding.term)
        && state.countedTerms.includes(finding.term);
    }
    return state.enabled.has(finding.kind) && state.countedKinds.includes(finding.kind);
  }

  function imageHitAnswered(m) {
    if (!m) return false;
    if (m.templateId) {
      const t = state.templates.find(x => x.id === m.templateId);
      return Boolean(t && t.searched);
    }
    if (m.term) {
      return state.terms.includes(m.term) && state.countedTerms.includes(m.term);
    }
    if (m.detector) {
      return state.enabled.has(m.detector) && state.countedKinds.includes(m.detector);
    }
    return false;
  }

  // After the pages have been read, enabling a detector is answered from
  // what is already in hand: rescan covers the text layer, detectOcr covers
  // what OCR read. countedKinds used to stay as it was at Search time, so
  // ticking "All of them" afterwards left every row on a red ? over an
  // answer that had just been computed. Before any reading, a tick is only
  // a request — the ? stays until Search.
  function syncCountedKindsAfterToggle() {
    if (state.kind === 'text' || !state.useOcr || state.ocrRead) {
      state.countedKinds = acceptedKinds();
    }
  }

  // Settled when the pages are already read: both places a detector looks
  // are in hand, so switching one is a question about what to cover. Before
  // that, a tick is only a request — the ? stays, and Search has to run.
  // Ticking "All of them" after a search that never read the pages used to
  // leave Redact showing over the red marks.
  function afterDetectorChange() {
    detectOcr();
    const waiting = acceptedKinds().some(kind => !kindAnswered(kind));
    if (waiting && !state.ocrRead) {
      needsSearch();
    } else {
      rescan({ settled: true });
      syncCountedKindsAfterToggle();
    }
    renderKinds();
    refreshApply();
  }

  function kindsKnown() {
    if (state.kind === 'text') return true;
    return acceptedKinds().every(kind => kindAnswered(kind));
  }

  function renderKinds() {
    const tally = countsByKind();
    // Only the detectors are listed. Words the reviewer typed were once a
    // tenth row with a tick box of its own, which invited exactly one
    // question – why would I type a word and then ask for it not to be
    // covered? Typing a word is the instruction; there is nothing left to
    // agree to. It is always on, and the terms box above shows its own count.
    //
    // Which rows to list.
    //
    // The detectors are ticked one at a time now, so the row is the switch:
    // hiding it would take away the only way to ask for that kind. Every
    // ticked detector is listed, answered or not — and so is any unticked one
    // that turned something up, which is an offer rather than a result: three
    // email addresses are in this document, tick it and they are covered.
    //
    // Before anything has been searched that leaves the whole list, which is
    // what a reviewer choosing what to look for needs to see.
    const answeredAnything = state.countedKinds.length > 0;
    const rows = Detect.KINDS.filter(row => state.enabled.has(row.kind)
      || !answeredAnything || (tally[row.kind] || 0) > 0);
    const host = el('kinds');
    host.textContent = '';

    // The section stands as long as there is anything to decide, which now
    // includes deciding to look: it holds the switches. It goes only when
    // every detector has been asked and none of them found anything, where
    // what is left would be a list of what this tool can do rather than
    // anything about this document.
    const section = el('kindsect');
    if (section) {
      // While Organise has the panel, the four headings stay in the roll line.
      // A rescan after adding pages must not pop Detectors back out on its own.
      section.hidden = organising() || rows.length === 0 || state.kind === 'text';
    }

    // One switch for all of them, above the list.
    //
    // Five taps to ask for everything is four too many, and "look for the lot
    // and let me untick the noise" is how most reviewers work a document they
    // do not know yet. Half-ticked when only some are on, so the row reports
    // the state of the list as well as setting it.
    if (rows.length) host.append(allKindsRow(rows));

    for (const row of rows) {
      const n = tally[row.kind] || 0;
      const label = document.createElement('label');
      label.className = 'kind';
      label.title = row.hint;

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.enabled.has(row.kind);
      box.dataset.kind = row.kind;
      box.addEventListener('change', () => {
        if (box.checked) state.enabled.add(row.kind);
        else state.enabled.delete(row.kind);
        afterDetectorChange();
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.label;

      // The same circle the words and the pictures carry, because it answers
      // the same question and a reviewer should not have to learn that this
      // one is only decoration. Grey said "a number"; green says "found, and
      // here is where".
      const key = 'kind::' + row.kind;
      const ticked = state.enabled.has(row.kind);
      const answered = kindAnswered(row.kind);
      const count = document.createElement('button');
      count.type = 'button';
      // A detector nobody has asked for claims nothing: no question mark, no
      // number. An untouched panel should be quiet — the reviewer has not
      // asked it anything yet.
      //
      // Except where it has something to offer: a kind left unticked that the
      // search turned up anyway shows what it found, so the offer is visible
      // rather than hidden behind a tick nobody knew to make.
      const offering = !ticked && answeredAnything && n > 0;
      count.className = ticked && !answered ? 'n unknown' : 'n dot-green';
      count.textContent = !ticked
        ? (offering ? String(n) : '')
        : answered ? String(n) : '?';
      count.hidden = !ticked && !offering;
      if (ticked && !answered) {
        count.disabled = true;
        count.title = 'Not searched for yet – press Search';
      } else if (!ticked && !offering) {
        count.disabled = true;
      } else {
        const where = placesForKind(row.kind);
        count.disabled = where.length === 0;
        if (!count.disabled) {
          count.title = 'Where they are';
          count.setAttribute('aria-expanded', String(state.openTally === key));
          count.addEventListener('click', event => {
            // Inside a <label>, so a click here would otherwise untick the
            // detector it is reporting on.
            event.preventDefault();
            event.stopPropagation();
            state.openTally = state.openTally === key ? null : key;
            renderKinds();
          });
        }
      }

      label.append(box, name, count);
      host.append(label);
      if (state.openTally === key && !count.disabled) {
        host.append(tallyList(row.label, placesForKind(row.kind)));
      }
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
  function allKindsRow(rows) {
    const label = document.createElement('label');
    label.className = 'kindall';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'kinds-all';
    const on = rows.filter(row => state.enabled.has(row.kind)).length;
    box.checked = on === rows.length;
    // Neither on nor off, because the list is neither.
    box.indeterminate = on > 0 && on < rows.length;
    box.addEventListener('change', () => {
      for (const row of rows) {
        if (box.checked) state.enabled.add(row.kind);
        else state.enabled.delete(row.kind);
      }
      afterDetectorChange();
    });
    const name = document.createElement('span');
    name.className = 'name';
    // The same words whatever state it is in. A label that changes to name
    // the action — "None of them" once everything is on — reads as a report
    // about the list, and the reviewer has to work out which of the two it is
    // doing before they dare press it.
    name.textContent = 'All of them';
    label.title = 'Tick every detector, or clear them all';
    label.append(box, name);
    return label;
  }

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

      // Notes live in their own layer over the canvas rather than being
      // hit-tested on it. Selecting, dragging and above all typing are things
      // the browser already does well, and re-implementing a caret on a canvas
      // to save one div would be a poor trade.
      const layer = document.createElement('div');
      layer.className = 'notelayer';
      page.layer = layer;

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = 'Page ' + (page.index + 1);

      wrap.append(canvas, layer, num);
      host.append(wrap);
      attachDrawing(page, canvas);
      renderNotes(page);
    }
    // Once, now, so the first pages are drawn — and again after a frame, when
    // the wrappers have been laid out and it is possible to tell which pages
    // are actually on screen. Before layout every box is at zero and every
    // page looks near.
    updateLivePages();
    requestAnimationFrame(() => updateLivePages());
  }

  function activeBoxes(page) {
    // Marks from a search that has already answered this term, detector or
    // image stay on the page when the question changes. New unanswered work
    // waits behind a red ? until Search; it is not drawn early (that would
    // outline a word while it is still being typed). Before any search, only
    // hand-drawn boxes show.
    const live = page.hits.filter(h => !page.dismissed.has(h.finding.id)
      && findingAnswered(h.finding));
    const images = liveImageHits(page).filter(m => !page.dismissed.has(m.id)
      && imageHitAnswered(m));

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
    const off = state.applied ? [] : page.hits.filter(h =>
      page.dismissed.has(h.finding.id) && findingAnswered(h.finding));
    const offImages = state.applied
      ? [] : liveImageHits(page).filter(m => page.dismissed.has(m.id)
        && imageHitAnswered(m));
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

    // The mark the panel is pointing at, filled rather than merely outlined.
    //
    // Drawn after the marks and before the notes: it is the same box, said
    // louder, and it has to be legible against a page that may already be
    // covered in green.
    if (state.spotlight && state.spotlight.pageIndex === page.index && !state.applied) {
      const lit = rectsOfMark(page, state.spotlight.mark);
      if (lit.length) {
        ctx.save();
        const amber = lit.some(rect => rect.sweep);
        ctx.fillStyle = amber ? 'rgba(217, 139, 31, 0.45)' : 'rgba(17, 138, 78, 0.42)';
        ctx.strokeStyle = amber ? '#b36f12' : '#0c6b3c';
        ctx.lineWidth = stroke(Math.max(3, page.source.width / 420));
        for (const rect of lit) {
          ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
          ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        }
        ctx.restore();
      }
    }

    // The reviewer's own writing, over the bars and through the same function
    // the export uses. Anything with a caret in it is left to its textarea,
    // which is drawing it already.
    Render.drawTexts(ctx, notesToDraw(page));

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
      // Placing a note is one tap, and it outranks every other meaning a
      // press on the page has: the reviewer pressed a button a moment ago
      // that asked them for exactly this.
      if (state.placingText) {
        event.preventDefault();
        const where = at(event);
        stopPlacingText();
        addNoteAt(page, where.x, where.y);
        return;
      }
      // A press on the page is a press away from whatever note was in hand.
      if (state.textSel) { commitNote(); selectNote(null); }
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
      if (page.dismissed.has(hit.finding.id) || !findingAnswered(hit.finding)) continue;
      if (Boxes.rectAt(hit.rects, x, y) !== -1) {
        page.dismissed.add(hit.finding.id);
        pushUndo('keeping that match', () => page.dismissed.delete(hit.finding.id));
        return;
      }
    }
    for (const m of liveImageHits(page)) {
      if (page.dismissed.has(m.id) || !imageHitAnswered(m)) continue;
      if (Boxes.rectAt([m.rect], x, y) !== -1) {
        page.dismissed.add(m.id);
        pushUndo('keeping that image', () => page.dismissed.delete(m.id));
        return;
      }
    }
    for (const hit of page.hits) {
      if (!page.dismissed.has(hit.finding.id) || !findingAnswered(hit.finding)) continue;
      if (Boxes.rectAt(hit.rects, x, y) !== -1) {
        page.dismissed.delete(hit.finding.id);
        pushUndo('covering that match again', () => page.dismissed.add(hit.finding.id));
        return;
      }
    }
    for (const m of liveImageHits(page)) {
      if (!page.dismissed.has(m.id) || !imageHitAnswered(m)) continue;
      if (Boxes.rectAt([m.rect], x, y) !== -1) {
        page.dismissed.delete(m.id);
        pushUndo('covering that image again', () => page.dismissed.add(m.id));
        return;
      }
    }
  }

  // ---------- notes the reviewer writes on the page ----------
  //
  // One button, and after that the note is its own control. Press Add a note,
  // tap where it goes, type. Tap a note to pick it up and a small bar appears
  // over it — a colour, two sizes, a bin — and goes away again when anything
  // else is touched. Tap a note that is already picked up and the caret goes
  // back into the words. Drag it to move it, drag its corner to set how wide
  // it is.
  //
  // No permanent bar, which is the point: this is a document being reviewed,
  // and a row of drawing tools standing over it the whole time would say
  // otherwise. Controls appear on the thing they control and only while it is
  // in hand.
  //
  // A note is stored in the page's own pixels, like every mark, so it survives
  // zooming, turning and reordering — and it is painted by the function the
  // export uses, so what is on screen is what ends up in the file.

  const NOTE_COLOURS = [
    { name: 'Black', value: '#111111' },
    { name: 'White', value: '#ffffff' },
    { name: 'Red', value: '#c0392b' },
    { name: 'Blue', value: '#1a56db' },
  ];

  // Sizes are a share of the page's width rather than a number of points, so
  // a note is the same size on a scan rendered at 2000 pixels and on one
  // rendered at 800.
  const NOTE_SIZE = 1 / 42;
  const NOTE_WIDEST = 1 / 10;
  const NOTE_SMALLEST = 1 / 120;
  const NOTE_STEP = 1.25;
  const NOTE_WIDTH = 0.34;     // how wide a fresh note is
  const NOTE_MARGIN = 0.02;    // and how close to the edge it is allowed to sit

  let nextNoteId = 1;

  function notesOf(page) {
    if (!page.texts) page.texts = [];
    return page.texts;
  }

  function noteWith(id) {
    for (const page of state.pages) {
      const note = notesOf(page).find(item => item.id === id);
      if (note) return { page, note };
    }
    return null;
  }

  // Snapshot first, mutate after. The whole array is copied because a note is
  // four numbers and a string, and an undo that restores the list wholesale
  // cannot be wrong about which of them changed.
  function noteUndo(page, label) {
    const before = notesOf(page).map(note => ({ ...note }));
    pushUndo(label, () => {
      page.texts = before;
      state.textSel = null;
      state.textEdit = null;
      renderNotes(page);
      drawPage(page);
    });
  }

  function startPlacingText() {
    if (!state.pages.length) return;
    commitNote();
    state.placingText = true;
    state.textSel = null;
    document.body.classList.add('placing-text');
    el('page-text').setAttribute('aria-pressed', 'true');
    // On a phone the panel and the document take turns, and the tap that says
    // where the note goes has to land on the document.
    if (onPhone()) setPane('doc');
    setTip();
  }

  function stopPlacingText() {
    if (!state.placingText) return;
    state.placingText = false;
    document.body.classList.remove('placing-text');
    el('page-text').setAttribute('aria-pressed', 'false');
    setTip();
  }

  function addNoteAt(page, x, y) {
    const width = page.source.width;
    const wide = width * NOTE_WIDTH;
    const margin = width * NOTE_MARGIN;
    const note = {
      id: 'note' + (nextNoteId++),
      // Kept inside the page, so a note placed near the right edge is not
      // written off it.
      x: Math.max(margin, Math.min(x, width - wide - margin)),
      y: Math.max(0, y),
      w: wide,
      size: width * NOTE_SIZE,
      colour: NOTE_COLOURS[0].value,
      text: '',
    };
    noteUndo(page, 'the note you added');
    notesOf(page).push(note);
    state.textSel = note.id;
    renderNotes(page);
    drawPage(page);
    // Straight into typing. A note placed and then waiting to be tapped again
    // before it will take a word is a note the reviewer has to be told about;
    // a caret is its own instruction.
    editNote(note.id);
  }

  // Leaves whatever note is being written. An empty one is thrown away rather
  // than left on the page as an invisible thing to trip over later.
  function commitNote() {
    const id = state.textEdit;
    state.textEdit = null;
    if (!id) return;
    const found = noteWith(id);
    if (!found) return;
    if (!found.note.text.trim()) {
      found.page.texts = notesOf(found.page).filter(note => note.id !== id);
      if (state.textSel === id) state.textSel = null;
    }
    renderNotes(found.page);
    drawPage(found.page);
  }

  function selectNote(id) {
    if (state.textEdit && state.textEdit !== id) commitNote();
    const was = state.textSel;
    state.textSel = id;
    for (const page of state.pages) {
      if (notesOf(page).some(note => note.id === id || note.id === was)) renderNotes(page);
    }
  }

  function editNote(id) {
    const found = noteWith(id);
    if (!found) return;
    state.textSel = id;
    state.textEdit = id;
    renderNotes(found.page);
    drawPage(found.page);
    const area = found.page.layer && found.page.layer.querySelector('.notewrite');
    if (area) { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }
  }

  function dropNote(id) {
    const found = noteWith(id);
    if (!found) return;
    noteUndo(found.page, 'removing that note');
    found.page.texts = notesOf(found.page).filter(note => note.id !== id);
    if (state.textSel === id) state.textSel = null;
    if (state.textEdit === id) state.textEdit = null;
    renderNotes(found.page);
    drawPage(found.page);
  }

  function restyleNote(id, change, label) {
    const found = noteWith(id);
    if (!found) return;
    noteUndo(found.page, label);
    change(found.note, found.page);
    renderNotes(found.page);
    drawPage(found.page);
  }

  function resizeNote(id, by) {
    restyleNote(id, (note, page) => {
      const width = page.source.width;
      note.size = Math.max(width * NOTE_SMALLEST,
        Math.min(width * NOTE_WIDEST, note.size * by));
    }, 'that size');
  }

  // What the canvas draws: every note except the one with a caret in it,
  // which is being drawn by its own textarea and would otherwise appear
  // twice, half a pixel apart.
  function notesToDraw(page) {
    return notesOf(page).filter(note => note.id !== state.textEdit);
  }

  function renderAllNotes() {
    for (const page of state.pages) renderNotes(page);
  }

  // The overlay is rebuilt from the notes rather than adjusted in place. A
  // note is a handful of elements and there are rarely more than a few on a
  // page, and rebuilding means there is one description of what a note looks
  // like instead of one for making it and another for changing it.
  function renderNotes(page) {
    const layer = page.layer;
    if (!layer) return;
    layer.textContent = '';
    const width = page.source.width;
    // Everything is expressed as a share of the page's width, and the CSS
    // reads those with container units. That is what keeps a note in place
    // through zooming and through a phone turning on its side, without a
    // single measurement in JavaScript.
    const share = value => (value / width) * 100;

    for (const note of notesOf(page)) {
      const box = Render.textBox(note);
      const chip = document.createElement('div');
      chip.className = 'notechip';
      chip.dataset.note = note.id;
      chip.style.setProperty('--x', share(note.x));
      chip.style.setProperty('--y', share(note.y));
      chip.style.setProperty('--w', share(note.w));
      chip.style.setProperty('--h', share(box.h));
      chip.style.setProperty('--s', share(note.size));
      chip.style.color = note.colour;

      const chosen = state.textSel === note.id;
      const writing = state.textEdit === note.id;
      chip.classList.toggle('on', chosen);
      // Near the top of the page there is no room above the note for its
      // controls, and the page clips what hangs off it.
      chip.classList.toggle('low', note.y < width * 0.08);

      if (writing) chip.append(noteWriter(page, note));
      if (chosen) {
        chip.append(noteBar(page, note));
        const grab = document.createElement('span');
        grab.className = 'notegrab';
        grab.title = 'Drag to set how wide the note is';
        chip.append(grab);
        wireNoteWidth(page, note, grab);
      }
      wireNote(page, note, chip);
      layer.append(chip);
    }
  }

  function noteWriter(page, note) {
    const area = document.createElement('textarea');
    area.className = 'notewrite';
    area.value = note.text;
    area.rows = 1;
    area.spellcheck = false;
    area.setAttribute('aria-label', 'The note on page ' + (page.index + 1));
    area.placeholder = 'Type your note';
    area.addEventListener('input', () => {
      note.text = area.value;
      // The box grows with the words, through the same measurement the canvas
      // will use, so the outline round the note is where the note will be.
      area.parentElement.style.setProperty('--h',
        (Render.textBox(note).h / page.source.width) * 100);
    });
    area.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); area.blur(); }
    });
    area.addEventListener('blur', () => { if (state.textEdit === note.id) commitNote(); });
    // A press inside the words is not a press on the note: it must not start
    // dragging the thing the caret is in.
    area.addEventListener('pointerdown', event => event.stopPropagation());
    return area;
  }

  function noteBar(page, note) {
    const bar = document.createElement('div');
    bar.className = 'notebar';
    // The bar belongs to the reviewer, not to the note, so it is not tinted
    // by the colour the note is written in.
    bar.style.color = '';
    const stop = event => { event.preventDefault(); event.stopPropagation(); };
    bar.addEventListener('pointerdown', stop);

    for (const colour of NOTE_COLOURS) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'notedot' + (note.colour === colour.value ? ' on' : '');
      dot.style.background = colour.value;
      dot.title = colour.name;
      dot.setAttribute('aria-label', colour.name);
      dot.addEventListener('click', event => {
        stop(event);
        restyleNote(note.id, item => { item.colour = colour.value; }, 'that colour');
      });
      bar.append(dot);
    }

    for (const step of [{ by: 1 / NOTE_STEP, sign: '−', say: 'Smaller' },
      { by: NOTE_STEP, sign: '+', say: 'Bigger' }]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notestep';
      button.textContent = 'A' + step.sign;
      button.title = step.say;
      button.setAttribute('aria-label', step.say);
      button.addEventListener('click', event => { stop(event); resizeNote(note.id, step.by); });
      bar.append(button);
    }

    const bin = document.createElement('button');
    bin.type = 'button';
    bin.className = 'notestep notebin';
    bin.textContent = '✕';
    bin.title = 'Remove this note';
    bin.setAttribute('aria-label', 'Remove this note');
    bin.addEventListener('click', event => { stop(event); dropNote(note.id); });
    bar.append(bin);
    return bar;
  }

  // Where a pointer is, in the page's own pixels. The note layer sits exactly
  // over the canvas, so its box is the page's box.
  function noteSpace(page, event) {
    const rect = page.layer.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (page.source.width / rect.width),
      y: (event.clientY - rect.top) * (page.source.height / rect.height),
      // Page pixels per screen pixel, for anything that has to think in
      // screen distances — how far a press wandered, say.
      scale: page.source.width / rect.width,
    };
  }

  const NOTE_SLOP = 4;         // a press that wanders this far was a drag

  function wireNote(page, note, chip) {
    let from = null;
    let moved = false;

    chip.addEventListener('pointerdown', event => {
      if (state.textEdit === note.id) return;     // the caret is in it; leave it be
      event.preventDefault();
      event.stopPropagation();
      const was = state.textSel === note.id;
      selectNote(note.id);
      // The chip has just been rebuilt by selecting it, so the drag is
      // tracked from the one that replaced it.
      const live = page.layer.querySelector('[data-note="' + note.id + '"]');
      const host = live || chip;
      const at = noteSpace(page, event);
      from = { x: at.x - note.x, y: at.y - note.y, already: was };
      moved = false;
      try { host.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
      const move = onMove => {
        if (!from) return;
        const now = noteSpace(page, onMove);
        const x = now.x - from.x;
        const y = now.y - from.y;
        // The slop is in screen pixels, so the distance in page pixels is
        // divided by the scale rather than multiplied by it: a page shown at
        // half size moves two of its own pixels for every one on screen.
        if (!moved && (Math.abs(x - note.x) / now.scale > NOTE_SLOP
          || Math.abs(y - note.y) / now.scale > NOTE_SLOP)) {
          moved = true;
          noteUndo(page, 'moving that note');
        }
        if (!moved) return;
        note.x = x;
        note.y = y;
        host.style.setProperty('--x', (note.x / page.source.width) * 100);
        host.style.setProperty('--y', (note.y / page.source.width) * 100);
      };
      const done = () => {
        host.removeEventListener('pointermove', move);
        host.removeEventListener('pointerup', done);
        host.removeEventListener('pointercancel', done);
        if (moved) { renderNotes(page); drawPage(page); }
        // A tap on a note already in hand puts the caret in it. A tap that
        // picked it up does not, or every note would open for editing the
        // moment it was touched.
        else if (from && from.already) editNote(note.id);
        from = null;
      };
      host.addEventListener('pointermove', move);
      host.addEventListener('pointerup', done);
      host.addEventListener('pointercancel', done);
    });
  }

  function wireNoteWidth(page, note, grab) {
    grab.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      noteUndo(page, 'how wide that note is');
      const start = noteSpace(page, event);
      const wasWide = note.w;
      const chip = grab.parentElement;
      try { grab.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
      const move = onMove => {
        const now = noteSpace(page, onMove);
        const smallest = page.source.width * 0.04;
        note.w = Math.max(smallest,
          Math.min(page.source.width - note.x, wasWide + (now.x - start.x)));
        chip.style.setProperty('--w', (note.w / page.source.width) * 100);
        chip.style.setProperty('--h', (Render.textBox(note).h / page.source.width) * 100);
      };
      const done = () => {
        grab.removeEventListener('pointermove', move);
        grab.removeEventListener('pointerup', done);
        grab.removeEventListener('pointercancel', done);
        renderNotes(page);
        drawPage(page);
      };
      grab.addEventListener('pointermove', move);
      grab.addEventListener('pointerup', done);
      grab.addEventListener('pointercancel', done);
    });
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
    let bar = wordSensitivity() - TextImage.shapeRelief(term);
    // Short acronyms (KAS/KAG/KNW) correlate inside longer wordmarks. Hold the
    // shape bar higher; green OCR/text hits are unchanged.
    const letters = String(term || '').replace(/[^A-Za-z]/g, '');
    if (letters.length > 0 && letters.length <= 3) bar += 0.12;
    return Math.max(0.3, Math.round(bar * 1000) / 1000);
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
    if (state.placingText) {
      // Said on every screen, not only a phone: nothing else in the tool
      // waits for a tap on the document, so without a line here the button
      // looks as though it did nothing.
      tip.textContent = 'Tap the page where the note should go.';
      tip.hidden = false;
      return;
    }
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
    // Keep Images open on Cancel: collapsing it would hide the only in-panel
    // way out of a pick. The heading is locked until picking ends.
    const images = el('imagesect');
    if (images) {
      if (picking) images.open = true;
      images.classList.toggle('pick-locked', picking);
    }
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

  function clearPickHint() {
    const hint = el('pickhint');
    if (!hint) return;
    hint.hidden = true;
    hint.textContent = '';
    hint.classList.remove('warnhint');
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
      if (!template.searched) count.title = 'Not searched for yet  - press Search';
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
      remove.textContent = 'x';
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
        count.title = 'Not searched for yet  - press Search';
        // needsSearch closes the open tally, but the list it drew is already
        // on screen and only a re-render would take it off.
        const open = row.nextSibling;
        if (open && open.classList && open.classList.contains('tally')) open.remove();
        needsSearch();
      });

      row.append(template.thumbnail, bar, count, remove);
      host.append(row);

      // What this image's search found, under this image's row.
      //
      // It used to be one line under the pick button that every picked image
      // shared, so with three images the third search overwrote the other
      // two and the sentence the reviewer read belonged to none of them in
      // particular. Here it sits with the thumbnail, the bar and the tally it
      // is about.
      const told = template.searched ? reportFor(template) : null;
      if (told) {
        const note = document.createElement('li');
        note.className = 'imgnote' + (told.warn ? ' warnhint' : '');
        note.textContent = told.text;
        host.append(note);
      }

      if (state.openTally === template.id && !count.disabled) {
        host.append(tallyList(template.id, placesFor(template.id)));
      }
    }
  }

  // Where a picked image was found, page by page. The same question the tally
  // beside a word answers, and the same answer: a page number to go and look
  // at rather than a count to take on trust.
  // Where a detector found things, page by page, in the same shape the term
  // and image lists use — so one list-drawing function serves all three and
  // they cannot drift into looking like different answers to the same
  // question.
  function placesForKind(kind) {
    const out = [];
    if (state.kind === 'text') return out;
    for (const page of state.pages) {
      for (const hit of page.hits) {
        if (hit.finding.kind !== kind || page.dismissed.has(hit.finding.id)) continue;
        out.push({ pageIndex: page.index, kind: 'text', mark: hit.finding.id,
                   at: hit.rects && hit.rects[0] ? hit.rects[0].y : 0 });
      }
      // The ones found in what OCR read. Marked as read rather than as text,
      // because that is a different kind of confidence and the list says so.
      // One row per thing found, not per box drawn. A phone number spread
      // over four OCR words is four boxes and one phone number, and the list
      // is answering "where are they", not "how much ink".
      const seen = new Set();
      for (const match of liveImageHits(page)) {
        if (match.detector !== kind || page.dismissed.has(match.id)) continue;
        const group = match.group || match.id;
        if (seen.has(group)) continue;
        seen.add(group);
        out.push({ pageIndex: page.index, kind: 'read', mark: group,
                   at: match.rect ? match.rect.y : 0 });
      }
    }
    out.sort((a, b) => a.pageIndex - b.pageIndex || a.at - b.at);
    return out;
  }

  function placesFor(templateId) {
    const out = [];
    for (const page of state.pages) {
      for (const match of liveImageHits(page)) {
        if (match.templateId !== templateId) continue;
        out.push({ pageIndex: page.index, kind: 'image', mark: match.id,
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
      // One row per mark the page will actually draw, not per run in the text
      // layer.
      //
      // These are not the same number, and on a converted deck they are not
      // close. Measured on a real CIM: the page showed the company's name
      // four times, its text layer held twenty-one copies of it — the same
      // sentence re-emitted five or six times at identical coordinates, some
      // of the copies garbled where they overlap — and the panel said
      // twenty-three. The marks were right all along: page.hits has already
      // been through onePerPlace, which drops a box sitting on top of an
      // identical box. This counted the raw spans instead, so the panel
      // reported the file's duplicated text layer as places in the document.
      //
      // An inflated count is not the conservative side of this. Nothing about
      // what gets covered changes here — the boxes were and are the same. What
      // changes is whether the number can be believed, and "23" over a page
      // with four marks on it teaches a reviewer to stop reading the number
      // at all, which is the one thing that would let a real miss through.
      for (const hit of page.hits) {
        if (hit.finding.term !== term) continue;
        // A mark clicked off is not a place this word is covered, so it is
        // not a row in the list of places and not part of the count above it.
        // The detectors' list has always worked this way; the words' list did
        // not, so saying no to one from the row left the number unchanged.
        if (page.dismissed.has(hit.finding.id)) continue;
        out.push({ pageIndex: page.index, kind: 'text', mark: hit.finding.id,
                   at: hit.rects && hit.rects[0] ? hit.rects[0].y : 0 });
      }
      for (const match of liveImageHits(page)) {
        if (match.term !== term || page.dismissed.has(match.id)) continue;
        out.push({
          pageIndex: page.index,
          kind: match.bySweep ? 'shape' : 'text',
          mark: match.id,
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
      drop.textContent = 'x';
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
          dot.title = 'Not searched for yet  - press Search';
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
    box.append(tallyRows(where));
    return box;
  }

  // The rows themselves, which the sweep's note borrows: a place the check
  // stood down from is answered the same way as a place it found, because to
  // the reviewer they are the same question — where is it, take me there.
  function tallyRows(where) {
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
        : spot.kind === 'refused' ? 'read as something else'
          : spot.kind === 'read' ? 'read off the page'
          : spot.kind === 'image'
            ? (spot.score === null ? 'as a picture' : spot.score.toFixed(2))
            : 'in the text';
      jump.append(dot, text, how);
      jump.addEventListener('click', () => goToPage(spot.pageIndex));

      // Hovering a row lights up the mark it stands for.
      //
      // "Page 34" tells the reviewer where to look and nothing about what to
      // look at: a page can carry a dozen marks, and the row is about one of
      // them. Filling that one is the shortest sentence available — the row
      // and the box on the page are the same thing, and moving between them
      // costs nothing to learn.
      if (spot.mark) {
        const lightUp = () => spotlight(spot.pageIndex, spot.mark);
        const lightDown = () => spotlight(null, null);
        jump.addEventListener('pointerenter', lightUp);
        jump.addEventListener('focus', lightUp);
        jump.addEventListener('pointerleave', lightDown);
        jump.addEventListener('blur', lightDown);
        item.addEventListener('pointerleave', lightDown);
      }

      item.append(jump);

      // And a way to disagree with it, on the row rather than only on the
      // page. Clicking the mark itself is the other way and stays; this one
      // is for a reviewer working down the list, who would otherwise have to
      // travel to each page to say no.
      if (spot.mark) {
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'tallydrop';
        drop.textContent = '\u00d7';
        drop.title = 'Do not cover this one';
        drop.setAttribute('aria-label', 'Do not cover the mark on page '
          + (spot.pageIndex + 1));
        drop.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          dropMark(spot.pageIndex, spot.mark);
        });
        item.append(drop);
      }

      list.append(item);
    }
    return list;
  }

  // Which mark, if any, is being pointed at from the panel. Held in the state
  // rather than on the element, because what draws it is the page's canvas
  // and the row that asked for it is somewhere else entirely.
  function spotlight(pageIndex, mark) {
    const was = state.spotlight;
    if (was && was.pageIndex === pageIndex && was.mark === mark) return;
    state.spotlight = mark ? { pageIndex, mark } : null;
    // Only the pages that changed: the one that was lit, and the one that is.
    for (const index of new Set([was && was.pageIndex, pageIndex])) {
      const page = typeof index === 'number' ? state.pages[index] : null;
      if (page) drawPage(page);
    }
  }

  // Every rectangle a given mark is drawn as, on one page.
  function rectsOfMark(page, mark) {
    const out = [];
    for (const hit of page.hits) {
      if (hit.finding.id === mark) out.push(...(hit.rects || []));
    }
    for (const match of liveImageHits(page)) {
      if ((match.group || match.id) === mark && match.rect) out.push(match.rect);
    }
    for (const box of page.manual) if (box.id === mark) out.push(box);
    return out;
  }

  // The reviewer saying no to one mark from the list.
  function dropMark(pageIndex, mark) {
    const page = state.pages[pageIndex];
    if (!page) return;
    // A detector's find can be several marks in one row — a phone number read
    // as four words — so everything sharing the row's identity goes together.
    const ids = [];
    for (const hit of page.hits) if (hit.finding.id === mark) ids.push(hit.finding.id);
    for (const match of liveImageHits(page)) {
      if ((match.group || match.id) === mark) ids.push(match.id);
    }
    const going = ids.filter(id => !page.dismissed.has(id));
    if (!going.length) return;
    for (const id of going) page.dismissed.add(id);
    pushUndo(going.length === 1 ? 'keeping that match' : 'keeping those matches',
      () => { for (const id of going) page.dismissed.delete(id); });
    spotlight(null, null);
    markPending();
    drawPage(page);
    renderTermCounts();
    renderKinds();
    renderTemplates();
    applyLabels();
  }

  // ---------- text documents ----------

  const dismissedText = new Set();

  function drawTextView() {
    const view = el('textview');
    view.textContent = '';
    let cursor = 0;

    for (const f of state.findings) {
      if (!findingAnswered(f)) continue;
      if (f.start < cursor) continue;
      view.append(document.createTextNode(state.text.slice(cursor, f.start)));
      const mark = document.createElement('mark');
      mark.textContent = state.text.slice(f.start, f.end);
      mark.title = f.label + ' – click to keep it';
      // Outlined until applied, so the reviewer can still read what is about
      // to go, exactly as on a page.
      if (!state.applied) mark.classList.add('pending');
      if (dismissedText.has(f.id)) { mark.className = 'off'; mark.title = f.label + ' – click to cover it'; }
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
  // page of content. A draft with the document inside it would be a file that
  // looks like a redaction and is the opposite of one, and sooner or later
  // somebody sends one on.
  //
  // It is not, however, harmless. This used to say the draft "carries nothing
  // confidential", and that was wrong in the way that matters: the words a
  // reviewer typed to be covered are the names, the email addresses and the
  // counterparty, a note written on a page is whatever they wrote, and the
  // file's own name is often the deal. A draft is a short list of the most
  // sensitive strings in the document, without the document around them to
  // dilute it. It is small and it is not the file — it is not safe to leave
  // lying about, and nothing in this program should imply that it is.
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
        // How far the page has been turned, and the notes written on it.
        // Both are the reviewer's work rather than the document's, which is
        // exactly what a draft is for — and the marks below are stored in the
        // turned page's coordinates, so the turn has to go back first.
        turn: page.turn || 0,
        texts: notesOf(page).map(note => ({ ...note })),
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
    draftNote('Draft saved. It holds your marks and the words you typed  - '
      + 'not the document  - so keep it as carefully. Reopen it and choose '
      + state.name + ' again to carry on.');
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
    showTool('drop');
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

    let turned = false;
    for (const saved of data.pages || []) {
      const page = state.pages[saved.index];
      if (!page) continue;
      // Turned back to the orientation the marks were measured against,
      // before any of them are put back. A quarter at a time, through the
      // same function the button uses, so a restored page is the same page a
      // turned one is.
      for (let quarter = (((saved.turn || 0) - (page.turn || 0)) % 360 + 360) % 360;
        quarter > 0; quarter -= 90) {
        turnPage(page);
        turned = true;
      }
      page.texts = (saved.texts || []).map(note => ({ ...note }));
      for (const note of page.texts) {
        // Ids have to stay unique against the ones this session will mint.
        const number = Number(String(note.id).replace(/\D+/g, ''));
        if (number >= nextNoteId) nextNoteId = number + 1;
      }
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

    // A turned page is a different shape, and the elements holding the pages
    // carry that shape. Rebuilt rather than redrawn, or the document would be
    // drawn correctly into wrappers that are still the old way round.
    if (turned) buildPageElements();
    rescan();
    renderTemplates();
    renderTermCounts();
    renderSectionNotes();
    renderAllNotes();
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
      .replace(/[-_ - -]{2,}/g, '-')
      .replace(/\s*[-_ - -]\s*(?=[-_ - -.]|$)/g, '')
      .replace(/^[\s\-_ - -.]+/, '')
      .replace(/[\s\-_ - -]+$/, '')
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
  // Resolves false to cancel, true to go ahead, and 'save' where the caller
  // offered a third way and the reviewer took it.
  function confirmAction(options) {
    const opts = options || {};
    return new Promise(resolve => {
      const box = el('confirmbox');
      const yes = el('confirmyes');
      const close = el('confirmx');
      const save = el('confirmsave');
      const reset = el('confirmreset');
      el('confirmhead').textContent = opts.title || 'Are you sure?';
      el('confirmbody').textContent = opts.body || '';
      yes.textContent = opts.confirmLabel || 'Discard';
      // A way to keep the work, offered beside the way to lose it rather than
      // left for the reviewer to remember on their own. Most confirmations
      // have nothing to save and do not ask for it.
      save.hidden = !opts.saveLabel;
      if (opts.saveLabel) save.textContent = opts.saveLabel;
      // Clear marks on this document and keep it open. Only the Reset flow asks.
      reset.hidden = !opts.resetLabel;
      if (opts.resetLabel) reset.textContent = opts.resetLabel;
      box.hidden = false;
      // The close control takes focus, not the destructive one: a stray Enter
      // should not be the thing that loses the document.
      close.focus();

      const done = answer => {
        box.hidden = true;
        yes.removeEventListener('click', accept);
        close.removeEventListener('click', reject);
        save.removeEventListener('click', keep);
        reset.removeEventListener('click', restore);
        box.removeEventListener('pointerdown', away);
        document.removeEventListener('keydown', key, true);
        resolve(answer);
      };
      // Sync hooks run inside the click that chose the answer, so a file
      // picker opened from a confirm action still counts as a user gesture.
      const accept = () => {
        if (typeof opts.onConfirm === 'function') opts.onConfirm();
        done(true);
      };
      const reject = () => done(false);
      const keep = () => {
        if (typeof opts.onSave === 'function') opts.onSave();
        done('save');
      };
      const restore = () => done('reset');
      // A press on the dimmed page behind the box is a way out, the same as
      // Escape. It cancels rather than confirms, which is the answer that
      // cannot cost anything — a stray tap must never be what discards a
      // document.
      const away = event => { if (event.target === box) reject(); };
      const key = event => {
        if (event.key === 'Escape') { event.preventDefault(); reject(); }
      };
      yes.addEventListener('click', accept);
      close.addEventListener('click', reject);
      save.addEventListener('click', keep);
      reset.addEventListener('click', restore);
      box.addEventListener('pointerdown', away);
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
    // Asked for in the Save as box, saved after the file itself: the export
    // is what the reviewer pressed for, and a draft that failed must not be
    // the reason they do not get it.
    const alsoDraft = Boolean(el('withdraft') && el('withdraft').checked);
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
        const flat = Render.flatten(page.source, activeBoxes(page), notesOf(page));
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
          flats.push({ page, boxes, flat: Render.flatten(page.source, boxes, notesOf(page)) });
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
      busy(false);
      return;
    } finally {
      busy(false);
    }
    if (alsoDraft) {
      try {
        // saveDraft clears the exported flag, because saving a draft on its
        // own is not exporting a redaction. Here it followed one, and the
        // reviewer must not be warned about losing work they have just saved
        // twice over.
        const exported = state.exported;
        await saveDraft();
        state.exported = exported;
        // saveDraft says "Draft saved", which is the wrong half of the story
        // when a redacted file has just been built beside it.
        draftNote('Saved ' + state.saveAs + ', and a draft beside it \u2013 the '
          + 'draft holds your marks and the words you typed, so keep it as '
          + 'carefully as the document.');
      } catch (error) {
        draftNote('The file was saved. The draft could not be: '
          + (error && error.message ? error.message : error));
      }
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

  // Open the picker from a click on the box, not from a nested <input> — see
  // the note in index.html. Ignore a second click while the dialog is up.
  let pickingFile = false;
  function browseForFile() {
    if (pickingFile) return;
    pickingFile = true;
    const done = () => { pickingFile = false; window.removeEventListener('focus', done); };
    // focus returns when the picker closes (chosen or cancelled).
    window.addEventListener('focus', done);
    try { input.click(); }
    catch (err) { done(); }
    // Safety: if focus never fires, unlock after a beat.
    setTimeout(done, 1500);
  }
  drop.addEventListener('click', event => {
    event.preventDefault();
    browseForFile();
  });
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); browseForFile(); }
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
  const imagesect = el('imagesect');
  if (imagesect) {
    const heading = imagesect.querySelector('summary');
    if (heading) {
      heading.addEventListener('click', event => {
        if (state.mode !== 'pick') return;
        if (event.target.closest && event.target.closest('.why')) return;
        event.preventDefault();
      });
    }
  }

  for (const section of document.querySelectorAll('details.sect')) {
    section.addEventListener('toggle', () => {
      // A pick is in progress: Images stays open so Cancel stays reachable,
      // and Organise must not swallow the panel out from under it.
      if (state.mode === 'pick') {
        if (section === imagesect && !section.open) {
          section.open = true;
          return;
        }
        if (section === el('organisesect') && section.open) {
          section.open = false;
          if (imagesect) imagesect.open = true;
          return;
        }
        if (imagesect && !imagesect.open) imagesect.open = true;
      }

      const sheet = el('organisesect');

      // The sheet's own toggle owns the panel's shape, in both directions.
      //
      // It used to be answered only when a section opened, which meant
      // shutting the sheet from the rolled-up line left the four sections
      // hidden and the line standing: the one way back out of that state did
      // not take. Closing is as much of an event as opening.
      if (section === sheet) {
        if (sheet.open) {
          for (const other of document.querySelectorAll('details.sect')) {
            if (other !== sheet) other.open = false;
          }
          sheet.scrollIntoView({ block: 'nearest' });
        } else {
          // Closing Organise brings the four back open — the shape the panel
          // opens in — not as four shut headings under the roll line.
          openSections();
        }
        // The panel stops scrolling and hands its spare height to the
        // thumbnails, so they are the only thing with a scrollbar. Two nested
        // scrollbars in a 320-pixel column is a maze: the reviewer scrolls the
        // outer one looking for pages and finds the foot of the panel.
        document.body.classList.toggle('organising', sheet.open);
        rollSections(sheet.open);
        // After, not before: four headings have just left the panel or come
        // back to it, and where the sheet starts has moved with them.
        fitSheet();
        return;
      }

      // Any other section opening shuts the sheet, which comes back through
      // here as the sheet's own toggle and puts the panel right.
      if (section.open && sheet.open) sheet.open = false;
    });
  }

  el('choose-done').addEventListener('click', stopChoosing);

  el('sectroll').addEventListener('click', () => {
    // Shutting the sheet is what brings the four back, and they come back
    // open — the shape the panel opens in — rather than however they happened
    // to be when the sheet swallowed them.
    openSections();
  });

  window.addEventListener('resize', fitSheet);

  el('page-turn').addEventListener('click', turnPages);
  el('page-text').addEventListener('click', () => {
    if (state.placingText) stopPlacingText();
    else startPlacingText();
  });
  el('page-keep').addEventListener('click', keepOnlyPicked);
  el('page-drop').addEventListener('click', dropPicked);
  el('page-add').addEventListener('click', () => el('addfile').click());
  const dropHint = el('sheetdrop-hint');
  if (dropHint) dropHint.addEventListener('click', () => el('addfile').click());
  el('addfile').addEventListener('change', async event => {
    // Copied out of the input before it is cleared, not merely referenced.
    //
    // event.target.files is live: clearing the input empties the very list
    // this handler is holding, so `addDocuments` was handed nothing and said
    // "a text file has no pages to add" about a PDF. Adding a document from
    // the toolbar did not work at all.
    const files = [...event.target.files];
    // Cleared before the read, so choosing the same file twice in a row still
    // fires a change event the second time.
    event.target.value = '';
    await addDocuments(files);
  });

  // Drop a PDF or image onto the sheet, into a gap between pages. The OS
  // drag image is the one in the hand — a second, larger ghost sat on top
  // of it and read as two pages following the pointer.
  function hasFileDrag(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    return Array.prototype.indexOf.call(types, 'Files') >= 0;
  }

  let fileDragDepth = 0;
  let fileGhost = null;
  const blankDrag = document.createElement('canvas');
  blankDrag.width = 1;
  blankDrag.height = 1;

  function liftFileGhost(event) {
    const ghost = document.createElement('div');
    ghost.className = 'sheetghost fileghost';
    const face = document.createElement('canvas');
    face.width = 40;
    face.height = 52;
    const ctx = face.getContext('2d');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(0, 0, face.width, face.height);
    ctx.strokeStyle = 'rgba(31, 111, 235, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(1, 1, face.width - 2, face.height - 2);
    ghost.append(face);
    document.body.append(ghost);
    carryGhost(ghost, event);
    return ghost;
  }

  function hideOsDragImage(event) {
    // Best effort: inbound file drags from Explorer often ignore this, but
    // when it takes, only the small ghost remains.
    try {
      if (event.dataTransfer && event.dataTransfer.setDragImage) {
        event.dataTransfer.setDragImage(blankDrag, 0, 0);
      }
    } catch (_) { /* not all browsers allow this on dragover */ }
  }

  function endFileDrag() {
    fileDragDepth = 0;
    document.body.classList.remove('file-dropping');
    if (fileGhost) {
      fileGhost.remove();
      fileGhost = null;
    }
    stopEdgeScroll();
    clearDropMark();
    lastFileGap = -1;
  }

  function fileDropGap(event, host) {
    const hint = el('sheetdrop-hint');
    if (hint && (event.target === hint || hint.contains(event.target))) {
      return state.pages.length;
    }
    return sheetGapAt(event, host);
  }

  {
    const section = el('organisesect');
    if (section) {
      section.addEventListener('dragenter', event => {
        if (!hasFileDrag(event) || state.kind === 'text' || !state.pages.length) return;
        if (document.body.classList.contains('dragging-page')) return;
        event.preventDefault();
        fileDragDepth++;
        document.body.classList.add('file-dropping');
        if (!section.open) section.open = true;
      });
      section.addEventListener('dragover', event => {
        if (!hasFileDrag(event) || state.kind === 'text' || !state.pages.length) return;
        if (document.body.classList.contains('dragging-page')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        hideOsDragImage(event);
        document.body.classList.add('file-dropping');
        if (!section.open) section.open = true;
        if (!fileGhost) fileGhost = liftFileGhost(event);
        else carryGhost(fileGhost, event);
        const host = el('sheet');
        if (!host) return;
        lastFileGap = fileDropGap(event, host);
        showDropAt(lastFileGap, host);
        edgeScroll(host, event, () => {
          lastFileGap = fileDropGap(event, host);
          showDropAt(lastFileGap, host);
        });
      });
      section.addEventListener('dragleave', event => {
        if (!document.body.classList.contains('file-dropping')) return;
        fileDragDepth = Math.max(0, fileDragDepth - 1);
        if (fileDragDepth > 0) return;
        const next = event.relatedTarget;
        if (next && section.contains(next)) return;
        endFileDrag();
      });
      section.addEventListener('drop', async event => {
        if (!hasFileDrag(event) || state.kind === 'text' || !state.pages.length) return;
        event.preventDefault();
        event.stopPropagation();
        const host = el('sheet');
        const gap = lastFileGap >= 0 ? lastFileGap : fileDropGap(event, host);
        const files = event.dataTransfer && event.dataTransfer.files;
        endFileDrag();
        await addDocuments(files, gap);
      });
    }
  }
  // A press anywhere that is not a note puts the note down. The pages have
  // their own handler for this, because a press there also means something
  // else; this one catches the panel, the header and the margins.
  document.addEventListener('pointerdown', event => {
    if (!state.textSel) return;
    if (event.target.closest && event.target.closest('.notechip')) return;
    commitNote();
    selectNote(null);
  }, true);

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.placingText) {
      stopPlacingText();
      return;
    }
    // A note in hand, with the caret somewhere else: Delete removes it. Not
    // while it is being typed into, where those keys belong to the words.
    const typing = event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (!state.textSel || state.textEdit || typing) return;
    if (event.key === 'Escape') { selectNote(null); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      dropNote(state.textSel);
    }
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
  bindSweepOffer();
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
  const READER_SURE = 60;

  // Has the first pass already settled this term on this page?
  //
  // Text-layer hits are exact. OCR hits only count when every word box the
  // match touches was read at READER_SURE or above — the same bar the sweep
  // uses to let a confident reading veto a shape guess. Unsure OCR is exactly
  // what Comprehensive is for, so those pages stay in the queue.
  function pageHasConfidentTerm(page, term) {
    // Text-layer hits are exact: the page really contains the term, and
    // Comprehensive has nothing to second-guess there.
    for (const f of page.findings || []) {
      if (f.kind === 'term' && f.term === term) return true;
    }
    // OCR hits do NOT settle the page. Measured on a photographed TCC slide
    // where "F&N" was typed: OCR boxed four copies confidently and skipped
    // Comprehensive, while other copies were read as "Fan" / "FEN" / missed
    // on white-on-blue and in "F&N's Financials". One good OCR hit is not
    // proof every copy was read. Shape search is the second look for that.
    return false;
  }

  function pagesNeedingSweep(term) {
    return state.pages.filter(page => !pageHasConfidentTerm(page, term));
  }

  // How much work a Comprehensive run will actually do (for the time note).
  function sweepWorkload() {
    let pageSet = new Set();
    let terms = 0;
    for (const term of state.terms) {
      const pages = pagesNeedingSweep(term);
      if (!pages.length) continue;
      terms++;
      for (const p of pages) pageSet.add(p.index);
    }
    return { terms, pages: pageSet.size, pageIndexes: pageSet };
  }

  // Words of a typed phrase that are worth drawing as shape templates.
  //
  // A full phrase template misaligns on the space (see TextImage.shapeRelief).
  // Sweeping each content word and keeping neighbours that sit in order fixes
  // that for "Middle East" without correlating every "and"/"of" on the page.
  function sweepPartsFor(term) {
    const trimmed = String(term || '').trim();
    if (!/\s/.test(trimmed)) return trimmed ? [trimmed] : [];
    const parts = TextImage.phraseContentParts(trimmed);
    return parts.length >= 2 ? parts : [trimmed];
  }

  function sweepTemplates() {
    const entries = [];
    for (const term of state.terms) {
      const need = pagesNeedingSweep(term);
      if (!need.length) continue;
      const pageIndexes = new Set(need.map(p => p.index));
      const isPhrase = /\s/.test(term.trim());
      const parts = sweepPartsFor(term);
      const draw = isPhrase ? parts : [term.trim()];
      draw.forEach((part, partIndex) => {
        TextImage.templatesFor(part, TextImage.SWEEP_FACES).forEach((template, i) => {
          entries.push({
            key: 'sweep:' + term + ':' + part + ':' + i,
            template,
            term,
            part,
            partIndex,
            phraseParts: isPhrase ? parts : null,
            threshold: wordBarFor(part),
            smallText: true,
            pageIndexes,
          });
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
  const READER_OVER = 0.25;
  // Most of the shape hit must sit inside the host word box. overlapFraction
  // alone treats "small inside large" and "large swallows small" the same;
  // coveredFraction(hit, host) is the nested fact we care about for mid-word.
  const HOST_COVERS_HIT = 0.45;

  // Text-layer items use baseline y; match the box geometry boxes.js uses.
  function textItemRect(item) {
    const ASCENT = 0.82;
    const DESCENT = 0.22;
    return {
      x: item.x,
      y: item.y - item.h * ASCENT,
      w: item.w,
      h: item.h * (ASCENT + DESCENT),
    };
  }

  function hostOverlapsHit(hostRect, hitRect) {
    if (!hostRect || !hitRect) return false;
    if (Match.coveredFraction(hitRect, hostRect) >= HOST_COVERS_HIT) return true;
    return Match.overlapFraction(hostRect, hitRect) > READER_OVER;
  }

  // Same-line OCR crumbs glued into one host ("TE"+"XAS" → TEXAS) so a short
  // acronym shape hit inside a longer wordmark can still be vetoed.
  function mergedOcrLineHosts(page, rect) {
    const placed = page.ocrPlaced || [];
    if (!placed.length || !page.ocrText) return [];
    const cy = rect.y + rect.h / 2;
    const line = placed.filter(item => item.rect
      && typeof item.confidence === 'number'
      && item.confidence >= READER_SURE
      && Math.abs((item.rect.y + item.rect.h / 2) - cy) <= Math.max(rect.h, item.rect.h) * 0.8)
      .slice()
      .sort((a, b) => a.rect.x - b.rect.x);
    if (!line.length) return [];
    const runs = [];
    let run = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const prev = run[run.length - 1];
      const item = line[i];
      const gap = item.rect.x - (prev.rect.x + prev.rect.w);
      if (gap <= Math.max(prev.rect.h, item.rect.h) * 0.55) run.push(item);
      else { runs.push(run); run = [item]; }
    }
    runs.push(run);
    const out = [];
    for (const parts of runs) {
      const xs = parts.map(p => p.rect.x);
      const ys = parts.map(p => p.rect.y);
      const rights = parts.map(p => p.rect.x + p.rect.w);
      const bottoms = parts.map(p => p.rect.y + p.rect.h);
      const union = {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...rights) - Math.min(...xs),
        h: Math.max(...bottoms) - Math.min(...ys),
      };
      if (!hostOverlapsHit(union, rect)) continue;
      const text = parts.map(p => page.ocrText.slice(p.start, p.end)).join('');
      if (text) out.push(text);
    }
    return out;
  }

  function readerContradicts(page, rect, term) {
    const hosts = [];

    const placed = page.ocrPlaced;
    if (placed && placed.length && page.ocrText) {
      for (const item of placed) {
        if (!item.rect || !hostOverlapsHit(item.rect, rect)) continue;
        if (!(typeof item.confidence === 'number' && item.confidence >= READER_SURE)) continue;
        hosts.push(page.ocrText.slice(item.start, item.end));
      }
      // Short acronyms: also try same-line merges (TEXAS split across tokens).
      if (Detect.lettersOf(term).length <= 4) {
        for (const text of mergedOcrLineHosts(page, rect)) hosts.push(text);
      }
    }

    // Text layer is authoritative when present — logo PDFs often still have
    // a TEXAS run even when the painted wordmark was what the shape matched.
    for (const item of page.items || []) {
      if (!item || !item.str || !String(item.str).trim()) continue;
      if (item.w <= 0 || item.h <= 0) continue;
      const hostRect = textItemRect(item);
      if (!hostOverlapsHit(hostRect, rect)) continue;
      hosts.push(item.str);
    }

    if (!hosts.length) return false;

    // Prefer longer hosts so a misread "KAS" crumb next to a real "TEXAS"
    // does not keep the false mark alive.
    hosts.sort((a, b) => Detect.lettersOf(b).length - Detect.lettersOf(a).length);
    for (const host of hosts) {
      if (Detect.hostContradictsShapeTerm(host, term)) return true;
    }
    return false;
  }



  // Refuse ≤3-letter Comprehensive shape hits inside logo-grid regions.
  function shortAcronymShapeRefused(page, rect, term) {
    const roles = page.roles || rolesForPage(page);
    page.roles = roles;
    return !PageRole.allowShortAcronymShape(roles, term, rect);
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
    if (!entries.length) {
      // Everything the reading already settled — nothing left to correlate.
      state.sweptTerms = state.terms.slice();
      state.sweepAdded = 0;
      state.sweepRefused = 0;
      state.sweepRefusedAt = [];
      state.sweepReached = state.pages.length;
      state.sweepSkipped = true;
      renderSweep();
      refreshApply();
      return 0;
    }
    // Which words this run is answering. The reviewer can edit the list while
    // it runs, and a mark for a word they have since deleted is a mark they
    // never asked for, so the answer is filtered against the list as it stands
    // when the run finishes rather than as it stood when it started.
    const asked = state.terms.slice();
    // Only decode pages that still need at least one term. Per-template
    // pageIndexes then skips settled terms on shared pages.
    const pageIndexSet = new Set();
    for (const entry of entries) {
      if (entry.pageIndexes) for (const i of entry.pageIndexes) pageIndexSet.add(i);
    }
    const pages = state.pages.filter(p => pageIndexSet.has(p.index));

    // No overlay. Every other long pass in this tool blocks the document
    // because nothing useful can be done while it runs; this one is a second
    // opinion on a redaction that already exists, so the reviewer keeps the
    // document and a bar in the panel says how far it has got.
    state.sweepRunning = true;
    state.sweepStopped = false;
    state.sweepSkipped = false;
    sweepProgress(0, pages.length);
    renderSweep();
    // The Search button greys out for as long as this runs, so it has to be
    // told the moment it starts and not only when it ends.
    refreshApply();

    let results;
    try {
      results = await ImageSearch.searchAllParallel(pages, entries,
        { stop: () => state.sweepStopped },
        done => sweepProgress(done, pages.length));
    } catch (error) {
      state.sweepRunning = false;
      renderSweep();
      alert('The thorough check could not finish: '
        + (error && error.message ? error.message : error));
      return 0;
    }

    const reached = typeof results.stoppedAfter === 'number'
      ? results.stoppedAfter : pages.length;

    // Several typefaces finding the same word in the same place is one find,
    // so they are pooled per page and suppressed before anything is proposed.
    let added = 0;
    const refused = [];
    for (const term of new Set(entries.map(e => e.term))) {
      if (!state.terms.includes(term)) continue;
      const termEntries = entries.filter(e => e.term === term);
      const isPhrase = termEntries.some(e => e.phraseParts && e.phraseParts.length >= 2);

      if (isPhrase) {
        const parts = termEntries[0].phraseParts;
        const skipped = [];
        for (let p = 0; p < parts.length - 1; p++) {
          skipped.push(Match.skippedConnectorsBetween(term, parts[p], parts[p + 1]));
        }
        // Collect per-part hits per page, then keep only left-to-right chains.
        const pageParts = new Map();
        for (const entry of termEntries) {
          const found = results.get(entry.key);
          if (!found) continue;
          for (const hit of found.matches) {
            if (!pageParts.has(hit.pageIndex)) pageParts.set(hit.pageIndex, new Map());
            const byPart = pageParts.get(hit.pageIndex);
            if (!byPart.has(entry.part)) byPart.set(entry.part, []);
            byPart.get(entry.part).push(hit);
          }
        }
        for (const [pageIndex, hitsByPart] of pageParts) {
          const page = state.pages[pageIndex];
          if (!page) continue;
          for (const part of parts) {
            const list = hitsByPart.get(part);
            if (list) hitsByPart.set(part, Match.suppress(list, 0.3));
          }
          for (const hit of Match.pairPhraseHits(parts, hitsByPart, skipped)) {
            const rect = { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
            if (alreadyCovered(page, rect)) continue;
            if (readerContradicts(page, rect, term) || shortAcronymShapeRefused(page, rect, term)) {
              refused.push({ pageIndex, at: rect.y, term });
              continue;
            }
            page.imageHits.push({
              id: 'sweep:' + term + ':' + pageIndex + ':'
                + Math.round(hit.x) + ':' + Math.round(hit.y),
              term, rect, score: hit.score,
              inverted: Boolean(hit.inverted),
              bySweep: true,
            });
            added++;
          }
        }
        continue;
      }

      const perPage = new Map();
      for (const entry of termEntries) {
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
          if (readerContradicts(page, rect, term)) {
            // Where, not just how many. The note tells the reviewer this is
            // where to look when a mark they expected is missing, and until
            // now there was nothing to look at: a count of two, over sixty
            // pages, is not a place.
            refused.push({ pageIndex, at: rect.y, term });
            continue;
          }
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
    // What the reader threw out, and where each one was.
    state.sweepRefused = refused.length;
    state.sweepRefusedAt = refused;
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
        + '  - you can carry on reviewing.';
    }
  }

  // The button, and what it says afterwards.
  //
  // Offered only once a redaction has been done, because it is the second
  // opinion on that redaction: there is nothing to be thorough about before
  // there is a result to check.

  // After the first Search finishes, offer Comprehensive once — skippable,
  // with the longer explanation collapsed. Runs the same background sweep
  // the panel button uses.
  function shouldOfferSweep() {
    if (state.sweepOfferShown || state.sweepRunning) return false;
    if (!state.searched || !state.terms.length || state.kind === 'text') return false;
    const swept = state.sweptTerms.length
      && state.sweptTerms.length === state.terms.length
      && state.sweptTerms.every((t, i) => t === state.terms[i]);
    if (swept) return false;
    const work = sweepWorkload();
    return !!(work.pages && work.terms);
  }

  function hideSweepOffer() {
    const box = el('sweepoffer');
    if (box) box.hidden = true;
  }

  function offerSweepAfterSearch() {
    // Only when a second check would actually do work (same gate as the
    // panel button). Reading already settled → no popout.
    if (!shouldOfferSweep()) return;
    state.sweepOfferShown = true;
    el('sweepoffer').hidden = false;
    el('sweepofferx').focus();
  }

  function bindSweepOffer() {
    const box = el('sweepoffer');
    if (!box || box.dataset.bound) return;
    box.dataset.bound = '1';
    const close = () => { hideSweepOffer(); };
    const skip = () => { hideSweepOffer(); };
    const go = () => {
      hideSweepOffer();
      runSweep();
    };
    el('sweepofferskip').addEventListener('click', skip);
    el('sweepofferx').addEventListener('click', close);
    el('sweepoffergo').addEventListener('click', go);
    box.addEventListener('pointerdown', event => {
      if (event.target === box) skip();
    });
    document.addEventListener('keydown', event => {
      if (box.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        skip();
      }
    }, true);
  }


  // Put long sidebar copy behind "Show more" so the panel stays scannable.
  // Short notes stay as plain text. Child nodes (e.g. refused-spot lists)
  // always go in the expanded body.
  const SIDEBAR_NOTE_COLLAPSE = 140;

  function setSidebarNote(note, summaryText, fullText, extraNodes) {
    note.textContent = '';
    const extras = (extraNodes || []).filter(Boolean);
    const full = fullText == null ? summaryText : fullText;
    const long = (full && full.length > SIDEBAR_NOTE_COLLAPSE) || extras.length > 0;
    if (!long) {
      note.textContent = summaryText || '';
      for (const node of extras) note.append(node);
      return;
    }
    const details = document.createElement('details');
    details.className = 'sidebar-note-more';
    const summary = document.createElement('summary');
    const short = (summaryText || full).trim();
    const clipped = short.length > 110 ? short.slice(0, 107).replace(/\s+\S*$/, '') + '…' : short;
    summary.append(document.createTextNode(clipped + ' '));
    const toggle = document.createElement('span');
    toggle.className = 'sidebar-note-toggle';
    toggle.textContent = 'Show more';
    summary.append(toggle);
    details.append(summary);
    const body = document.createElement('div');
    body.className = 'sidebar-note-full';
    body.append(document.createTextNode(full));
    for (const node of extras) body.append(node);
    details.append(body);
    details.addEventListener('toggle', () => {
      toggle.textContent = details.open ? 'Show less' : 'Show more';
    });
    note.append(details);
  }

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
      const work = sweepWorkload();
      // Reading already settled every typed word — nothing for shape to do.
      if (!work.pages || !work.terms) {
        button.hidden = true;
        setSidebarNote(note,
          'Nothing left for a second check – reading already covered every typed word.');
        return;
      }
      button.hidden = false;
      button.textContent = 'Comprehensive Check';
      // Honest about the cost, because it is the whole reason this is a
      // button rather than the default.
      const first = state.pages[0];
      const megapixels = first ? (first.source.width * first.source.height) / 1e6 : 2;
      // Cost tracks pages times terms that still need a shape pass, not the whole doc.
      const seconds = Math.round(
        work.pages * work.terms * megapixels * SWEEP_SECONDS_PER_MP);
      if (state.sweepStopped && state.sweepReached) {
        const full = 'Stopped after ' + state.sweepReached
          + ' page' + (state.sweepReached === 1 ? '' : 's') + ' still in doubt'
          + (state.sweepAdded
            ? ', having added ' + state.sweepAdded
              + (state.sweepAdded === 1 ? ' mark' : ' marks') + ' in amber. '
            : ', having found nothing new. ')
          + 'Start it again to finish the rest - about '
          + describeTime(seconds) + '.';
        setSidebarNote(note, 'Second check stopped – about '
          + describeTime(seconds) + ' left to finish.', full);
        return;
      }
      const offerFull = 'The first search may miss lettering in logos, photos '
        + 'and coloured headers, and can mark the wrong spot. A second check '
        + 're-inspects by shape where reading missed or was unsure ('
        + work.pages + (work.pages === 1 ? ' page' : ' pages')
        + (work.terms !== state.terms.length
          ? ', ' + work.terms + (work.terms === 1 ? ' word' : ' words')
          : '')
        + '), runs in the background, updates the sidebar, and shows new marks '
        + 'in amber. About ' + describeTime(seconds) + '.';
      setSidebarNote(note,
        'Optional second check – about ' + describeTime(seconds) + '.',
        offerFull);
      return;
    }

    button.hidden = true;
    let summary;
    let full;
    if (state.sweepSkipped) {
      summary = 'Nothing left for a second check – reading already covered every typed word.';
      full = summary;
    } else if (state.sweepAdded === 0) {
      summary = 'Second check found nothing new.';
      full = 'The second check found nothing the reading had missed.';
    } else {
      summary = 'Second check added ' + state.sweepAdded
        + (state.sweepAdded === 1 ? ' amber mark' : ' amber marks')
        + '. Press Redact to cover '
        + (state.sweepAdded === 1 ? 'it' : 'them') + '.';
      full = 'The second check added ' + state.sweepAdded
        + (state.sweepAdded === 1 ? ' mark' : ' marks')
        + ', outlined in amber. Press Redact to cover '
        + (state.sweepAdded === 1 ? 'it' : 'them') + '.';
    }

    const extras = [];
    if (state.sweepRefused) {
      const spots = (state.sweepRefusedAt || []).slice()
        .sort((a, b) => a.pageIndex - b.pageIndex || a.at - b.at);
      full += ' ' + state.sweepRefused
        + (state.sweepRefused === 1 ? ' other spot was' : ' other spots were')
        + ' left alone because the page reader had already read '
        + (state.sweepRefused === 1 ? 'it' : 'them')
        + ' as something else. If a mark you expected is missing, '
        + (spots.length ? 'look here:' : 'that is where to look.');
      if (spots.length) {
        extras.push(tallyRows(spots.map(spot => ({
          pageIndex: spot.pageIndex, kind: 'refused', at: spot.at,
        }))));
      }
      summary = summary.replace(/\.$/, '') + ' · '
        + state.sweepRefused + ' skipped by the reader.';
    }
    setSidebarNote(note, summary, full, extras);
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
      box.dispatchEvent(new CustomEvent('blinded:sample'));
      el('sampleclose').focus();
    };
    const hide = () => {
      if (box.hidden) return;
      box.hidden = true;
      el('sample-open').focus();
    };
    // Zooming the picture: pinch, double tap, drag to move about.
    //
    // The browser's own pinch is off for the whole app — it zoomed the panel
    // and the header along with the page and left nothing more readable — so
    // every gesture here is handled by hand, as the document itself does it.
    //
    // The width is what moves, not a transform: the stage scrolls, so moving
    // about a zoomed picture is a scroll position rather than arithmetic about
    // a transform origin.
    //
    // What was wrong with that on its own: growing the width pushes the
    // picture out to the right, and a scroll position left at zero keeps the
    // left edge under the fingers. Pinching the middle of the slide enlarged
    // it and then showed you its left margin. So a zoom now takes the point it
    // is zooming about — the middle of the pinch, or the tap — and puts the
    // same point of the picture back under it afterwards.
    {
      const stage = box.querySelector('.samplestage');
      const img = el('samplebig');
      const held = new Map();
      const FIT = 1;
      const MOST = 5;
      const TAP_TO = 2.5;       // what a double tap goes to
      const TAP_GAP = 320;      // and how quickly the second tap must come
      const TAP_NEAR = 34;      // and how near the first
      let span = 0;
      let from = 1;
      let big = 1;
      let anchor = null;
      let panning = null;
      let wandered = false;
      let tappedAt = 0;
      let tappedNear = null;

      const spanOf = list => Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
      const midOf = list => ({ x: (list[0].x + list[1].x) / 2,
                               y: (list[0].y + list[1].y) / 2 });

      // Where a screen point lands in the picture, measured in units of the
      // fitted picture so it means the same thing at any zoom.
      const pointIn = at => {
        const view = stage.getBoundingClientRect();
        return { x: (stage.scrollLeft + at.x - view.left) / big,
                 y: (stage.scrollTop + at.y - view.top) / big };
      };

      // Zoom to `next` and put `point` of the picture back under `at`.
      //
      // This is the half that was missing. Growing the width pushes the
      // picture out to the right, and a scroll position left at zero keeps
      // the left edge under the fingers: pinching the middle of the slide
      // enlarged it and then showed you its left margin.
      const put = (point, at, next) => {
        const view = stage.getBoundingClientRect();
        big = Math.max(FIT, Math.min(MOST, next));
        img.style.setProperty('--big', (big * 100) + '%');
        // Read a layout property so the new width is in effect before the
        // scroll is set against it; without this the browser clamps the
        // scroll to the picture's old size and the zoom lands somewhere else.
        void stage.scrollWidth;
        stage.scrollLeft = point.x * big - (at.x - view.left);
        stage.scrollTop = point.y * big - (at.y - view.top);
      };

      const zoomTo = (next, at) => {
        const view = stage.getBoundingClientRect();
        const about = at || { x: view.left + view.width / 2,
                              y: view.top + view.height / 2 };
        put(pointIn(about), about, next);
      };

      stage.addEventListener('pointerdown', event => {
        held.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (held.size === 2) {
          // A second finger ends the drag the first one was making and starts
          // a pinch from wherever the picture is now.
          panning = null;
          const now = [...held.values()];
          span = spanOf(now);
          from = big;
          // The point of the picture the two fingers started out agreeing on.
          // Held for the whole gesture rather than recomputed as it goes: a
          // pinch arrives one finger at a time, so the middle wanders between
          // events, and re-anchoring on each of them walks the picture out
          // from under the fingers a little at a time.
          anchor = pointIn(midOf(now));
          return;
        }
        if (held.size > 2) return;
        wandered = false;
        panning = { x: event.clientX, y: event.clientY,
                    left: stage.scrollLeft, top: stage.scrollTop };
        try { stage.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
      });

      stage.addEventListener('pointermove', event => {
        if (!held.has(event.pointerId)) return;
        held.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (held.size === 2 && span && anchor) {
          event.preventDefault();
          const now = [...held.values()];
          // The picture follows the middle of the pinch, so two fingers
          // moving together carry it about as well as apart.
          put(anchor, midOf(now), from * (spanOf(now) / span));
          return;
        }

        if (!panning) return;
        const dx = event.clientX - panning.x;
        const dy = event.clientY - panning.y;
        if (Math.hypot(dx, dy) > 4) wandered = true;
        // Moving about is our business too: two fingers being a zoom means
        // the stage cannot have the browser's own touch scrolling, so one
        // finger drags the picture under itself.
        event.preventDefault();
        stage.scrollLeft = panning.left - dx;
        stage.scrollTop = panning.top - dy;
      });

      const letGo = event => {
        const was = held.get(event.pointerId);
        held.delete(event.pointerId);
        if (held.size < 2) { span = 0; anchor = null; }
        if (held.size === 0) panning = null;
        if (!was || wandered || held.size) return;

        // Two taps in the same place: in to a readable size about that point,
        // or back to the whole slide if it is already in.
        const now = Date.now();
        const near = tappedNear
          && Math.hypot(tappedNear.x - was.x, tappedNear.y - was.y) < TAP_NEAR;
        if (now - tappedAt < TAP_GAP && near) {
          tappedAt = 0;
          tappedNear = null;
          if (big > FIT + 0.01) zoomTo(FIT);
          else zoomTo(TAP_TO, was);
          return;
        }
        tappedAt = now;
        tappedNear = was;
      };
      stage.addEventListener('pointerup', letGo);
      stage.addEventListener('pointercancel', event => {
        held.delete(event.pointerId);
        if (held.size < 2) { span = 0; anchor = null; }
        if (held.size === 0) panning = null;
      });

      // Every opening starts at the whole picture, rather than wherever the
      // last one was left.
      box.addEventListener('blinded:sample', () => {
        big = 1;
        img.style.setProperty('--big', '100%');
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
      });
    }

    el('sample-open').addEventListener('click', show);
    el('sampleclose').addEventListener('click', hide);
    // Anywhere but the picture is a way out, and the one people reach for.
    // Not only the backdrop: the frame around the picture is outside it too,
    // and a click there that did nothing would read as a dialog that has
    // stopped responding rather than as a miss.
    box.addEventListener('click', event => {
      if (!event.target.closest('.samplestage, .sample-x')) hide();
    });
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
  // Leaving the tool is navigation, so the browser's own Back has to mean what
  // it looks like it means.
  //
  // The views were switched without touching history, so pressing Back on the
  // questions page left the site altogether — taking the open document with
  // it, since the document lives in the tab and nowhere else. That is the
  // worst possible thing for a browser button to do here.
  //
  // So going away pushes an entry, and every way back — the header button, the
  // one at the foot of the questions, and the browser's own — is the same
  // history step. Counted, so that Back is only ever called on an entry this
  // page put there: a page that has pushed nothing must not send the reviewer
  // to whatever they were looking at before.
  // One entry, however many pages are read while away — and whether we are
  // away is read off the history entry itself, never counted.
  //
  // It used to push one entry per visit, and the pages link to each other:
  // open the front page from a document, then the questions from the foot of
  // it, and there were two. Back to the tool went back one, to the front page,
  // where the button says Back to the tool again.
  //
  // Then it was one entry and a counter, and the counter drifted. Five places
  // change the view directly — a file opened, a file closed, a draft asking
  // for its document — and none of them could know about a number kept beside
  // them. Once it disagreed with the stack, Back to the tool went back to an
  // entry that still said "questions", and a reviewer who pressed Home and
  // then Back to the tool arrived at Q&A.
  //
  // So nothing is counted. The browser owns this state, and asking it cannot
  // drift.
  const awayNow = () => (history.state && history.state.away) || null;

  function goAway(name) {
    show(name);
    if (awayNow()) history.replaceState({ away: name }, '');
    else history.pushState({ away: name }, '');
  }

  function comeBack() {
    if (awayNow()) history.back();
    // Nothing of ours on the stack: put the reviewer where the tool is,
    // rather than wherever the browser would have gone.
    else show(hasDocument() ? 'review' : 'drop');
  }

  // The tool reached by something other than the way back — a file opened, a
  // file closed, a draft that wants its document. Whatever entry stood for
  // "away" is not true any more, so it is cleared here rather than left to be
  // found later by a Back that now means something else.
  function showTool(name) {
    show(name);
    if (awayNow()) history.replaceState({}, '');
  }

  window.addEventListener('popstate', event => {
    const away = event.state && event.state.away;
    show(away || (hasDocument() ? 'review' : 'drop'));
  });

  el('faq-open').addEventListener('click', () => {
    // Three jobs, one button, and the label always says which one it is doing:
    // open the questions, close them, or leave the front page for the document
    // it was being read alongside.
    if (!views.faq.hidden) comeBack();
    else if (views.drop.hidden === false && hasDocument()) comeBack();
    else goAway('faq');
  });
  el('faq-back-bottom').addEventListener('click', comeBack);
  el('home-top').addEventListener('click', () => goAway('drop'));
  el('foot-faq').addEventListener('click', () => goAway('faq'));

  el('page-prev').addEventListener('click', () => stepPage(-1));
  el('page-next').addEventListener('click', () => stepPage(1));
  // Clears every mark on the open document and redraws from the pristine
  // source canvases. The file stays open; OCR and the text layer stay.
  function resetToOriginal() {
    dismissedText.clear();
    for (const page of state.pages) {
      page.findings = [];
      page.hits = [];
      page.imageHits = [];
      page.manual = [];
      page.texts = [];
      page.dismissed = new Set();
    }
    state.findings = [];
    el('termbox').value = '';
    state.terms = [];
    state.templates = [];
    state.labelOverrides = {};
    state.labels = { byId: {}, entries: [] };
    state.applied = false;
    state.exported = false;
    state.searched = false;
    state.searchedTerms = [];
    state.sweptTerms = [];
    state.sweepAdded = 0;
    state.sweepStopped = false;
    state.sweepReached = 0;
    state.sweepRefused = 0;
    state.sweepRefusedAt = [];
    state.countedTerms = [];
    state.countedKinds = [];
    state.openTally = null;
    state.picked = new Set();
    undoStack.length = 0;
    refreshUndo();
    setMode('box');
    renderTemplates();
    if (state.kind === 'text') {
      rescan();
    } else {
      rescan();
      for (const page of state.pages) drawPage(page);
    }
    refreshApply();
    renderTermCounts();
    renderKinds();
    draftNote('Reset to the original document. Marks, words and picks are cleared.');
  }

  function closeDocument() {
    // Back to the front page as if nothing was open — drop zone for a new file.
    pendingDraft = null;
    dropDraftPrompt();
    state.pages = [];
    state.text = '';
    state.findings = [];
    state.name = '';
    state.sourceSize = 0;
    state.sourceDigest = null;
    dismissedText.clear();
    el('termbox').value = '';
    state.terms = [];
    state.templates = [];
    state.labelOverrides = {};
    state.labels = { byId: {}, entries: [] };
    state.applied = false;
    state.exported = false;
    state.searched = false;
    state.searchedTerms = [];
    state.countedTerms = [];
    state.countedKinds = [];
    state.sweptTerms = [];
    state.sweepAdded = 0;
    state.sweepStopped = false;
    state.sweepReached = 0;
    state.sweepSkipped = false;
    state.sweepOfferShown = false;
    state.sweepRefused = 0;
    state.sweepRefusedAt = [];
    state.openTally = null;
    state.picked = new Set();
    state.ocrRead = false;
    state.ocrFailed = false;
    undoStack.length = 0;
    refreshUndo();
    setMode('box');
    renderTemplates();
    renderTermCounts();
    renderKinds();
    renderSweep();
    refreshApply();
    showTool('drop');
  }

  el('reset-top').addEventListener('click', async () => {
    // Nothing open means nothing to lose, and a confirmation for that would be
    // the kind of prompt people learn to click through.
    if (!(state.pages.length || state.text)) {
      showTool('drop');
      return;
    }
    const exported = state.applied && state.exported;
    const answer = await confirmAction({
      title: 'Reset or close this file?',
      body: 'Reset to original clears every mark and keeps this file open. '
        + 'Close file returns to the front page so you can start fresh. '
        + 'Nothing is saved anywhere, so this cannot be undone'
        + (exported ? '.' : ' – and you have not exported it yet.'),
      resetLabel: 'Reset to original',
      saveLabel: 'Save draft & close file',
      confirmLabel: 'Close file',
      // Close only – back to the drop zone. Opening a new file is the front
      // page's job, not this button's.
      onConfirm: () => { closeDocument(); },
    });
    if (!answer) return;
    if (answer === 'reset') {
      resetToOriginal();
      return;
    }
    // The draft is written before anything is thrown away, so a failed save
    // does not happen after the document it describes has gone.
    if (answer === 'save') {
      await saveDraft();
      closeDocument();
      return;
    }
    // Close file already returned to the front page in onConfirm.
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
    setPane, placeToolbar, onPhone, hasDocument, goAway, comeBack,
    scrollerFor, setTool, marking,
    runSearch, applyRedaction: runSearch, coverMarks, uncoverMarks, applyButton,
    activeBoxes,
    renderSheet, setOrder, moveTo, keepOnlyPicked, dropPicked, openSections,
    turnPages, turnPage, addNoteAt, dropNote, selectNote, editNote, commitNote,
    notesOf, renderNotes, notesToDraw, startPlacingText, stopPlacingText,
    resizeNote, NOTE_COLOURS, NOTE_SIZE,
    edgeScroll, stopEdgeScroll, CREEP_EDGE, fitSheet, rollSections,
    creepEdges, pushScroll, startChoosing, stopChoosing, CHOOSE_HOLD,
    addDocument, addDocuments, pickedInOrder, selectPage, thumbFor, organiseStamp,
    kindsKnown, unknownKinds, countsByKind, detectOcr, renderKinds, placesForKind,
    spotlight, rectsOfMark, dropMark, reportFor,
    syncCountedKindsAfterToggle,
    markPending, needsSearch, markDuplicates, onePerPlace, plannedCount,
    refreshApply, kindAnswered,
    pendingTemplates,
    termsNeedingPictures,
    readPages, matchOcr, ocrPending, ocrMatchStale, showWordControls,
    sweepTemplates, runSweep, renderSweep, alreadyCovered, readerContradicts, sweepPartsFor,
    pageHasConfidentTerm, pagesNeedingSweep, sweepWorkload,
    READER_SURE, sweepProgress,
    settleSweep,
    redrawAll, legs, leg, busyNote,
    describeTime,
    busy, pageProgress, requestPause,
    renderTermCounts };
})();
