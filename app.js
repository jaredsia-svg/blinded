// Blackbar's controller: file in, review, redacted file out.
//
// The review step is the product. Detection is a suggestion engine and it is
// wrong in both directions, so every proposal is visible on the document
// itself and every one of them can be turned off by clicking it. Nothing is
// covered that the reviewer has not seen.
(function () {
  'use strict';

  const Detect = window.BlackbarDetect;
  const Boxes = window.BlackbarBoxes;
  const PdfRead = window.BlackbarPdfRead;
  const PdfWrite = window.BlackbarPdfWrite;
  const Render = window.BlackbarRender;
  const measure = window.BlackbarMeasure.create();
  const Match = window.BlackbarMatch;
  const ImageSearch = window.BlackbarImageSearch;

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
  };
  let nextTemplateId = 1;

  // ---------- chrome ----------

  function busy(on, message) {
    el('busy').hidden = !on;
    if (message) el('busy-text').textContent = message;
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
        const pages = await PdfRead.load(bytes, (n, total) =>
          busy(true, 'Rendering page ' + n + ' of ' + total + '…'));
        startReview('pdf', file.name, pages);
      } else if (/^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
        busy(true, 'Reading the image…');
        startReview('image', file.name, [await loadImage(file)]);
      } else if (/^text\//.test(file.type) || TEXT_EXT.test(file.name)) {
        busy(true, 'Reading the file…');
        state.text = await file.text();
        startReview('text', file.name, []);
      } else {
        fail('Blackbar can open PDFs, PNG and JPEG images, and plain text files. That looked like none of those.');
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

    if (kind !== 'text') buildPageElements();
    show('review');
    rescan();
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
    renderKinds();
    renderTermCounts();
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
      (sum, p) => sum + p.imageHits.filter(m => !p.dismissed.has(m.id)).length, 0);
    const skipped = state.kind === 'text'
      ? dismissedText.size
      : state.pages.reduce((sum, p) => sum + p.dismissed.size, 0);

    const parts = ['<strong>' + covered + '</strong> text match' + (covered === 1 ? '' : 'es') + ' will be covered'];
    if (images) parts.push('<strong>' + images + '</strong> image match' + (images === 1 ? '' : 'es'));
    if (manual) parts.push('<strong>' + manual + '</strong> box' + (manual === 1 ? '' : 'es') + ' you drew');
    if (skipped) parts.push('<strong>' + skipped + '</strong> you turned off');
    el('counts').innerHTML = parts.join('<br>');

    const total = covered + manual + images;
    el('export').disabled = total === 0 && state.kind !== 'text';
    el('exportnote').textContent = total === 0 ? 'Nothing is selected yet.' : '';
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
    const spans = page.hits.filter(h => !page.dismissed.has(h.finding.id)).map(h => h.finding);
    const images = page.imageHits.filter(m => !page.dismissed.has(m.id)).map(m => m.rect);
    return Boxes.boxesForSpans(page.items, spans, { advance: measure })
      .concat(images)
      .concat(page.manual);
  }

  function drawPage(page, preview) {
    const ctx = page.canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, page.canvas.width, page.canvas.height);
    ctx.drawImage(page.source, 0, 0);

    // Solid black, exactly as it will be burned in — the preview must not be
    // more reassuring than the output.
    ctx.fillStyle = '#000';
    for (const box of activeBoxes(page)) ctx.fillRect(box.x, box.y, box.w, box.h);

    // Dismissed detections: dashed, so a mistaken dismissal is obvious and
    // can be clicked back on.
    const off = page.hits.filter(h => page.dismissed.has(h.finding.id));
    const offImages = page.imageHits.filter(m => page.dismissed.has(m.id));
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
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(preview.x, preview.y, preview.w, preview.h);
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
      } else {
        const at = page.manual.length;
        page.manual.push(rect);
        pushUndo('the box you drew', () => page.manual.splice(at, 1));
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
    for (const m of page.imageHits) {
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
    for (const m of page.imageHits) {
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

  function setMode(mode) {
    state.mode = mode;
    const button = el('pick');
    button.classList.toggle('on', mode === 'pick');
    button.textContent = mode === 'pick' ? 'Cancel — drag a box around a logo' : 'Pick a logo to match';
    for (const page of state.pages) {
      if (page.canvas) page.canvas.parentElement.classList.toggle('picking', mode === 'pick');
    }
    el('tip').textContent = mode === 'pick'
      ? 'Drag a box around the logo you want found everywhere else.'
      : 'Drag on the page to add a box by hand. Click a box you added to remove it.';
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
    };
    state.templates.push(template);
    pushUndo('picking that logo', () => dropTemplate(template.id));
    await runSearch(template);
  }

  // Re-runs one template across the document and replaces its matches. Called
  // on pick and again whenever the sensitivity changes, so what is on screen
  // always reflects the current threshold rather than the one in force when
  // the logo happened to be picked.
  async function runSearch(template) {
    busy(true, 'Looking for that image…');
    try {
      const { matches: hits, best } = await ImageSearch.search(
        state.pages, template.cut, { threshold: sensitivity() },
        (done, total) => busy(true, 'Searching page ' + done + ' of ' + total + '…'));
      template.best = best;

      for (const page of state.pages) {
        page.imageHits = page.imageHits.filter(m => m.templateId !== template.id);
      }
      hits.forEach((hit, n) => {
        const page = state.pages[hit.pageIndex];
        if (!page) return;
        page.imageHits.push({
          // Stable across a re-search at a new threshold, so a match the
          // reviewer already dismissed stays dismissed.
          id: template.id + ':' + hit.pageIndex + ':' + Math.round(hit.x) + ':' + Math.round(hit.y),
          templateId: template.id,
          rect: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
          score: hit.score,
        });
      });
      template.matches = hits.length;

      // "0 found" on its own reads as a broken feature. Saying what the best
      // score actually was turns it into a decision the reviewer can act on.
      if (hits.length === 0) {
        const near = best > 0 ? best.toFixed(2) : null;
        el('pickhint').textContent = near
          ? 'No match at ' + sensitivity().toFixed(2) + '. The closest thing on the page scored '
            + near + ' — lower the sensitivity below that to include it.'
          : 'Nothing resembling that was found anywhere in the document.';
        el('pickhint').classList.add('warnhint');
      } else {
        el('pickhint').textContent = 'Draw a box around a logo, stamp, signature or face. '
          + 'Every place it appears again is found and proposed.';
        el('pickhint').classList.remove('warnhint');
      }

      for (const page of state.pages) drawPage(page);
      renderTemplates();
      renderCounts();
    } catch (error) {
      alert('That image search could not finish: ' + (error && error.message ? error.message : error));
    } finally {
      busy(false);
    }
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

    for (const page of state.pages) drawPage(page);
    renderTemplates();
    renderCounts();
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
    for (const template of state.templates) {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.className = 't';
      name.textContent = template.matches === 1 ? 'found once' : 'found ' + template.matches + ' times';

      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = String(template.matches);

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

      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = n === 0 ? 'not found' : String(n);

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
      if (dismissedText.has(f.id)) { mark.className = 'off'; mark.title = f.label + ' — click to cover it'; }
      mark.addEventListener('click', () => {
        const wasOff = dismissedText.has(f.id);
        if (wasOff) dismissedText.delete(f.id); else dismissedText.add(f.id);
        pushUndo(wasOff ? 'covering that again' : 'keeping that match',
          () => { if (wasOff) dismissedText.add(f.id); else dismissedText.delete(f.id); });
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
        const blob = new Blob([Detect.applyToText(state.text, spans, 'block')], { type: 'text/plain' });
        download(blob, redactedName('txt'));
      } else if (state.kind === 'image') {
        const page = state.pages[0];
        const flat = Render.flatten(page.source, activeBoxes(page));
        download(await Render.canvasToBlob(flat, 'image/png'), redactedName('png'));
      } else {
        const lossless = el('lossless').checked;
        const built = [];
        for (const page of state.pages) {
          busy(true, 'Flattening page ' + (page.index + 1) + ' of ' + state.pages.length + '…');
          const flat = Render.flatten(page.source, activeBoxes(page));
          built.push({
            widthPt: page.widthPt,
            heightPt: page.heightPt,
            image: await Render.encodeForPdf(flat, lossless),
          });
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

  let termsTimer = null;
  el('terms').addEventListener('input', () => {
    clearTimeout(termsTimer);
    termsTimer = setTimeout(() => {
      state.terms = el('terms').value.split('\n').map(s => s.trim()).filter(Boolean);
      rescan();
    }, 200);
  });

  el('medium').addEventListener('change', e => { state.includeMedium = e.target.checked; rescan(); });

  el('pick').addEventListener('click', () => setMode(state.mode === 'pick' ? 'box' : 'pick'));
  el('undo').addEventListener('click', undoLast);
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
  let sensTimer = null;
  el('sens').addEventListener('input', () => {
    el('sensvalue').textContent = sensitivity().toFixed(2);
    clearTimeout(sensTimer);
    sensTimer = setTimeout(async () => {
      for (const template of state.templates) await runSearch(template);
    }, 350);
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
    undoStack.length = 0;
    refreshUndo();
    setMode('box');
    renderTemplates();
    renderTermCounts();
    show('drop');
  });

  window.Blackbar = { state, rescan, loadFile, exportFile, setMode, runSearch, addTemplate, undoLast, undoStack };
})();
