// End-to-end pass in a real browser.
//
// This is the suite that matters, because Blackbar's promise is about the file
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
  buildSmallLogoPdf, SMALL_LOGO_PLACEMENTS, WORDMARK_BOX } from './fixture.mjs';

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

const fixturePath = join(tmpdir(), 'blackbar-fixture.pdf');
writeFileSync(fixturePath, buildTextPdf());
const logoPath = join(tmpdir(), 'blackbar-logo.pdf');
writeFileSync(logoPath, buildLogoPdf());
const smallLogoPath = join(tmpdir(), 'blackbar-smalllogo.pdf');
writeFileSync(smallLogoPath, buildSmallLogoPdf());
const wordmarkPath = join(tmpdir(), 'blackbar-wordmark.pdf');
writeFileSync(wordmarkPath, buildWordmarkPdf());
const textPath = join(tmpdir(), 'blackbar-fixture.txt');
writeFileSync(textPath, 'Jane Doe — jane.doe@example.com — (415) 555-0132\nnothing sensitive here\n');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

// Marking up and redacting are two steps now, so every test that wants to see
// or export a finished redaction has to press the button in between. Waiting
// on state.applied rather than on a timeout keeps this honest about the
// searches actually having run.
async function redact(page) {
  await page.click('#apply');
  await page.waitForFunction(() => window.Blackbar.state.applied === true, { timeout: 240000 });
  await page.waitForFunction(() => document.getElementById('busy').hidden, { timeout: 240000 });
}

