// End-to-end pass in a real browser.
//
// This is the suite that matters, because Blinded's promise is about the file
// that comes out the other side. It loads a PDF that genuinely contains text,
// drives the review UI the way a person would, exports, and then re-opens the
// export to confirm the text is gone and the pixels are black.
import { createReadStream, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { buildTextPdf, buildLogoPdf, LOGO_PLACEMENTS,
  buildWordmarkPdf, WORDMARK_PLACEMENTS, WORDMARK_ASPECT,
  buildSmallLogoPdf, SMALL_LOGO_PLACEMENTS, WORDMARK_BOX,
  buildDoubleFoundPdf, DOUBLE_TERM } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(join(here, '..'));

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) passed++;
  else failures.push(label + (detail === undefined ? '' : ' — ' + detail));
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
};

function serve() {
  const server = createServer((req, res) => {
    const requested = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const path = join(root, normalize(requested === '/' ? '/index.html' : requested));
    if (!path.startsWith(root)) return res.writeHead(403).end();
    try { statSync(path); } catch { return res.writeHead(404).end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  return new Promise(done => server.listen(0, () => done({ server, port: server.address().port })));
}

const { server, port } = await serve();
const base = 'http://127.0.0.1:' + port + '/';

const fixturePath = join(tmpdir(), 'blinded-fixture.pdf');
writeFileSync(fixturePath, buildTextPdf());
const logoPath = join(tmpdir(), 'blinded-logo.pdf');
writeFileSync(logoPath, buildLogoPdf());
const doublePath = join(tmpdir(), 'blinded-double.pdf');
writeFileSync(doublePath, buildDoubleFoundPdf());
const smallLogoPath = join(tmpdir(), 'blinded-smalllogo.pdf');
writeFileSync(smallLogoPath, buildSmallLogoPdf());
const wordmarkPath = join(tmpdir(), 'blinded-wordmark.pdf');
writeFileSync(wordmarkPath, buildWordmarkPdf());
const textPath = join(tmpdir(), 'blinded-fixture.txt');
writeFileSync(textPath, 'Jane Doe — jane.doe@example.com — (415) 555-0132\nnothing sensitive here\n');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

// Marking up and redacting are two steps now, so every test that wants to see
// or export a finished redaction has to press the button in between. Waiting
// on state.applied rather than on a timeout keeps this honest about the
// searches actually having run.
// Two panel sections start collapsed, so a test has to open one before it can
// touch what is inside — exactly as a person would.
async function reveal(page, id) {
  await page.evaluate(target => {
    const node = document.getElementById(target);
    const section = node && node.closest('details');
    if (section) section.open = true;
  }, id);
}

async function redact(page) {
  await page.click('#apply');
  await page.waitForFunction(() => window.Blinded.state.applied === true, { timeout: 240000 });
  await page.waitForFunction(() => document.getElementById('busy').hidden, { timeout: 240000 });
}

const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  // ---------- load ----------
  await page.goto(base);
  check('the drop view is the first thing shown', await page.isVisible('#view-drop'));
  check('the header tagline is on screen',
    (await page.textContent('#claim')).trim().length > 0,
    await page.textContent('#claim'));
  // The tagline no longer carries the privacy claim, so check it still exists
  // somewhere a new reader will meet it rather than letting it quietly vanish.
  check('the privacy claim survives on the front page',
    /never uploaded|no server|nothing is uploaded|no llm/i.test(
      await page.textContent('#view-drop')));

  // Nothing that happens in this tab can be recovered once it is gone: there
  // is no uploaded copy to reload, and the terms, crops and boxes exist only
  // here. A reflexive refresh must not throw that away without asking.
  const guardBefore = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  check('an empty page does not nag about leaving', guardBefore === false);

  await page.setInputFiles('#file', fixturePath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  check('the review view opens after a PDF is chosen', await page.isVisible('#view-review'));
  check('the document name is shown', (await page.textContent('#doc-name')).endsWith('.pdf'));

  // The other half of the unload guard, asserted here because it only means
  // anything once a document is actually open.
  const guardAfter = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return { prevented: e.defaultPrevented, value: e.returnValue,
             pages: window.Blinded.state.pages.length };
  });
  check('the guard is looking at a document that is really open',
    guardAfter.pages > 0, JSON.stringify(guardAfter));
  check('with a document loaded, refreshing is interrupted',
    guardAfter.prevented === true, JSON.stringify(guardAfter));
  // The handler also sets returnValue, which is what older browsers read
  // instead of preventDefault. A synthetic Event exposes that property as the
  // legacy boolean rather than the string a real BeforeUnloadEvent carries,
  // so what is checked is that the handler drove it falsy — true under either
  // shape, and false if the handler never ran.
  check('and the older returnValue route is driven too',
    guardAfter.value === false, JSON.stringify(guardAfter));

  const rendered = await page.evaluate(() => {
    const p = window.Blinded.state.pages;
    return { pages: p.length, w: p[0].source.width, h: p[0].source.height, items: p[0].items.length };
  });
  check('the PDF rendered to one page', rendered.pages === 1);
  check('the page was rasterised at 2x', rendered.w === 1224 && rendered.h === 1584,
    rendered.w + 'x' + rendered.h);
  check('text runs were extracted with positions', rendered.items >= 6, String(rendered.items));

  // ---------- detection ----------
  const kinds = await page.evaluate(() =>
    window.Blinded.state.pages[0].findings.map(f => f.kind));
  for (const kind of ['email', 'phone', 'card']) {
    check('the page view detected a ' + kind, kinds.includes(kind), kinds.join(','));
  }

  const boxCount = await page.evaluate(() =>
    window.Blinded.state.pages[0].hits.filter(h => h.rects.length).length);
  check('every detection produced at least one box', boxCount === kinds.length,
    boxCount + ' of ' + kinds.length);

  // ---------- marked in red, then covered in black ----------
  //
  // Nothing is covered until Redact is pressed. Before it, a mark is outlined
  // so the reviewer can still read what is about to disappear — which is the
  // whole point of reviewing, and impossible once it is filled in.
  const sample = () => page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => h.finding.kind === 'email');
    const r = hit.rects[0];
    const ctx = p.canvas.getContext('2d');
    const mid = ctx.getImageData(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2), 1, 1).data;
    const edge = ctx.getImageData(Math.round(r.x), Math.round(r.y + r.h / 2), 1, 1).data;
    return { mid: [mid[0], mid[1], mid[2]], edge: [edge[0], edge[1], edge[2]], applied: window.Blinded.state.applied };
  });

  const unapplied = await sample();
  check('a document opens in review, with nothing applied', unapplied.applied === false);
  check('a marked box is not blacked out before Redact',
    !(unapplied.mid[0] === 0 && unapplied.mid[1] === 0 && unapplied.mid[2] === 0), JSON.stringify(unapplied.mid));
  check('it is tinted red instead',
    unapplied.mid[0] > unapplied.mid[2] + 15, JSON.stringify(unapplied.mid));
  check('and outlined in red',
    unapplied.edge[0] > 150 && unapplied.edge[0] > unapplied.edge[1] + 40, JSON.stringify(unapplied.edge));
  check('the export is unavailable until it has been applied',
    await page.isDisabled('#export'));

  await redact(page);
  const covered = await sample();
  check('pressing Redact covers the box in solid black',
    covered.mid[0] === 0 && covered.mid[1] === 0 && covered.mid[2] === 0, JSON.stringify(covered.mid));
  check('and the export becomes available', !(await page.isDisabled('#export')));
  check('and the button reports the document as redacted',
    (await page.textContent('#apply')).trim() === 'Redacted');

  // Changing anything puts it back into review, because a black bar that no
  // longer matches the settings is worse than no bar at all.
  await page.fill('#terms', 'Mulan');
  await page.waitForTimeout(400);
  check('changing a term returns the document to review',
    await page.evaluate(() => window.Blinded.state.applied) === false);
  check('and disables the export again', await page.isDisabled('#export'));
  await page.fill('#terms', '');
  await page.waitForTimeout(400);

  // ---------- the bar lands on the text, not beside it ----------
  //
  // Within a run, pdf.js reports only the total width, so character positions
  // are reconstructed from font metrics. Get that wrong and the bar slides
  // sideways, leaving the leading or trailing characters of the value legible
  // beside it. Rather than guess a tolerance, this measures where the ink
  // actually is: the pristine page is scanned for columns containing ink on
  // the adversarial fixture line, and the value — the last group on that line
  // — must be covered end to end.
  const guard = await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => h.finding.text === '4242424242424242');
    if (!hit) return { found: false };
    const r = hit.rects[0];

    const ctx = p.source.getContext('2d');
    const top = Math.max(0, Math.round(r.y));
    const height = Math.round(r.h);
    const row = ctx.getImageData(0, top, p.source.width, height).data;

    const inked = x => {
      for (let y = 0; y < height; y++) {
        const i = (y * p.source.width + x) * 4;
        if ((row[i] + row[i + 1] + row[i + 2]) / 3 < 128) return true;
      }
      return false;
    };

    // Five pixels is wider than the gap between two glyphs at this size and
    // narrower than a space, so a group comes out as a word.
    const groups = [];
    let run = null;
    let blank = 0;
    for (let x = 0; x < p.source.width; x++) {
      if (inked(x)) {
        if (run) { run.end = x; blank = 0; } else { run = { start: x, end: x }; }
      } else if (run && ++blank > 5) {
        groups.push(run);
        run = null;
      }
    }
    if (run) groups.push(run);

    return {
      found: true,
      ink: groups.length ? groups[groups.length - 1] : null,
      box: { x: r.x, right: r.x + r.w },
    };
  });
  check('the value on the adversarial line was detected', guard.found);
  check('its ink was located on the page', Boolean(guard.ink));
  check('the bar starts at or before the first pixel of the value',
    guard.ink && guard.box.x <= guard.ink.start,
    guard.ink ? 'bar starts ' + guard.box.x.toFixed(1) + ', ink starts ' + guard.ink.start : 'no ink');
  check('the bar ends at or after the last pixel of the value',
    guard.ink && guard.box.right >= guard.ink.end,
    guard.ink ? 'bar ends ' + guard.box.right.toFixed(1) + ', ink ends ' + guard.ink.end : 'no ink');

  // ---------- terms ----------
  await page.fill('#terms', 'Jane Doe');
  await page.waitForTimeout(400);
  const termHits = await page.evaluate(() =>
    window.Blinded.state.pages[0].findings.filter(f => f.kind === 'term').length);
  check('a listed name is found in the page text', termHits >= 1, String(termHits));

  // ---------- clicking a box turns it off, and back on ----------
  const before = await page.evaluate(() => window.Blinded.state.pages[0].dismissed.size);
  const clicked = await page.evaluate(() => {
    // Click the middle of a detection through the same coordinate path a real
    // pointer would take, so the scaling maths is under test too.
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => h.finding.kind === 'card');
    const r = hit.rects[0];
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.canvas.width;
    const x = rect.left + (r.x + r.w / 2) * sx;
    const y = rect.top + (r.y + r.h / 2) * (rect.height / p.canvas.height);
    for (const type of ['pointerdown', 'pointerup']) {
      p.canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1 }));
    }
    return p.dismissed.size;
  });
  check('clicking a detection dismisses it', clicked === before + 1, before + ' -> ' + clicked);
  check('the sidebar reports what was turned off',
    (await page.textContent('#counts')).includes('turned off'));

  const restored = await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => p.dismissed.has(h.finding.id));
    const r = hit.rects[0];
    const rect = p.canvas.getBoundingClientRect();
    const x = rect.left + (r.x + r.w / 2) * (rect.width / p.canvas.width);
    const y = rect.top + (r.y + r.h / 2) * (rect.height / p.canvas.height);
    for (const type of ['pointerdown', 'pointerup']) {
      p.canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1 }));
    }
    return p.dismissed.size;
  });
  check('clicking a dismissed detection restores it', restored === before,
    clicked + ' -> ' + restored);

  // ---------- dragging adds a box by hand ----------
  const manual = await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.canvas.width;
    const sy = rect.height / p.canvas.height;
    const send = (type, cx, cy) => p.canvas.dispatchEvent(
      new PointerEvent(type, { clientX: rect.left + cx * sx, clientY: rect.top + cy * sy, bubbles: true, pointerId: 2 }));
    send('pointerdown', 100, 900);
    send('pointermove', 500, 980);
    send('pointerup', 500, 980);
    return p.manual.length;
  });
  check('dragging on the page adds a box', manual === 1, String(manual));

  // ---------- export ----------
  await redact(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#export'),
  ]);
  check('the export is named after the original',
    download.suggestedFilename().endsWith('-redacted.pdf'), download.suggestedFilename());

  const out = join(tmpdir(), 'blinded-out.pdf');
  await download.saveAs(out);
  const bytes = new Uint8Array(readFileSync(out));

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  check('the exported PDF opens', doc.numPages === 1, String(doc.numPages));

  const outPage = await doc.getPage(1);
  const outText = await outPage.getTextContent();
  check('the exported PDF contains no text objects at all',
    outText.items.length === 0, outText.items.length + ' items survived');

  const vp = outPage.getViewport({ scale: 1 });
  check('the exported page keeps the original size',
    Math.round(vp.width) === 612 && Math.round(vp.height) === 792, vp.width + 'x' + vp.height);

  const asString = Buffer.from(bytes).toString('latin1');
  for (const secret of ['jane.doe@example.com', '4242', '123-45-6789', 'Jane Doe', 'Helvetica']) {
    check('the raw bytes of the export do not contain "' + secret + '"', !asString.includes(secret));
  }
  const meta = await doc.getMetadata();
  check('the export declares Blinded as its producer', meta.info.Producer === 'Blinded');

  // ---------- picking a logo and finding it everywhere ----------
  //
  // The fixture draws the same asymmetric mark four times across two pages, at
  // two different sizes, using path operators rather than a shared image
  // object — so this exercises the pixel matcher, not a shortcut through the
  // PDF's structure. A fifth, different mark sits on page 2 as a decoy.
  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', logoPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  check('the two-page logo document opened',
    await page.evaluate(() => window.Blinded.state.pages.length) === 2);

  // Entering pick mode changes what a drag means, and says so.
  await page.click('#pick');
  check('pick mode is announced on the button',
    (await page.textContent('#pick')).includes('drag a box'));
  check('pick mode changes the instruction under the panel',
    (await page.textContent('#tip')).includes('found everywhere else'));

  // Drag around the first logo. Its PDF coordinates are known, so convert:
  // pdf y is measured up from the bottom, the canvas is 2x, and a little
  // margin makes this a realistic hand-drawn pick rather than a perfect one.
  const first = LOGO_PLACEMENTS[0];
  await page.evaluate(({ x, y, size }) => {
    const p = window.Blinded.state.pages[0];
    const S = 2, PAD = 3;
    const cx = x * S - PAD;
    const cy = (792 - y - size) * S - PAD;
    const cw = size * S + PAD * 2;
    const ch = size * S + PAD * 2;
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.canvas.width;
    const sy = rect.height / p.canvas.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 9,
    }));
    send('pointerdown', cx, cy);
    send('pointermove', cx + cw, cy + ch);
    send('pointerup', cx + cw, cy + ch);
  }, first);

  await page.waitForFunction(() => window.Blinded.state.templates.length === 1, { timeout: 60000 });
  check('picking a logo does not search on its own',
    await page.evaluate(() => window.Blinded.state.templates[0].searched) === false);
  check('and the panel says so',
    (await page.textContent('#templates')).includes('not searched yet'),
    await page.textContent('#templates'));
  await redact(page);

  const matched = await page.evaluate(() => ({
    templates: window.Blinded.state.templates.length,
    perPage: window.Blinded.state.pages.map(p => p.imageHits.length),
    total: window.Blinded.state.pages.reduce((n, p) => n + p.imageHits.length, 0),
    scales: window.Blinded.state.pages.flatMap(p => p.imageHits.map(m => Math.round(m.rect.w))),
  }));
  check('picking a logo leaves pick mode', await page.evaluate(() => window.Blinded.state.mode) === 'box');
  check('every copy of the logo is found across both pages',
    matched.total === 4, matched.total + ' found, per page ' + JSON.stringify(matched.perPage));
  check('including the two on the second page',
    matched.perPage[1] === 1, JSON.stringify(matched.perPage));
  check('at four clearly different sizes',
    new Set(matched.scales).size === 4, 'widths ' + JSON.stringify(matched.scales));
  // The sizes the old ladder could not reach at all.
  check('including one below half the picked size',
    matched.scales.some(w => w < 60 * 2 * 0.5), JSON.stringify(matched.scales));
  check('and one above double it',
    matched.scales.some(w => w > 60 * 2 * 1.8), JSON.stringify(matched.scales));
  check('the decoy mark is not matched', matched.total === 4);
  check('the panel reports the image matches',
    (await page.textContent('#counts')).includes('image match'));
  check('the picked logo is listed with its count',
    (await page.textContent('#templates')).includes('found 4 times'),
    await page.textContent('#templates'));

  // The listing is not the deliverable — the pixels are. Preview and export
  // share activeBoxes(), so a black centre here is a black centre in the file.
  const logoPainted = await page.evaluate(() => {
    const p = window.Blinded.state.pages[1];
    const m = p.imageHits[0];
    const d = p.canvas.getContext('2d').getImageData(
      Math.round(m.rect.x + m.rect.w / 2), Math.round(m.rect.y + m.rect.h / 2), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  check('a matched logo is painted solid black on the page',
    logoPainted.every(v => v === 0), JSON.stringify(logoPainted));

  // A matched logo is a proposal like any other: clickable off and on.
  const afterClick = await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const m = p.imageHits[0];
    const rect = p.canvas.getBoundingClientRect();
    const x = rect.left + (m.rect.x + m.rect.w / 2) * (rect.width / p.canvas.width);
    const y = rect.top + (m.rect.y + m.rect.h / 2) * (rect.height / p.canvas.height);
    for (const t of ['pointerdown', 'pointerup']) {
      p.canvas.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 3 }));
    }
    return p.dismissed.size;
  });
  check('an image match can be dismissed by clicking it', afterClick === 1, String(afterClick));

  // A search that finds nothing must say what it nearly found. "0 found" on
  // its own is indistinguishable from a broken feature, which is how this
  // behaved before.
  //
  // Note what this cannot be tested with: raising the threshold. A picked logo
  // always matches *itself* at very nearly 1.0, so no sensitivity setting the
  // slider can reach will empty the results. The honest way to find nothing is
  // to pick something with no structure in it, which is also the mistake a
  // real reviewer makes — dragging across blank page.
  await page.click('#pick');
  await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.canvas.width;
    const sy = rect.height / p.canvas.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 41,
    }));
    // Empty margin near the foot of the page.
    send('pointerdown', 200, 1400);
    send('pointermove', 400, 1500);
    send('pointerup', 400, 1500);
  });
  await redact(page);
  await page.waitForFunction(
    () => document.getElementById('pickhint').classList.contains('warnhint'),
    { timeout: 120000 });
  const hint = await page.textContent('#pickhint');
  check('picking blank page reports that nothing was found',
    hint.includes('Nothing resembling that'), hint);
  check('and the empty pick adds no matches',
    await page.evaluate(() => window.Blinded.state.pages
      .reduce((n, p) => n + p.imageHits.filter(m => m.templateId === 'tpl2').length, 0)) === 0);

  // Clear that one away so the counts below describe the real logo only.
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#templates li button');
    rows[rows.length - 1].click();
  });

  // Removing the template withdraws its matches entirely.
  await page.click('#templates button');
  check('removing the picked logo removes its matches',
    await page.evaluate(() => window.Blinded.state.pages.reduce((n, p) => n + p.imageHits.length, 0)) === 0);

  // ---------- placeholder labels ----------
  //
  // The point of labelling is that a later reader meets [PERSON_1] instead of
  // a blank and can still follow the sentence. The point of testing it is the
  // opposite: proving that nothing the labels stand for travels with them.
  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', fixturePath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await page.fill('#terms', 'Jane Doe');
  await page.waitForTimeout(400);

  check('the legend is hidden until labelling is on', await page.isHidden('#legendbox'));
  await reveal(page, 'labelling');
  await page.check('#labelling');
  check('turning labelling on reveals the legend', await page.isVisible('#legendbox'));
  check('and its options', await page.isVisible('#labelopts'));

  const legendRows = await page.evaluate(() =>
    window.Blinded.state.labels.entries.map(e => [e.label, e.count]));
  check('the legend suggests a placeholder for every distinct thing',
    legendRows.length >= 5, JSON.stringify(legendRows));
  check('the typed name is suggested as a person',
    legendRows.some(([label]) => label === 'P1'), JSON.stringify(legendRows));
  check('the detectors get their own kinds',
    ['E1', 'PH1', 'C1', 'C2'].every(want =>
      legendRows.some(([label]) => label === want)), JSON.stringify(legendRows));
  check('every suggested placeholder is short enough for a narrow bar',
    legendRows.every(([label]) => label.length <= 4), JSON.stringify(legendRows));

  // A label is painted into the bar, in white on the black.
  const labelPainted = await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => h.finding.kind === 'email');
    const r = hit.rects[0];
    const ctx = p.canvas.getContext('2d');
    const strip = ctx.getImageData(Math.round(r.x), Math.round(r.y + r.h / 2),
      Math.round(r.w), 1).data;
    let light = 0;
    for (let i = 0; i < strip.length; i += 4) if (strip[i] > 200) light++;
    return light;
  });
  check('a placeholder is drawn inside the bar', labelPainted > 0,
    labelPainted + ' light pixels across the middle of the bar');

  // Editing one placeholder renames every occurrence of that thing.
  await page.evaluate(() => {
    const input = document.querySelector('#legend .labelinput');
    input.value = 'claimant';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const renamed = await page.evaluate(() =>
    window.Blinded.state.labels.entries[0].label);
  check('an edited placeholder is normalised to a machine-readable form',
    renamed === 'CLAIMANT', renamed);

  await redact(page);
  const [labelled] = await Promise.all([
    page.waitForEvent('download', { timeout: 90000 }),
    page.click('#export'),
  ]);
  const labelledOut = join(tmpdir(), 'blinded-labelled.pdf');
  await labelled.saveAs(labelledOut);
  const labelledBytes = new Uint8Array(readFileSync(labelledOut));

  const pdfjs2 = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const labelledDoc = await pdfjs2.getDocument({ data: labelledBytes }).promise;
  check('the labelled export gains a legend page',
    labelledDoc.numPages === 2, labelledDoc.numPages + ' pages');

  let extracted = '';
  for (let n = 1; n <= labelledDoc.numPages; n++) {
    const p2 = await labelledDoc.getPage(n);
    extracted += (await p2.getTextContent()).items.map(i => i.str).join(' ') + ' ';
  }
  check('the placeholders are extractable as real text',
    extracted.includes('[CLAIMANT]') && extracted.includes('[E1]'), extracted.slice(0, 200));
  check('the legend page names each placeholder',
    extracted.includes('Redaction legend') && extracted.includes("a person's name"),
    extracted.slice(-300));

  // The whole safety argument, checked against the finished bytes rather than
  // against intentions: everything the labels replaced must be absent.
  const labelledRaw = Buffer.from(labelledBytes).toString('latin1');
  for (const secret of ['Jane Doe', 'jane.doe@example.com', '4242', '123-45-6789',
    '555-0132', 'guarded.value']) {
    check('a labelled export does not contain "' + secret + '"',
      !labelledRaw.includes(secret) && !extracted.includes(secret));
  }
  check('nor does the legend page describe what anything was',
    !extracted.toLowerCase().includes('jane'), extracted.slice(-300));

  // The key is the opposite artefact, and exists only on request.
  const [keyFile] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#downloadkey'),
  ]);
  check('the key file is named so it cannot be mistaken for the document',
    /KEY-KEEP-PRIVATE\.json$/.test(keyFile.suggestedFilename()), keyFile.suggestedFilename());
  const keyOut = join(tmpdir(), 'blinded-key.json');
  await keyFile.saveAs(keyOut);
  const key = JSON.parse(readFileSync(keyOut, 'utf8'));
  check('the key warns what it is', /reconstructs everything/.test(key.warning), key.warning);
  check('the key maps a placeholder back to its original',
    key.entries.some(e => e.label === 'CLAIMANT' && e.original === 'Jane Doe'),
    JSON.stringify(key.entries.slice(0, 3)));
  check('the key covers the detected values too',
    key.entries.some(e => e.original === 'jane.doe@example.com'));

  await reveal(page, 'labelling');
  await page.uncheck('#labelling');
  check('turning labelling off hides the legend again', await page.isHidden('#legendbox'));

  // ---------- one occurrence, one mark ----------
  //
  // A word that is real text *and* recognisable by its shape gets found twice:
  // once from the text layer, once by the picture search. Two boxes over one
  // word, slightly different sizes and slightly offset — which looks like a
  // bug because it is one, and it double-counts in the panel besides.
  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', doublePath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await page.fill('#terms', DOUBLE_TERM);
  await page.waitForTimeout(400);
  await page.check('#termimages');
  await redact(page);

  const doubled = await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const textHits = p.hits.filter(h => h.finding.kind === 'term');
    const pictures = p.imageHits.filter(m => m.term);
    return {
      text: textHits.length,
      pictures: pictures.length,
      superseded: pictures.filter(m => m.superseded).length,
      live: pictures.filter(m => !m.superseded).length,
      counts: document.getElementById('counts').textContent,
    };
  });

  check('the word is found in the text layer', doubled.text > 0, String(doubled.text));
  // Without this the test would pass vacuously on a document where the picture
  // search simply found nothing.
  check('and the picture search finds it too, so there really is a duplicate',
    doubled.pictures > 0, String(doubled.pictures));
  check('every duplicate is suppressed',
    doubled.live === 0, doubled.live + ' still live of ' + doubled.pictures);
  check('and the suppression is what did it, not an empty search',
    doubled.superseded === doubled.pictures,
    doubled.superseded + ' of ' + doubled.pictures);
  check('so the panel counts the word once, not twice',
    !doubled.counts.includes('image match'), doubled.counts.replace(/\s+/g, ' '));

  // Taking the word away brings the picture matches back rather than leaving a
  // hole: they were marked, not deleted.
  await page.fill('#terms', '');
  await page.waitForTimeout(500);
  check('removing the term withdraws its matches entirely',
    await page.evaluate(() => window.Blinded.state.pages[0].imageHits.filter(m => m.term).length) === 0);

  // ---------- a typed word, found as a picture ----------
  //
  // The case the text layer cannot reach at all: a page that is purely ink,
  // like a scan or a screenshot, where the word exists only as pixels. Built
  // here with the app's own renderer and PDF writer so the fixture is a real
  // image-only document rather than an approximation of one.
  const scanBytes = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1224; c.height = 1584;
    const x = c.getContext('2d', { alpha: false });
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#111';
    x.font = '400 46px Helvetica, Arial, sans-serif';
    x.fillText('Report prepared for KAG Holdings', 90, 180);
    x.font = '700 64px Helvetica, Arial, sans-serif';
    x.fillText('KAG', 90, 400);
    x.font = '400 40px "Times New Roman", Times, serif';
    x.fillText('countersigned by KAG on the third', 90, 600);
    x.font = '400 46px Helvetica, Arial, sans-serif';
    x.fillText('Nothing sensitive on this line', 90, 800);
    const img = await window.BlindedRender.encodeForPdf(c, false);
    return Array.from(window.BlindedPdfWrite.build([{ widthPt: 612, heightPt: 792, image: img }]));
  });
  const scanPath = join(tmpdir(), 'blinded-scan.pdf');
  writeFileSync(scanPath, Buffer.from(scanBytes));

  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', scanPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

  check('the fixture really has no text layer at all',
    (await page.evaluate(() => window.Blinded.state.pages[0].text.trim())) === '',
    await page.evaluate(() => window.Blinded.state.pages[0].text.slice(0, 60)));

  await page.fill('#terms', 'KAG');
  await page.waitForTimeout(400);
  check('and so a typed word finds nothing in it by text',
    await page.evaluate(() => window.Blinded.state.pages[0].hits.length) === 0);
  check('which the term list reports rather than leaving blank',
    (await page.textContent('#termcounts')).includes('not found'),
    await page.textContent('#termcounts'));

  await page.check('#termimages');
  await redact(page);

  const pictured = await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const mine = p.imageHits.filter(m => m.term === 'KAG');
    return {
      found: mine.length,
      worst: mine.length ? Math.min(...mine.map(m => m.score)) : 0,
      labels: [...new Set(mine.map(m => window.Blinded.state.labels.byId[m.id]))],
      ys: mine.map(m => Math.round(m.rect.y)).sort((a, b) => a - b),
    };
  });
  check('every occurrence of the word is found as a picture',
    pictured.found === 3, pictured.found + ' found at y ' + JSON.stringify(pictured.ys));
  check('and none of them is a marginal score',
    pictured.worst > 0.8, 'worst ' + pictured.worst.toFixed(3));
  check('including the one set in a serif face, not just the sans ones',
    pictured.ys.some(y => y > 500), JSON.stringify(pictured.ys));
  check('the line with nothing sensitive on it is left alone',
    !pictured.ys.some(y => y > 730 && y < 800), JSON.stringify(pictured.ys));

  // A picture of a word is that word, so it shares the word's placeholder
  // rather than being labelled as an unrelated image.
  check('a pictured word shares one placeholder with the word itself',
    pictured.labels.length === 1, JSON.stringify(pictured.labels));
  check('and is not labelled as a logo',
    !pictured.labels[0].startsWith('L'), pictured.labels[0]);
  check('an acronym is not labelled as a person',
    pictured.labels[0].startsWith('T'), pictured.labels[0]);

  check('the term list reports the pictured matches separately',
    (await page.textContent('#termcounts')).includes('as picture'),
    await page.textContent('#termcounts'));

  // Turning the option off withdraws them.
  await page.uncheck('#termimages');
  check('turning the option off removes the pictured matches',
    await page.evaluate(() => window.Blinded.state.pages[0].imageHits.length) === 0);
  check('and returns the document to review',
    await page.evaluate(() => window.Blinded.state.applied) === false);

  // ---------- one pass, spread across cores ----------
  //
  // The search is split across workers, so the thing worth proving is that
  // splitting it changes nothing but the clock. Same document, same templates,
  // three routes: a sweep per template, one pass over the pages, and that same
  // pass spread across cores.
  // A four-page document, so the split across workers is real rather than
  // falling back to the single-threaded path.
  const deckBytes = await page.evaluate(async () => {
    const built = [];
    for (let i = 0; i < 4; i++) {
      const c = document.createElement('canvas');
      c.width = 1224; c.height = 1584;
      const x = c.getContext('2d', { alpha: false });
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#111';
      x.font = '700 64px Helvetica, Arial, sans-serif';
      x.fillText('KAG', 90, 180);
      x.font = '400 40px Helvetica, Arial, sans-serif';
      for (let k = 0; k < 8; k++) x.fillText('Body line ' + k + ' of page ' + (i + 1), 90, 320 + k * 70);
      x.fillStyle = '#0b2a5b'; x.fillRect(820, 110, 300, 100);
      x.fillStyle = '#fff'; x.font = '700 48px Helvetica, Arial, sans-serif';
      x.fillText('ACME', 850, 175);
      built.push({ widthPt: 612, heightPt: 792, image: await window.BlindedRender.encodeForPdf(c, false) });
    }
    return Array.from(window.BlindedPdfWrite.build(built));
  });
  const deckPath = join(tmpdir(), 'blinded-deck.pdf');
  writeFileSync(deckPath, Buffer.from(deckBytes));

  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', deckPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

  const parallel = await page.evaluate(async () => {
    const IS = window.BlindedImageSearch;
    const TI = window.BlindedTextImage;
    const pages = window.Blinded.state.pages;
    const logo = IS.templateFrom(pages[0].source, { x: 820, y: 110, w: 300, h: 100 });
    const entries = [{ key: 'logo', template: logo }]
      .concat(TI.templatesFor('KAG').map((t, i) => ({ key: 'face' + i, template: t })));

    const shape = map => [...map.entries()]
      .map(([key, v]) => key + ':' + v.matches
        .map(m => [m.pageIndex, Math.round(m.x), Math.round(m.y), m.score.toFixed(3)].join(','))
        .sort().join('|'))
      .sort().join(' ');

    const one = await IS.searchAll(pages, entries, {});
    const many = await IS.searchAllParallel(pages, entries, {});
    return {
      cores: navigator.hardwareConcurrency || 0,
      pages: pages.length,
      sameShape: shape(one) === shape(many),
      oneCount: [...one.values()].reduce((n, v) => n + v.matches.length, 0),
      manyCount: [...many.values()].reduce((n, v) => n + v.matches.length, 0),
      oneShape: shape(one).slice(0, 200),
      manyShape: shape(many).slice(0, 200),
    };
  });
  check('splitting the search across cores finds the same number of things',
    parallel.oneCount === parallel.manyCount,
    parallel.oneCount + ' vs ' + parallel.manyCount);
  check('and exactly the same things, in the same places, at the same scores',
    parallel.sameShape,
    'one: ' + parallel.oneShape + '  many: ' + parallel.manyShape);
  check('the document had enough pages for the split to be real',
    parallel.pages === 4, String(parallel.pages));
  check('and it actually found things to compare',
    parallel.oneCount > 0, String(parallel.oneCount));

  // ---------- the same word, any colours ----------
  //
  // Shape is the question, not colour. Normalising the mean and deviation out
  // of both sides already handled brightness and contrast; what failed was a
  // polarity flip — white lettering knocked out of a dark banner correlates at
  // -1 against a template cut from dark lettering on white, which is a perfect
  // match reported as a perfect mismatch. Eight real combinations here,
  // rendered and read back through the whole pipeline.
  const COMBOS = [
    ['black on white', '#111111', '#ffffff'],
    ['white on black', '#ffffff', '#111111'],
    ['white on navy', '#ffffff', '#0b2a5b'],
    ['brand blue on white', '#1f6feb', '#ffffff'],
    ['yellow on black', '#ffd400', '#111111'],
    ['red on green', '#cc0000', '#009000'],
    ['grey on grey', '#8a8a8a', '#b4b4b4'],
    ['nearly the same brightness', '#7a86ff', '#8f8340'],
  ];
  const colourBytes = await page.evaluate(async (combos) => {
    const c = document.createElement('canvas');
    c.width = 1224; c.height = 1584;
    const x = c.getContext('2d', { alpha: false });
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    combos.forEach(([, fg, bg], i) => {
      const y = 120 + i * 170;
      x.fillStyle = bg; x.fillRect(70, y - 70, 420, 120);
      x.fillStyle = fg; x.font = '700 72px Helvetica, Arial, sans-serif';
      x.textBaseline = 'middle'; x.fillText('KAG', 110, y - 10);
    });
    const img = await window.BlindedRender.encodeForPdf(c, false);
    return Array.from(window.BlindedPdfWrite.build([{ widthPt: 612, heightPt: 792, image: img }]));
  }, COMBOS);
  const colourPath = join(tmpdir(), 'blinded-colours.pdf');
  writeFileSync(colourPath, Buffer.from(colourBytes));

  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', colourPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await page.fill('#terms', 'KAG');
  await page.waitForTimeout(400);
  await page.check('#termimages');
  await redact(page);

  const coloured = await page.evaluate((combos) => {
    const p = window.Blinded.state.pages[0];
    const mine = p.imageHits.filter(m => m.term === 'KAG');
    // The embedded image is exactly the size the page renders at, so canvas
    // coordinates map one to one — no scaling between them.
    return combos.map(([name], i) => {
      const want = 120 + i * 170 - 10;
      const hit = mine.find(m => Math.abs(m.rect.y + m.rect.h / 2 - want) < 60);
      return { name, found: Boolean(hit), score: hit ? hit.score : 0, inverted: hit ? Boolean(hit.inverted) : false };
    });
  }, COMBOS);

  for (const row of coloured) {
    check('the word is found in ' + row.name,
      row.found && row.score > 0.95,
      row.found ? row.score.toFixed(3) : 'missed');
  }
  check('the light-on-dark ones are recognised as inverted',
    coloured.filter(r => r.inverted).length >= 2,
    JSON.stringify(coloured.map(r => [r.name, r.inverted])));
  check('and the dark-on-light ones are not',
    coloured.find(r => r.name === 'black on white').inverted === false);

  // ---------- a small logo, repeated at the same size ----------
  //
  // The simplest case there is, and the one that was broken: three identical
  // copies of a small wordmark, so all three sit at scale 1.0 relative to
  // whichever is picked. A search that cannot find a logo identical to the one
  // it was handed cannot find anything, and this reported "found 0 times".
  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', smallLogoPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await page.click('#pick');

  await page.evaluate(({ place, box }) => {
    const p = window.Blinded.state.pages[0];
    const S = 2, PAD = 4;
    const { x, y } = place[0];
    // The ruled box starts 5pt left and 6pt below the text origin.
    const cx = (x - 5) * S - PAD;
    const cy = (792 - y - 24) * S - PAD;
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.canvas.width;
    const sy = rect.height / p.canvas.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 51,
    }));
    send('pointerdown', cx, cy);
    send('pointermove', cx + box.w * S + PAD * 2, cy + box.h * S + PAD * 2);
    send('pointerup', cx + box.w * S + PAD * 2, cy + box.h * S + PAD * 2);
  }, { place: SMALL_LOGO_PLACEMENTS, box: WORDMARK_BOX });

  await page.waitForFunction(() => window.Blinded.state.templates.length === 1, { timeout: 60000 });
  await redact(page);

  const small = await page.evaluate(() => {
    const hits = window.Blinded.state.pages[0].imageHits;
    return {
      found: hits.length,
      worst: hits.length ? Math.min(...hits.map(m => m.score)) : 0,
      positions: hits.map(m => [Math.round(m.x), Math.round(m.y)]).sort((a, b) => a[1] - b[1] || a[0] - b[0]),
    };
  });
  check('a small logo is found everywhere it appears at the same size',
    small.found === 3, small.found + ' found at ' + JSON.stringify(small.positions));
  // A copy identical to the pick, at the same size, correlates with it
  // exactly. Anything materially under 1.0 means the score is measuring
  // resampling rather than similarity.
  check('and an identical copy scores essentially perfectly',
    small.worst > 0.97, 'worst ' + small.worst.toFixed(3));
  check('the panel reports the count it found',
    (await page.textContent('#templates')).includes('found 3 times'),
    await page.textContent('#templates'));

  // ---------- a wide wordmark ----------
  //
  // The shape that used to break the matcher outright: sized by its long side
  // alone it became a one-pixel-tall strip, and a page covered in copies of it
  // returned nothing found. Picked sloppily here, as anyone would.
  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', wordmarkPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await page.click('#pick');

  await page.evaluate(({ place, aspect }) => {
    const p = window.Blinded.state.pages[0];
    const S = 2, PAD = 10;
    const { x, y, size } = place[0];
    const height = size / aspect;
    const cx = x * S - PAD;
    const cy = (792 - y - height) * S - PAD;
    const cw = size * S + PAD * 2;
    const ch = height * S + PAD * 2;
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.canvas.width;
    const sy = rect.height / p.canvas.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 31,
    }));
    send('pointerdown', cx, cy);
    send('pointermove', cx + cw, cy + ch);
    send('pointerup', cx + cw, cy + ch);
  }, { place: WORDMARK_PLACEMENTS, aspect: WORDMARK_ASPECT });

  await page.waitForFunction(() => window.Blinded.state.templates.length === 1, { timeout: 60000 });
  await redact(page);

  const wordmarks = await page.evaluate(() => ({
    found: window.Blinded.state.pages[0].imageHits.length,
    widths: window.Blinded.state.pages[0].imageHits.map(m => Math.round(m.rect.w)).sort((a, b) => a - b),
    worst: Math.min(...window.Blinded.state.pages[0].imageHits.map(m => m.score)),
  }));
  // Three of the four, and which one is missed is understood rather than
  // mysterious. The fixture's smallest copy is 0.46x of a 13:1 mark, so it
  // renders about thirteen pixels tall and the vertical detail that
  // distinguishes it — blocks at three different heights — has been resampled
  // below a pixel before the matcher ever sees it. No amount of candidate
  // depth recovers structure that is not in the image; this was measured, not
  // assumed. Compact marks do not have this problem: the square-logo document
  // above finds all four copies at 0.99.
  check('a wide wordmark is found at several sizes',
    wordmarks.found >= 3, wordmarks.found + ' found, widths ' + JSON.stringify(wordmarks.widths));
  check('including a copy smaller than the one picked',
    wordmarks.widths[0] < 200 * 2 * 0.9, JSON.stringify(wordmarks.widths));
  check('and a copy well over one and a half times it',
    Math.max(...wordmarks.widths) > 200 * 2 * 1.5, JSON.stringify(wordmarks.widths));
  check('and none of what it does find is a marginal score',
    wordmarks.worst > 0.8, 'worst ' + wordmarks.worst.toFixed(3));

  // ---------- undo ----------
  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', fixturePath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

  check('undo starts disabled with nothing to undo',
    await page.isDisabled('#undo'));

  const drawBox = (id, x0, y0, x1, y1) => page.evaluate(({ id, x0, y0, x1, y1 }) => {
    const p = window.Blinded.state.pages[0];
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.canvas.width;
    const sy = rect.height / p.canvas.height;
    const send = (type, cx, cy) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + cx * sx, clientY: rect.top + cy * sy, bubbles: true, pointerId: id,
    }));
    send('pointerdown', x0, y0);
    send('pointermove', x1, y1);
    send('pointerup', x1, y1);
    return p.manual.length;
  }, { id, x0, y0, x1, y1 });

  check('drawing a box records it', await drawBox(21, 100, 900, 400, 980) === 1);
  check('undo becomes available once there is something to undo',
    !(await page.isDisabled('#undo')));
  check('the button names what it will undo',
    (await page.getAttribute('#undo', 'title')).includes('box you drew'),
    await page.getAttribute('#undo', 'title'));

  check('a second box stacks', await drawBox(22, 100, 1000, 400, 1080) === 2);
  await page.click('#undo');
  check('undo removes the most recent box only',
    await page.evaluate(() => window.Blinded.state.pages[0].manual.length) === 1);
  await page.click('#undo');
  check('undo again removes the first box',
    await page.evaluate(() => window.Blinded.state.pages[0].manual.length) === 0);
  check('undo disables itself when the history runs out',
    await page.isDisabled('#undo'));

  // Dismissing a detection is a reviewer decision too, so it must be undoable.
  await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => h.finding.kind === 'email');
    const r = hit.rects[0];
    const rect = p.canvas.getBoundingClientRect();
    const x = rect.left + (r.x + r.w / 2) * (rect.width / p.canvas.width);
    const y = rect.top + (r.y + r.h / 2) * (rect.height / p.canvas.height);
    for (const t of ['pointerdown', 'pointerup']) {
      p.canvas.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 23 }));
    }
  });
  check('dismissing a detection is recorded',
    await page.evaluate(() => window.Blinded.state.pages[0].dismissed.size) === 1);
  await page.click('#undo');
  check('and undoing it covers the detection again',
    await page.evaluate(() => window.Blinded.state.pages[0].dismissed.size) === 0);

  // Keyboard undo, which is how anyone doing this work for real will reach it.
  await drawBox(24, 120, 900, 420, 980);
  await page.keyboard.press('Control+z');
  check('ctrl+z undoes as well as the button',
    await page.evaluate(() => window.Blinded.state.pages[0].manual.length) === 0);

  // ...but not while typing, where undo belongs to the text box.
  await drawBox(25, 130, 900, 430, 980);
  await page.focus('#terms');
  await page.keyboard.press('Control+z');
  check('ctrl+z in the terms box does not undo a redaction',
    await page.evaluate(() => window.Blinded.state.pages[0].manual.length) === 1);

  // ---------- a plain text document ----------
  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', textPath);
  await page.waitForSelector('#view-review:not([hidden])');
  check('a text file shows the text view', await page.isVisible('#textview'));
  const marks = await page.locator('#textview mark').count();
  check('the text view marks the email and the phone number', marks === 2, String(marks));

  await page.fill('#terms', 'Jane Doe');
  await page.waitForTimeout(400);
  check('a listed term adds a mark in the text view',
    await page.locator('#textview mark').count() === 3,
    String(await page.locator('#textview mark').count()));

  // Clicking a mark keeps that occurrence rather than covering it.
  await page.locator('#textview mark').first().click();
  check('a clicked mark is shown as kept',
    (await page.locator('#textview mark.off').count()) === 1);
  await page.locator('#textview mark.off').first().click();
  check('clicking it again covers it once more',
    (await page.locator('#textview mark.off').count()) === 0);

  await redact(page);
  const [textDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#export'),
  ]);
  const outText2 = join(tmpdir(), 'blinded-out.txt');
  await textDownload.saveAs(outText2);
  const redacted = readFileSync(outText2, 'utf8');
  check('the redacted text file is named correctly',
    textDownload.suggestedFilename().endsWith('-redacted.txt'));
  check('the redacted text no longer holds the email', !redacted.includes('jane.doe@example.com'), redacted);
  check('the redacted text no longer holds the phone number', !redacted.includes('555-0132'), redacted);
  check('the redacted text keeps the harmless line', redacted.includes('nothing sensitive here'), redacted);
  check('the redaction is visible as blocks', redacted.includes('█'), redacted);

  // ---------- an unsupported file is refused ----------
  await page.click('#restart');
  const junk = join(tmpdir(), 'blinded.bin');
  writeFileSync(junk, Buffer.from([0, 1, 2, 3]));
  await page.setInputFiles('#file', junk);
  await page.waitForSelector('#drop-error:not([hidden])', { timeout: 10000 });
  check('an unsupported file is refused with an explanation',
    (await page.textContent('#drop-error')).includes('PDFs'));

  // ---------- a tab that is not the one being looked at ----------
  //
  // A hidden tab gets no animation frames, and pdf.js continues a page render
  // from one, so opening a document and switching tabs used to park the render
  // mid-way until you came back.
  //
  // Simulated exactly rather than by hoping the browser throttles something:
  // the page reports itself hidden, and requestAnimationFrame records the call
  // and never fires the callback — which is what a background tab does.
  const stubFrames = () => {
    Object.defineProperty(document, 'hidden', { get: () => window.__pretendHidden });
    Object.defineProperty(document, 'visibilityState',
      { get: () => (window.__pretendHidden ? 'hidden' : 'visible') });
    window.__rafCalls = 0;
    window.requestAnimationFrame = () => { window.__rafCalls++; return 1; };
    window.cancelAnimationFrame = () => {};
  };

  const hidden = await context.newPage();
  await hidden.addInitScript(() => { window.__pretendHidden = true; });
  await hidden.addInitScript(stubFrames);
  await hidden.goto(base);
  check('the page believes it is hidden',
    await hidden.evaluate(() => document.visibilityState) === 'hidden');

  let renderedWhileHidden = false;
  await hidden.setInputFiles('#file', fixturePath);
  try {
    await hidden.waitForSelector('#view-review:not([hidden])', { timeout: 25000 });
    renderedWhileHidden = true;
  } catch { /* reported below */ }

  check('a document still renders with the tab in the background', renderedWhileHidden);
  check('and it rendered every page',
    renderedWhileHidden && await hidden.evaluate(() => window.Blinded.state.pages.length) === 1);
  check('without ever getting an animation frame',
    await hidden.evaluate(() => window.__rafCalls) === 0,
    'asked for ' + await hidden.evaluate(() => window.__rafCalls) + ' frames');
  await hidden.close();

  // The control. Same dead animation frames, but the page claims to be
  // visible, so the wrapper hands the request to the real thing — which never
  // fires. If this one also rendered, the test above would prove nothing.
  const control = await context.newPage();
  await control.addInitScript(() => { window.__pretendHidden = false; });
  await control.addInitScript(stubFrames);
  await control.goto(base);
  await control.setInputFiles('#file', fixturePath);
  let renderedAnyway = false;
  try {
    await control.waitForSelector('#view-review:not([hidden])', { timeout: 8000 });
    renderedAnyway = true;
  } catch { /* expected */ }
  check('with frames dead and the page claiming to be visible, rendering does stall',
    !renderedAnyway,
    'it rendered anyway, so the simulation does not reproduce the problem');
  check('and it did ask for the frames it never got',
    await control.evaluate(() => window.__rafCalls) > 0,
    String(await control.evaluate(() => window.__rafCalls)));
  await control.close();

  // ---------- two bars, two controls ----------
  //
  // These used to be one slider with a fixed offset beneath it. The offset
  // came from a single document and was wrong on the next one, where a
  // four-letter acronym matched 333 times while the full company name in the
  // same panel matched once. No constant satisfies both documents, so the
  // reviewer gets the control.
  const bars = await page.evaluate(() => {
    const B = window.Blinded;
    const defaults = { word: B.wordSensitivity(), image: B.sensitivity() };
    const set = (id, v) => { const s = document.getElementById(id); s.value = String(v);
      s.dispatchEvent(new Event('input', { bubbles: true })); };
    const out = {};
    set('sens', 75); set('wordsens', 75);
    out.together = { image: B.sensitivity(), word: B.wordSensitivity() };
    set('wordsens', 55);
    out.wordLowered = { image: B.sensitivity(), word: B.wordSensitivity() };
    set('sens', 90);
    out.imageRaised = { image: B.sensitivity(), word: B.wordSensitivity() };
    out.shortBar = B.wordBarFor('KAG');
    out.longBar = B.wordBarFor('proprietary');
    out.phraseBar = B.wordBarFor('proprietary innovation');
    out.wordMin = Number(document.getElementById('wordsens').min) / 100;
    out.wordMax = Number(document.getElementById('wordsens').max) / 100;
    set('sens', 75); set('wordsens', 66);
    out.defaultWord = defaults.word;
    out.defaultImage = defaults.image;
    return out;
  });
  check('the word bar has its own control',
    bars.together.word === 0.75 && bars.together.image === 0.75, JSON.stringify(bars));
  check('and its own default, lower than the image bar',
    bars.defaultWord === 0.66 && bars.defaultImage === 0.75, JSON.stringify(bars));
  // The relief is what lets one setting serve a three-letter acronym and an
  // eleven-letter word, which no single number did.
  check('a long word is held to a lower bar than a short one at the same setting',
    bars.longBar < bars.shortBar, JSON.stringify(bars));
  check('and a phrase is held to the short-word bar, not the long-word one',
    bars.phraseBar === bars.shortBar, JSON.stringify(bars));
  check('lowering the word bar leaves the image bar alone',
    bars.wordLowered.word === 0.55 && bars.wordLowered.image === 0.75, JSON.stringify(bars));
  check('and raising the image bar leaves the word bar alone',
    bars.imageRaised.image === 0.9 && bars.imageRaised.word === 0.55, JSON.stringify(bars));
  // The two documents that forced this apart: one needed 0.60 or below, the
  // other 0.65 or above. The control is useless if it cannot reach both.
  check('the word control reaches low enough for a word set as vector art',
    bars.wordMin <= 0.598, String(bars.wordMin));
  check('and high enough to shake off a short acronym matching everything',
    bars.wordMax >= 0.65, String(bars.wordMax));

  // The control is meaningless if it is never shown, and pointless clutter
  // when the feature it belongs to is off.
  const rowShown = await page.evaluate(() => {
    const row = document.getElementById('wordsensrow');
    const box = document.getElementById('termimages');
    const before = row.hidden;
    if (!box.checked) { box.click(); }
    const withFeature = row.hidden;
    box.click();
    return { before, withFeature, without: row.hidden };
  });
  check('the word control appears with the feature it belongs to',
    rowShown.withFeature === false, JSON.stringify(rowShown));
  check('and is out of the way when that feature is off',
    rowShown.without === true, JSON.stringify(rowShown));

  // ---------- small lettering ----------
  //
  // A word set as a picture in body text or a caption is only a dozen pixels
  // tall, and the template has to shrink to meet it. At that size letterforms
  // smear: on a real slide a caption reading "KAG" scored 0.314, in the wrong
  // place, while the same word in the title scored 0.725. Searching a
  // resampled copy of the page recovers it without re-rendering anything.
  //
  // Drawn here at a real small size rather than with a synthetic motif: a
  // blocky test pattern survives downsampling perfectly well and would make
  // this pass whether the code worked or not.
  const tiny = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 420; c.height = 120;
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#222222';
    // Roughly the size the caption was on the slide.
    ctx.font = '600 13px Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Singapore, within KAG\u2019s HQ', 20, 52);
    // Some other text, so the page is not one word on a blank field.
    ctx.font = '13px Helvetica, Arial, sans-serif';
    ctx.fillText('Innovation and design under one roof', 20, 20);
    ctx.fillText('10+ specialists, supported by 20 more', 20, 84);

    const gray = BlindedImageSearch.grayOf(c);
    const M = BlindedMatch, S = BlindedImageSearch;
    const run = smallText => {
      const pooled = [];
      for (const t of BlindedTextImage.templatesFor('KAG')) {
        const ready = S.prepareTemplate(t, {});
        if (!ready) continue;
        const r = S.searchPage(gray, c.width, c.height, { ...ready, smallText },
          { threshold: 0.70 });
        for (const h of r.matches) pooled.push(h);
      }
      return M.suppress(pooled, 0.3).sort((a, b) => b.score - a.score);
    };
    const off = run(false), on = run(true);
    const ink = ctx.measureText('Singapore, within ');
    return {
      off: off.length,
      on: on.length,
      best: on.length ? +on[0].score.toFixed(3) : 0,
      hit: on.length ? { x: Math.round(on[0].x), y: Math.round(on[0].y),
                         w: Math.round(on[0].w), h: Math.round(on[0].h) } : null,
      pageW: c.width, pageH: c.height,
      expectX: Math.round(20 + ink.width),
    };
  });
  check('small lettering is missed at the page\'s own resolution',
    tiny.off === 0, JSON.stringify(tiny));
  check('and found once the page is resampled for it',
    tiny.on > 0, JSON.stringify(tiny));
  // The pass runs on a larger copy, so every coordinate has to come back
  // scaled down again. Getting that wrong would draw the bar in the wrong
  // place — worse than not finding the word at all, because it looks covered.
  check('the hit is reported in page coordinates, not the resampled ones',
    tiny.hit && tiny.hit.x + tiny.hit.w <= tiny.pageW
      && tiny.hit.y + tiny.hit.h <= tiny.pageH, JSON.stringify(tiny));
  check('and it lands on the word, not somewhere else on the page',
    tiny.hit && Math.abs(tiny.hit.x - tiny.expectX) <= 14
      && Math.abs(tiny.hit.y - 52) <= 10, JSON.stringify(tiny));

  // ---------- slanted lettering ----------
  //
  // Bold was always covered by a bold face. Italic was not, and a slanted word
  // is a different shape rather than the same shape drawn differently: on a
  // real slide an italic "KAG\u2019s" in a caption scored 0.386 against the
  // upright faces, indistinguishable from the page around it.
  const slanted = await page.evaluate(() => {
    const M = BlindedMatch, S = BlindedImageSearch, TI = BlindedTextImage;
    const draw = style => {
      const c = document.createElement('canvas');
      c.width = 460; c.height = 90;
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#1a1a1a';
      ctx.font = style + ' 15px Helvetica, Arial, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('supported by KAG\u2019s proprietary innovation', 16, 36);
      ctx.font = '15px Helvetica, Arial, sans-serif';
      ctx.fillText('Resolves complex technical issues on-site', 16, 10);
      return c;
    };
    const hunt = canvas => {
      const gray = S.grayOf(canvas);
      const pooled = [];
      for (const t of TI.templatesFor('KAG')) {
        const ready = S.prepareTemplate(t, {});
        if (!ready) continue;
        const r = S.searchPage(gray, canvas.width, canvas.height,
          { ...ready, smallText: true }, { threshold: 0.60 });
        for (const h of r.matches) pooled.push({ ...h, face: t.face });
      }
      const best = M.suppress(pooled, 0.3).sort((a, b) => b.score - a.score)[0];
      return best ? { s: +best.score.toFixed(3), face: best.face, x: Math.round(best.x) } : null;
    };
    return {
      faces: TI.FACES.map(f => f.name),
      upright: hunt(draw('')),
      italic: hunt(draw('italic')),
      bold: hunt(draw('bold')),
      boldItalic: hunt(draw('bold italic')),
    };
  });
  check('there is a slanted face for each upright one',
    slanted.faces.filter(n => n.includes('italic')).length === 4,
    JSON.stringify(slanted.faces));
  check('an upright word is still found', slanted.upright !== null, JSON.stringify(slanted));
  check('a bold word is found', slanted.bold !== null, JSON.stringify(slanted));
  check('an italic word is found', slanted.italic !== null, JSON.stringify(slanted));
  check('a bold italic word is found', slanted.boldItalic !== null, JSON.stringify(slanted));
  // The point of the new faces: a slanted word has to be matched by a slanted
  // template, or it is only ever found by accident.
  check('and the italic word is matched by an italic face',
    slanted.italic && slanted.italic.face.includes('italic'), JSON.stringify(slanted.italic));
  check('while the upright word is still matched by an upright one',
    slanted.upright && !slanted.upright.face.includes('italic'), JSON.stringify(slanted.upright));

  // ---------- the over-matching warning ----------
  //
  // The failure this catches is silent: a short word matching the page rather
  // than the word, hundreds of times, in a document too long to eyeball. The
  // reviewer found out by looking at the exported file.
  const glut = await page.evaluate(() => {
    const B = window.Blinded;
    const savedPages = B.state.pages;
    const savedTerms = B.state.terms;
    const read = () => document.getElementById('termcounts').textContent;

    // By this point in the suite the document has been closed, so the fixture
    // brings its own page. renderTermCounts only reads imageHits off a page.
    B.state.pages = [{ index: 0, imageHits: [] }];
    B.state.terms = ['TDTC'];

    const seed = n => {
      B.state.pages[0].imageHits = Array.from({ length: n }, (_, k) => ({
        id: 'term:TDTC:0:' + k, term: 'TDTC',
        rect: { x: k * 3, y: k * 3, w: 20, h: 10 }, score: 0.6,
      }));
      B.renderTermCounts();
      return read();
    };

    const few = seed(2);
    const many = seed(40);
    const seeded = B.state.pages[0].imageHits.length;
    B.state.pages = savedPages;
    B.state.terms = savedTerms;
    B.renderTermCounts();
    return { few, many, seeded };
  });
  check('the warning fixture renders a row at all',
    /TDTC/.test(glut.few) && /TDTC/.test(glut.many),
    'seeded=' + glut.seeded + ' ' + JSON.stringify(glut.many));
  check('a handful of picture matches is reported without alarm',
    !/lot of picture matches/.test(glut.few), glut.few.slice(0, 120));
  check('but a word matching the page rather than the word is called out',
    /lot of picture matches/.test(glut.many), glut.many.slice(0, 200));
  check('and the warning says which control to move',
    /Word match/.test(glut.many), glut.many.slice(0, 200));

  // ---------- the "?" hints ----------
  //
  // These used to be title attributes, which wait a second or two, never
  // appear on a touch screen, and cannot be reached from the keyboard — so
  // they read as decoration that does nothing. What matters is that the text
  // actually becomes visible, so that is what is asserted, not that a handler
  // is attached.
  const whyCount = await page.evaluate(() => document.querySelectorAll('.why').length);
  check('the panel still has its hints', whyCount === 6, String(whyCount));
  check('every hint carries text to show',
    await page.evaluate(() => [...document.querySelectorAll('.why')]
      .every(b => (b.getAttribute('data-tip') || '').length > 20)));
  check('no hint is left relying on a title tooltip',
    await page.evaluate(() => ![...document.querySelectorAll('.why')].some(b => b.hasAttribute('title'))));
  check('each hint is a real button, so a keyboard can reach it',
    await page.evaluate(() => [...document.querySelectorAll('.why')]
      .every(b => b.tagName === 'BUTTON')));

  const shown = await page.evaluate(async () => {
    const b = document.querySelector('.why');
    b.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    const bubble = document.querySelector('.tipbubble');
    if (!bubble) return { visible: false };
    const r = bubble.getBoundingClientRect();
    return {
      visible: !bubble.hidden && r.width > 0 && r.height > 0,
      text: bubble.textContent,
      matches: bubble.textContent === b.getAttribute('data-tip'),
      onScreen: r.left >= 0 && r.top >= 0
        && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    };
  });
  check('hovering a hint shows it', shown.visible, JSON.stringify(shown));
  check('and it shows that hint, not another', shown.matches, JSON.stringify(shown));
  check('the bubble stays on screen', shown.onScreen, JSON.stringify(shown));

  const afterLeave = await page.evaluate(() => {
    document.querySelector('.why').dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    const bubble = document.querySelector('.tipbubble');
    return bubble ? bubble.hidden : 'no bubble';
  });
  check('moving away hides it again', afterLeave === true);

  // A touch screen has no hover at all, so the tap path is the only one that
  // works there — and it has to close again, or the hint sticks.
  const tapped = await page.evaluate(() => {
    const b = document.querySelectorAll('.why')[1];
    b.click();
    const shownNow = document.querySelector('.tipbubble');
    const open = Boolean(shownNow) && !shownNow.hidden;
    b.click();
    const after = document.querySelector('.tipbubble');
    return { open, closed: Boolean(after) && after.hidden };
  });
  check('tapping a hint opens it, for screens with no hover', tapped.open, JSON.stringify(tapped));
  check('and tapping it again closes it', tapped.closed, JSON.stringify(tapped));

  // The hints sit inside <label>s. A click that reached the label would
  // silently toggle the checkbox the hint is explaining.
  const toggled = await page.evaluate(() => {
    const box = document.getElementById('medium');
    const before = box.checked;
    document.querySelector('#medium').closest('label').querySelector('.why').click();
    return { before, after: box.checked };
  });
  check('asking what a checkbox means does not tick it',
    toggled.before === toggled.after, JSON.stringify(toggled));
  await page.evaluate(() => {
    const bubble = document.querySelector('.tipbubble');
    if (bubble) bubble.hidden = true;
  });

  // ---------- the footer link ----------
  //
  // The claim on the front page is that nothing is uploaded. That claim is
  // only checkable if a reader can reach the source, so the link is part of
  // the argument rather than decoration.
  const foot = await page.evaluate(() => {
    const a = document.querySelector('.foot a[href*="github.com"]');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { href: a.getAttribute('href'), text: a.textContent.trim(),
             visible: r.width > 0 && r.height > 0,
             icon: !!a.querySelector('svg') };
  });
  check('the footer carries a link to the source', foot !== null);
  check('and it points at the public repository',
    foot && foot.href === 'https://github.com/jaredsia-svg/blinded', foot && foot.href);
  check('the link is actually rendered, not just present',
    foot && foot.visible, JSON.stringify(foot));
  check('and it says where it goes', foot && /github/i.test(foot.text), foot && foot.text);
  check('the link carries its mark', foot && foot.icon);

  // ---------- the front page on a laptop ----------
  //
  // The landing page is the whole first impression, and its failure mode is
  // not an exception — it is a page that quietly grows until the feature cards
  // fall off the bottom of a 1366x768 laptop, the commonest screen there is.
  // Nothing else in this suite would notice, so it is measured here.
  for (const [w, h] of [[1366, 768], [1440, 900], [390, 844]]) {
    const shot = await context.newPage();
    await shot.setViewportSize({ width: w, height: h });
    await shot.goto(base);
    const front = await shot.evaluate(() => ({
      inner: window.innerWidth,
      scrollW: document.documentElement.scrollWidth,
      cards: document.querySelectorAll('.features li').length,
      lastBottom: Math.round(
        [...document.querySelectorAll('.features li')].pop().getBoundingClientRect().bottom),
      icons: [...document.querySelectorAll('.features .ico')]
        .map(i => Math.round(i.getBoundingClientRect().width)),
    }));
    // Guard the measurement itself: setViewportSize silently doing nothing
    // would make every assertion below a measurement of the default window.
    check('the front page is measured at ' + w + 'px', front.inner === w, String(front.inner));
    check('the front page has four feature cards at ' + w + 'px',
      front.cards === 4, String(front.cards));
    check('the front page never scrolls sideways at ' + w + 'px',
      front.scrollW <= w, front.scrollW + ' > ' + w);
    check('the feature icons stay small at ' + w + 'px',
      front.icons.every(px => px > 0 && px <= 34), JSON.stringify(front.icons));
    // Only asked of a laptop: a phone is expected to stack and scroll.
    if (w >= 1366) {
      check('every feature card is above the fold at ' + w + 'x' + h,
        front.lastBottom <= h, 'last card ends at ' + front.lastBottom + ', viewport is ' + h);
    }
    await shot.close();
  }

  check('nothing threw in the page', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log('\nBlinded UI test');
if (failures.length) {
  console.error('  ' + failures.length + ' FAILED:');
  for (const f of failures) console.error('    - ' + f);
  console.error('\n  ' + passed + ' checks passed');
  process.exit(1);
}
console.log('  ' + passed + ' checks passed');