const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  // ---------- load ----------
  await page.goto(base);
  check('the drop view is the first thing shown', await page.isVisible('#view-drop'));
  check('the privacy claim is on screen',
    (await page.textContent('#claim')).includes('never uploaded'));

  await page.setInputFiles('#file', fixturePath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  check('the review view opens after a PDF is chosen', await page.isVisible('#view-review'));
  check('the document name is shown', (await page.textContent('#doc-name')).endsWith('.pdf'));

  const rendered = await page.evaluate(() => {
    const p = window.Blackbar.state.pages;
    return { pages: p.length, w: p[0].source.width, h: p[0].source.height, items: p[0].items.length };
  });
  check('the PDF rendered to one page', rendered.pages === 1);
  check('the page was rasterised at 2x', rendered.w === 1224 && rendered.h === 1584,
    rendered.w + 'x' + rendered.h);
  check('text runs were extracted with positions', rendered.items >= 6, String(rendered.items));

  // ---------- detection ----------
  const kinds = await page.evaluate(() =>
    window.Blackbar.state.pages[0].findings.map(f => f.kind));
  for (const kind of ['email', 'phone', 'card', 'ssn']) {
    check('the page view detected a ' + kind, kinds.includes(kind), kinds.join(','));
  }

  const boxCount = await page.evaluate(() =>
    window.Blackbar.state.pages[0].hits.filter(h => h.rects.length).length);
  check('every detection produced at least one box', boxCount === kinds.length,
    boxCount + ' of ' + kinds.length);

  // ---------- marked in red, then covered in black ----------
  //
  // Nothing is covered until Redact is pressed. Before it, a mark is outlined
  // so the reviewer can still read what is about to disappear — which is the
  // whole point of reviewing, and impossible once it is filled in.
  const sample = () => page.evaluate(() => {
    const p = window.Blackbar.state.pages[0];
    const hit = p.hits.find(h => h.finding.kind === 'email');
    const r = hit.rects[0];
    const ctx = p.canvas.getContext('2d');
    const mid = ctx.getImageData(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2), 1, 1).data;
    const edge = ctx.getImageData(Math.round(r.x), Math.round(r.y + r.h / 2), 1, 1).data;
    return { mid: [mid[0], mid[1], mid[2]], edge: [edge[0], edge[1], edge[2]], applied: window.Blackbar.state.applied };
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
    await page.evaluate(() => window.Blackbar.state.applied) === false);
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
    const p = window.Blackbar.state.pages[0];
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
    window.Blackbar.state.pages[0].findings.filter(f => f.kind === 'term').length);
  check('a listed name is found in the page text', termHits >= 1, String(termHits));

  // ---------- clicking a box turns it off, and back on ----------
  const before = await page.evaluate(() => window.Blackbar.state.pages[0].dismissed.size);
  const clicked = await page.evaluate(() => {
    // Click the middle of a detection through the same coordinate path a real
    // pointer would take, so the scaling maths is under test too.
    const p = window.Blackbar.state.pages[0];
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
    const p = window.Blackbar.state.pages[0];
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
    const p = window.Blackbar.state.pages[0];
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

  const out = join(tmpdir(), 'blackbar-out.pdf');
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
  check('the export declares Blackbar as its producer', meta.info.Producer === 'Blackbar');

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
    await page.evaluate(() => window.Blackbar.state.pages.length) === 2);

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
    const p = window.Blackbar.state.pages[0];
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

  await page.waitForFunction(() => window.Blackbar.state.templates.length === 1, { timeout: 60000 });
  check('picking a logo does not search on its own',
    await page.evaluate(() => window.Blackbar.state.templates[0].searched) === false);
  check('and the panel says so',
    (await page.textContent('#templates')).includes('not searched yet'),
    await page.textContent('#templates'));
  await redact(page);

  const matched = await page.evaluate(() => ({
    templates: window.Blackbar.state.templates.length,
    perPage: window.Blackbar.state.pages.map(p => p.imageHits.length),
    total: window.Blackbar.state.pages.reduce((n, p) => n + p.imageHits.length, 0),
    scales: window.Blackbar.state.pages.flatMap(p => p.imageHits.map(m => Math.round(m.rect.w))),
  }));
  check('picking a logo leaves pick mode', await page.evaluate(() => window.Blackbar.state.mode) === 'box');
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
    const p = window.Blackbar.state.pages[1];
    const m = p.imageHits[0];
    const d = p.canvas.getContext('2d').getImageData(
      Math.round(m.rect.x + m.rect.w / 2), Math.round(m.rect.y + m.rect.h / 2), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  check('a matched logo is painted solid black on the page',
    logoPainted.every(v => v === 0), JSON.stringify(logoPainted));

  // A matched logo is a proposal like any other: clickable off and on.
  const afterClick = await page.evaluate(() => {
    const p = window.Blackbar.state.pages[0];
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
    const p = window.Blackbar.state.pages[0];
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
    await page.evaluate(() => window.Blackbar.state.pages
      .reduce((n, p) => n + p.imageHits.filter(m => m.templateId === 'tpl2').length, 0)) === 0);

  // Clear that one away so the counts below describe the real logo only.
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#templates li button');
    rows[rows.length - 1].click();
  });

  // Removing the template withdraws its matches entirely.
  await page.click('#templates button');
  check('removing the picked logo removes its matches',
    await page.evaluate(() => window.Blackbar.state.pages.reduce((n, p) => n + p.imageHits.length, 0)) === 0);

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
  await page.check('#labelling');
  check('turning labelling on reveals the legend', await page.isVisible('#legendbox'));
  check('and its options', await page.isVisible('#labelopts'));

  const legendRows = await page.evaluate(() =>
    window.Blackbar.state.labels.entries.map(e => [e.label, e.count]));
  check('the legend suggests a placeholder for every distinct thing',
    legendRows.length >= 5, JSON.stringify(legendRows));
  check('the typed name is suggested as a person',
    legendRows.some(([label]) => label === 'P1'), JSON.stringify(legendRows));
  check('the detectors get their own kinds',
    ['E1', 'PH1', 'C1', 'S1'].every(want =>
      legendRows.some(([label]) => label === want)), JSON.stringify(legendRows));
  check('every suggested placeholder is short enough for a narrow bar',
    legendRows.every(([label]) => label.length <= 4), JSON.stringify(legendRows));

  // A label is painted into the bar, in white on the black.
  const labelPainted = await page.evaluate(() => {
    const p = window.Blackbar.state.pages[0];
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
    window.Blackbar.state.labels.entries[0].label);
  check('an edited placeholder is normalised to a machine-readable form',
    renamed === 'CLAIMANT', renamed);

  await redact(page);
  const [labelled] = await Promise.all([
    page.waitForEvent('download', { timeout: 90000 }),
    page.click('#export'),
  ]);
  const labelledOut = join(tmpdir(), 'blackbar-labelled.pdf');
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
  const keyOut = join(tmpdir(), 'blackbar-key.json');
  await keyFile.saveAs(keyOut);
  const key = JSON.parse(readFileSync(keyOut, 'utf8'));
  check('the key warns what it is', /reconstructs everything/.test(key.warning), key.warning);
  check('the key maps a placeholder back to its original',
    key.entries.some(e => e.label === 'CLAIMANT' && e.original === 'Jane Doe'),
    JSON.stringify(key.entries.slice(0, 3)));
  check('the key covers the detected values too',
    key.entries.some(e => e.original === 'jane.doe@example.com'));

  await page.uncheck('#labelling');
  check('turning labelling off hides the legend again', await page.isHidden('#legendbox'));

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
    const img = await window.BlackbarRender.encodeForPdf(c, false);
    return Array.from(window.BlackbarPdfWrite.build([{ widthPt: 612, heightPt: 792, image: img }]));
  });
  const scanPath = join(tmpdir(), 'blackbar-scan.pdf');
  writeFileSync(scanPath, Buffer.from(scanBytes));

  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', scanPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

  check('the fixture really has no text layer at all',
    (await page.evaluate(() => window.Blackbar.state.pages[0].text.trim())) === '',
    await page.evaluate(() => window.Blackbar.state.pages[0].text.slice(0, 60)));

  await page.fill('#terms', 'KAG');
  await page.waitForTimeout(400);
  check('and so a typed word finds nothing in it by text',
    await page.evaluate(() => window.Blackbar.state.pages[0].hits.length) === 0);
  check('which the term list reports rather than leaving blank',
    (await page.textContent('#termcounts')).includes('not found'),
    await page.textContent('#termcounts'));

  await page.check('#termimages');
  await redact(page);

  const pictured = await page.evaluate(() => {
    const p = window.Blackbar.state.pages[0];
    const mine = p.imageHits.filter(m => m.term === 'KAG');
    return {
      found: mine.length,
      worst: mine.length ? Math.min(...mine.map(m => m.score)) : 0,
      labels: [...new Set(mine.map(m => window.Blackbar.state.labels.byId[m.id]))],
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
    await page.evaluate(() => window.Blackbar.state.pages[0].imageHits.length) === 0);
  check('and returns the document to review',
    await page.evaluate(() => window.Blackbar.state.applied) === false);

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
      built.push({ widthPt: 612, heightPt: 792, image: await window.BlackbarRender.encodeForPdf(c, false) });
    }
    return Array.from(window.BlackbarPdfWrite.build(built));
  });
  const deckPath = join(tmpdir(), 'blackbar-deck.pdf');
  writeFileSync(deckPath, Buffer.from(deckBytes));

  await page.click('#restart');
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', deckPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

  const parallel = await page.evaluate(async () => {
    const IS = window.BlackbarImageSearch;
    const TI = window.BlackbarTextImage;
    const pages = window.Blackbar.state.pages;
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
    const img = await window.BlackbarRender.encodeForPdf(c, false);
    return Array.from(window.BlackbarPdfWrite.build([{ widthPt: 612, heightPt: 792, image: img }]));
  }, COMBOS);
  const colourPath = join(tmpdir(), 'blackbar-colours.pdf');
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
    const p = window.Blackbar.state.pages[0];
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
    const p = window.Blackbar.state.pages[0];
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

  await page.waitForFunction(() => window.Blackbar.state.templates.length === 1, { timeout: 60000 });
  await redact(page);

  const small = await page.evaluate(() => {
    const hits = window.Blackbar.state.pages[0].imageHits;
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
    const p = window.Blackbar.state.pages[0];
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

  await page.waitForFunction(() => window.Blackbar.state.templates.length === 1, { timeout: 60000 });
  await redact(page);

  const wordmarks = await page.evaluate(() => ({
    found: window.Blackbar.state.pages[0].imageHits.length,
    widths: window.Blackbar.state.pages[0].imageHits.map(m => Math.round(m.rect.w)).sort((a, b) => a - b),
    worst: Math.min(...window.Blackbar.state.pages[0].imageHits.map(m => m.score)),
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
    const p = window.Blackbar.state.pages[0];
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
    await page.evaluate(() => window.Blackbar.state.pages[0].manual.length) === 1);
  await page.click('#undo');
  check('undo again removes the first box',
    await page.evaluate(() => window.Blackbar.state.pages[0].manual.length) === 0);
  check('undo disables itself when the history runs out',
    await page.isDisabled('#undo'));

  // Dismissing a detection is a reviewer decision too, so it must be undoable.
  await page.evaluate(() => {
    const p = window.Blackbar.state.pages[0];
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
    await page.evaluate(() => window.Blackbar.state.pages[0].dismissed.size) === 1);
  await page.click('#undo');
  check('and undoing it covers the detection again',
    await page.evaluate(() => window.Blackbar.state.pages[0].dismissed.size) === 0);

  // Keyboard undo, which is how anyone doing this work for real will reach it.
  await drawBox(24, 120, 900, 420, 980);
  await page.keyboard.press('Control+z');
  check('ctrl+z undoes as well as the button',
    await page.evaluate(() => window.Blackbar.state.pages[0].manual.length) === 0);

  // ...but not while typing, where undo belongs to the text box.
  await drawBox(25, 130, 900, 430, 980);
  await page.focus('#terms');
  await page.keyboard.press('Control+z');
  check('ctrl+z in the terms box does not undo a redaction',
    await page.evaluate(() => window.Blackbar.state.pages[0].manual.length) === 1);

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
  const outText2 = join(tmpdir(), 'blackbar-out.txt');
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
  const junk = join(tmpdir(), 'blackbar.bin');
  writeFileSync(junk, Buffer.from([0, 1, 2, 3]));
  await page.setInputFiles('#file', junk);
  await page.waitForSelector('#drop-error:not([hidden])', { timeout: 10000 });
  check('an unsupported file is refused with an explanation',
    (await page.textContent('#drop-error')).includes('PDFs'));

  check('nothing threw in the page', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log('\nBlackbar UI test');
if (failures.length) {
  console.error('  ' + failures.length + ' FAILED:');
  for (const f of failures) console.error('    - ' + f);
  console.error('\n  ' + passed + ' checks passed');
  process.exit(1);
}
console.log('  ' + passed + ' checks passed');
