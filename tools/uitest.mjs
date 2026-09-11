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
import { isStale } from './stamp.mjs';
import { buildTextPdf, buildReadablePdf, buildLogoPdf, LOGO_PLACEMENTS,
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
const readablePath = join(tmpdir(), 'blinded-readable.pdf');
writeFileSync(readablePath, buildReadablePdf());
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

// Words are added one at a time now, through the box and the Enter key, so
// the tests put them in the same way a reviewer would rather than writing the
// list into the state.
async function setTerms(page, words) {
  await page.evaluate(() => {
    const B = window.Blinded;
    for (const word of B.state.terms.slice()) B.dropTerm(word);
  });
  for (const word of words) {
    if (!word) continue;
    await page.fill('#termbox', word);
    await page.press('#termbox', 'Enter');
  }
  await page.waitForTimeout(120);
}

// Two presses now, not one: the first searches and proposes, the second
// covers. Tests that want a redacted document want both.
async function redact(page) {
  await page.click('#apply');
  await page.waitForFunction(() => window.Blinded.state.searched === true,
    undefined, { timeout: 240000 });
  await page.waitForFunction(() => document.getElementById('busy').hidden,
    undefined, { timeout: 240000 });
  // Only if there is something to cover: with nothing found the button is
  // rightly dead, and a test that only wanted the search is finished.
  const canCover = await page.evaluate(() => !window.Blinded.state.applied
    && !document.getElementById('apply').disabled);
  if (canCover) {
    await page.click('#apply');
    await page.waitForFunction(() => window.Blinded.state.applied === true,
      undefined, { timeout: 60000 });
  }
  await page.waitForFunction(() => document.getElementById('busy').hidden,
    undefined, { timeout: 240000 });
}

const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  // Opening another file now asks before it throws the current one away, so
  // every reset in these tests goes through that step rather than around it.
  const newFile = async () => {
    await page.click('#restart');
    if (await page.isVisible('#confirmbox')) await page.click('#confirmyes');
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
  };

  // Exporting now asks what to call the file first, so every export in these
  // tests goes through that step rather than around it.
  const exportFile = async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      (async () => {
        await page.click('#export');
        await page.waitForSelector('#namebox:not([hidden])', { timeout: 15000 });
        await page.click('#namesave');
      })(),
    ]);
    return download;
  };

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

  // ---------- adding a word ----------
  //
  // The list used to be a textarea read on every keystroke, so a name being
  // typed was searched for at every prefix. A word joins the list when the
  // reviewer says so.
  {
    await newFile();
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const listed = () => page.evaluate(() => ({
      words: [...document.querySelectorAll('#termcounts .t')].map(n => n.textContent.trim()),
      state: window.Blinded.state.terms.slice(),
      tallies: [...document.querySelectorAll('#termcounts .n')].filter(n => !n.hidden).length,
      addDisabled: document.getElementById('termgo').disabled,
      box: document.getElementById('termbox').value,
    }));

    await page.fill('#termbox', 'Jane');
    const typing = await listed();
    check('typing a word does not add it to the list',
      typing.words.length === 0 && typing.state.length === 0, JSON.stringify(typing));
    check('and the add button wakes up once there is something to add',
      typing.addDisabled === false, JSON.stringify(typing));

    await page.press('#termbox', 'Enter');
    await page.waitForTimeout(200);
    const added = await listed();
    check('pressing enter adds it', added.words.join() === 'Jane', JSON.stringify(added));
    check('and clears the box for the next one', added.box === '', JSON.stringify(added));
    check('no tally until something has searched',
      added.tallies === 0, JSON.stringify(added));

    // The arrow beside the box does the same thing.
    await page.fill('#termbox', 'Amphitheatre');
    await page.click('#termgo');
    await page.waitForTimeout(200);
    const two = await listed();
    check('the arrow adds a word too',
      two.words.join() === 'Jane,Amphitheatre', JSON.stringify(two));

    // Adding the same word twice is not an error and not a duplicate.
    await page.fill('#termbox', 'Jane');
    await page.press('#termbox', 'Enter');
    await page.waitForTimeout(200);
    const again = await listed();
    check('adding a word already listed changes nothing',
      again.words.join() === 'Jane,Amphitheatre' && again.box === '',
      JSON.stringify(again));

    await redact(page);
    const searched = await listed();
    check('after searching, every word carries its tally',
      searched.tallies === 2, JSON.stringify(searched));

    // And a word can be taken off again.
    await page.click('#termcounts li.word .termdrop');
    await page.waitForTimeout(300);
    const dropped = await listed();
    check('a word can be removed from the list',
      dropped.words.join() === 'Amphitheatre', JSON.stringify(dropped));
    check('and removing one puts it back to Search',
      (await page.evaluate(() => window.Blinded.state.searched)) === false);
  }

  // ---------- search, redact, redacted ----------
  //
  // One button, three states. Marks used to appear the instant a word was
  // typed, which put an outline on the page while the reviewer was still
  // typing — showing a half-typed word's matches as if they were an answer.
  {
    const state = () => page.evaluate(() => ({
      label: document.getElementById('apply').textContent.trim(),
      green: document.getElementById('apply').classList.contains('done'),
      searched: window.Blinded.state.searched,
      applied: window.Blinded.state.applied,
      drawn: window.Blinded.state.pages.reduce(
        (n, p) => n + window.Blinded.activeBoxes(p).length, 0),
      exportOff: document.getElementById('export').disabled,
    }));

    await newFile();
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const opened = await state();
    check('a document opens asking to be searched, not redacted',
      opened.label === 'Search', JSON.stringify(opened));

    await setTerms(page, ["Jane"]);
    await page.waitForTimeout(400);
    const typed = await state();
    check('typing a word marks nothing on the page',
      typed.drawn === 0, JSON.stringify(typed));
    check('and the button still says Search',
      typed.label === 'Search' && typed.searched === false, JSON.stringify(typed));

    await page.click('#apply');
    await page.waitForFunction(() => window.Blinded.state.searched === true,
      undefined, { timeout: 240000 });
    await page.waitForFunction(() => document.getElementById('busy').hidden,
      undefined, { timeout: 240000 });
    const found = await state();
    check('searching proposes what it found', found.drawn > 0, JSON.stringify(found));
    check('but covers nothing yet', found.applied === false, JSON.stringify(found));
    check('and the button now offers to redact',
      found.label === 'Redact' && !found.green, JSON.stringify(found));
    check('the export stays shut until it is redacted',
      found.exportOff === true, JSON.stringify(found));

    await page.click('#apply');
    const covered = await state();
    check('redacting covers them', covered.applied === true, JSON.stringify(covered));
    check('and the button says Redacted, in green',
      covered.label === 'Redacted' && covered.green === true, JSON.stringify(covered));
    check('and the export opens', covered.exportOff === false, JSON.stringify(covered));

    // Redacted is a state to step back out of, not a dead end.
    await page.click('#apply');
    const back = await state();
    check('pressing Redacted uncovers them again',
      back.applied === false && back.searched === true, JSON.stringify(back));
    check('the marks are still there, just not covered',
      back.drawn === found.drawn, JSON.stringify({ back, found }));
    check('and the button offers to redact once more',
      back.label === 'Redact' && back.green === false, JSON.stringify(back));
    // Stepping back out must not need the search run again.
    check('stepping back does not undo the search',
      back.searched === true, JSON.stringify(back));

    // Changing what to look for is a different question, so the answer goes.
    await setTerms(page, ["Jane", "Amphitheatre"]);
    await page.waitForTimeout(400);
    const changed = await state();
    check('editing the words puts it back to Search',
      changed.label === 'Search' && changed.searched === false,
      JSON.stringify(changed));
    check('and takes the old marks off the page',
      changed.drawn === 0, JSON.stringify(changed));
  }

  // ---------- marked in red, then covered in black ----------
  //
  // Nothing is covered until Redact is pressed. Before it, a mark is outlined
  // so the reviewer can still read what is about to disappear — which is the
  // whole point of reviewing, and impossible once it is filled in.
  //
  // Searching first, because nothing at all is drawn before that: the marks
  // this checks the colour of do not exist until the reviewer asks for them.
  await page.evaluate(async () => { await window.Blinded.runSearch(); });
  await page.waitForFunction(() => window.Blinded.state.searched === true,
    undefined, { timeout: 240000 });
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
  await setTerms(page, ["Mulan"]);
  await page.waitForTimeout(400);
  check('changing a term returns the document to review',
    await page.evaluate(() => window.Blinded.state.applied) === false);
  check('and disables the export again', await page.isDisabled('#export'));
  await setTerms(page, []);
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
  await setTerms(page, ["Jane Doe"]);
  await page.waitForTimeout(400);
  const termHits = await page.evaluate(() =>
    window.Blinded.state.pages[0].findings.filter(f => f.kind === 'term').length);
  check('a listed name is found in the page text', termHits >= 1, String(termHits));

  // Stale assets are a real failure mode, not a theoretical one: a reviewer
  // whose browser had yesterday's app.css got today's markup styled by
  // yesterday's rules, which drew the screen-reader labels the styling exists
  // to hide and left the selected tool looking unselected. The links carry a
  // hash of what they point at so the URL changes when the file does. This
  // fails if an asset was edited without re-running tools/stamp.mjs.
  check('every asset link is stamped with what it points at',
    isStale() === false, 'run: node tools/stamp.mjs');

  // ---------- what dragging does ----------
  //
  // Asserted here, before any test has chosen a tool, because what is being
  // tested is the state a reviewer arrives in: one who never touches the
  // toolbar cannot leave a mark on a confidential document by accident.
  const startsPanning = await page.evaluate(() => ({
    tool: window.Blinded.state.tool,
    pan: document.getElementById('tool-pan').getAttribute('aria-pressed'),
    mark: document.getElementById('tool-mark').getAttribute('aria-pressed'),
  }));
  check('dragging moves the pages until the reviewer chooses otherwise',
    startsPanning.tool === 'pan', JSON.stringify(startsPanning));
  check('and the toolbar says which tool is holding',
    startsPanning.pan === 'true' && startsPanning.mark === 'false',
    JSON.stringify(startsPanning));

  // Four icons in a 320px panel. Words did not fit: the row overflowed and the
  // last controls could only be reached by scrolling sideways, which is how
  // this was reported. Sizes are asserted rather than eyeballed.
  const bar = await page.evaluate(() => {
    const tools = document.querySelector('.tools').getBoundingClientRect();
    const panel = document.querySelector('.panel').getBoundingClientRect();
    const ids = ['tool-pan', 'tool-mark', 'zoom-out', 'zoom-in', 'undo',
                 'savedraft', 'restart'];
    const buttons = ids.map(id => document.getElementById(id));
    return {
      count: document.querySelectorAll('.tools .tool').length,
      fits: tools.right <= panel.right + 0.5 && tools.left >= panel.left - 0.5,
      pageOverflow: document.documentElement.scrollWidth
        - document.documentElement.clientWidth,
      panelOverflow: document.querySelector('.panel').scrollWidth
        - document.querySelector('.panel').clientWidth,
      // Every one explains itself to a pointer, since nothing is written on it.
      titles: buttons.map(b => (b.getAttribute('title') || '').length),
      // And to a screen reader, without that text being drawn.
      labels: buttons.map(b => (b.querySelector('.sr-only')?.textContent || '').trim()),
      // Both halves matter. A 1px box still paints its text all over the
      // button unless the overflow is actually clipped — removing the clip
      // and leaving the size was the exact shape of the reported bug, and it
      // passed a test that only measured the box.
      labelWidths: buttons.map(b => {
        const span = b.querySelector('.sr-only');
        return span ? Math.round(span.getBoundingClientRect().width) : -1;
      }),
      labelClipped: buttons.map(b => {
        const span = b.querySelector('.sr-only');
        if (!span) return false;
        const style = getComputedStyle(span);
        return style.overflow === 'hidden'
          && span.scrollWidth > span.clientWidth;
      }),
      widths: buttons.map(b => Math.round(b.getBoundingClientRect().width)),
      heights: buttons.map(b => Math.round(b.getBoundingClientRect().height)),
    };
  });
  check('the toolbar is seven buttons', bar.count === 7, JSON.stringify(bar.count));

  // The header is pinned, and the sentence explaining what dragging does sits
  // with the buttons that change it rather than at the foot of the panel.
  const chrome = await page.evaluate(async () => {
    const top = document.querySelector('.top');
    const resting = top.getBoundingClientRect();
    // The document column is what scrolls now, not the window. That is the
    // point of the layout: the header and the export bar stay put, and each
    // column moves on its own.
    const stage = document.querySelector('.stage');
    stage.scrollTop = 500;
    await new Promise(r => requestAnimationFrame(r));
    const scrolledTo = stage.scrollTop;
    const windowMoved = window.scrollY;
    const barBefore = document.querySelector('.exportbar').getBoundingClientRect().top;
    const moved = top.getBoundingClientRect();
    const panel = document.querySelector('.panel').getBoundingClientRect();
    // Read from the computed style, not from a rect measured mid-scroll: the
    // body's own box has moved by then, which says nothing about the room
    // reserved at the top of it.
    const pad = parseFloat(getComputedStyle(document.body).paddingTop);
    // The offset it sticks at, not where it happens to be: on a document
    // short enough that the column runs out, sticky legitimately lets the
    // panel ride up with its parent, and where it lands then says nothing
    // about whether it would sit under the header.
    const panelStick = parseFloat(getComputedStyle(
      document.querySelector('.panel')).top);
    const panelTop = panel.top;
    const headerBottom = moved.bottom;
    stage.scrollTop = 0;
    return {
      height: Math.round(resting.height),
      atTopBefore: Math.round(resting.top),
      atTopAfter: Math.round(moved.top),
      // Proof the page really scrolled, so "it did not move" means something.
      scrolledTo,
      pad, panelTop: Math.round(panelTop), panelStick,
      headerBottom: Math.round(headerBottom),
      windowMoved,
      barStaysPut: Math.round(barBefore)
        === Math.round(document.querySelector('.exportbar').getBoundingClientRect().top),
      pageScrolls: document.documentElement.scrollHeight
        > document.documentElement.clientHeight + 1,
      stageScrolls: stage.scrollHeight > stage.clientHeight + 1,
      // Nothing starts underneath it.
      roomReserved: pad >= Math.round(moved.height) - 1,
      panelClear: panelStick >= Math.round(moved.height),
      // The panel used to explain what dragging does, in a sentence that
      // changed with the tool. The tools say that themselves now, on hover
      // and to a screen reader.
      tipShown: !document.getElementById('tip').hidden,
      tipText: (document.getElementById('tip').textContent || '').trim(),
      markTitle: document.getElementById('tool-mark').getAttribute('title') || '',
    };
  });
  check('the header stays at the top when the document is scrolled',
    chrome.atTopBefore === 0 && chrome.atTopAfter === 0 && chrome.scrolledTo >= 400,
    JSON.stringify(chrome));
  // One scroll for the document, one for the panel, and none for the page.
  check('the document column is what scrolls, not the whole page',
    chrome.stageScrolls === true && chrome.pageScrolls === false
      && chrome.windowMoved === 0, JSON.stringify(chrome));
  check('and the export bar does not move with it',
    chrome.barStaysPut === true, JSON.stringify(chrome));
  check('and it is thin, because pinned space is space the document loses',
    chrome.height <= 52, JSON.stringify(chrome));
  check('the page reserves exactly the room the header takes',
    chrome.roomReserved === true, JSON.stringify(chrome));
  check('and the panel beside it sticks below it, not under it',
    chrome.panelClear === true, JSON.stringify(chrome));
  check('the panel no longer explains what dragging does',
    chrome.tipShown === false && chrome.tipText === '', JSON.stringify(chrome));
  // The one case with nothing else to say it: picking a logo is a mode entered
  // from a button elsewhere in the panel, and the page gives no sign of it.
  const picking = await page.evaluate(() => {
    const B = window.Blinded;
    B.setMode('pick');
    const shown = { hidden: document.getElementById('tip').hidden,
                    text: document.getElementById('tip').textContent.trim() };
    B.setMode('box');
    return { ...shown, afterHidden: document.getElementById('tip').hidden };
  });
  check('picking a logo still says what to do',
    picking.hidden === false && /drag a box around the logo/i.test(picking.text),
    JSON.stringify(picking));
  check('and the note goes away again afterwards',
    picking.afterHidden === true, JSON.stringify(picking));

  check('the crosshair says what it is for instead',
    /draw a box to redact/i.test(chrome.markTitle), chrome.markTitle);
  check('and how to take a box off again',
    /click box to undo/i.test(chrome.markTitle), chrome.markTitle);

  check('and they fit inside the panel without scrolling sideways',
    bar.fits && bar.pageOverflow === 0 && bar.panelOverflow === 0, JSON.stringify(bar));
  check('every one is the same size, so the row cannot be stretched by its text',
    new Set(bar.widths).size === 1 && new Set(bar.heights).size === 1,
    JSON.stringify(bar));
  check('none of them draws its words on screen',
    bar.labelWidths.every(w => w >= 0 && w <= 2)
      && bar.labelClipped.every(Boolean), JSON.stringify(bar));
  check('but every one still carries those words for a screen reader',
    bar.labels.every(l => l.length > 3), JSON.stringify(bar.labels));
  check('and a tooltip that says what it does',
    bar.titles.every(n => n > 10), JSON.stringify(bar.titles));

  // Selected has to be darker, not merely different: on a pale panel a pale
  // highlight does not answer "which one is holding" at a glance.
  const shade = await page.evaluate(() => {
    const B = window.Blinded;
    const lum = id => {
      const c = getComputedStyle(document.getElementById(id)).backgroundColor;
      const [r, g, b] = c.match(/[\d.]+/g).map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    B.setTool('pan');
    const colour = id => getComputedStyle(document.getElementById(id)).backgroundColor;
    const blue = colour('tool-pan');
    const probe = document.createElement('div');
    probe.style.background = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim();
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const held = lum('tool-pan');
    const idle = lum('tool-mark');
    B.setTool('mark');
    const swapped = { held: lum('tool-mark'), idle: lum('tool-pan') };
    B.setTool('pan');
    return { held, idle, swapped, blue, accent };
  });
  // Zoom is a property of the view, never of the canvases. A reviewer who
  // leans in to check a bar must be looking at the same bar that gets burned
  // in, so the pixels a redaction is measured against cannot move.
  const zoom = await page.evaluate(() => {
    const B = window.Blinded;
    const p = B.state.pages[0];
    const pixels = { w: p.source.width, h: p.source.height };
    const shown = () => Math.round(p.canvas.getBoundingClientRect().width);
    B.setZoom(1);
    const at100 = shown();
    document.getElementById('zoom-in').click();
    const zoomed = { scale: B.state.zoom, width: shown() };
    document.getElementById('zoom-out').click();
    document.getElementById('zoom-out').click();
    const out = { scale: B.state.zoom, width: shown() };
    // And the limits stop rather than run off the end.
    for (let i = 0; i < 12; i++) document.getElementById('zoom-out').click();
    const floor = { scale: B.state.zoom, disabled: document.getElementById('zoom-out').disabled };
    for (let i = 0; i < 20; i++) document.getElementById('zoom-in').click();
    const ceiling = { scale: B.state.zoom, disabled: document.getElementById('zoom-in').disabled };
    B.setZoom(1);
    return { at100, zoomed, out, floor, ceiling,
      samePixels: p.source.width === pixels.w && p.source.height === pixels.h };
  });
  check('zooming in makes the page bigger on screen',
    zoom.zoomed.scale > 1 && zoom.zoomed.width > zoom.at100, JSON.stringify(zoom));
  check('and zooming out makes it smaller',
    zoom.out.scale < 1 && zoom.out.width < zoom.at100, JSON.stringify(zoom));
  check('but the page it is measured against never changes size',
    zoom.samePixels === true, JSON.stringify(zoom));
  check('zooming stops at both ends rather than running off',
    zoom.floor.disabled === true && zoom.ceiling.disabled === true, JSON.stringify(zoom));

  check('the selected tool stands out against the others',
    shade.held < shade.idle - 60, JSON.stringify(shade));
  check('and it follows the selection',
    shade.swapped.held < shade.swapped.idle - 60, JSON.stringify(shade));
  // Blue, specifically: the same accent the rest of the tool uses for "this
  // is the thing you chose".
  check('the selected tool is the accent blue',
    shade.blue === shade.accent && /^rgb/.test(shade.blue), JSON.stringify(shade));

  // ---------- clicking a box turns it off, and back on ----------
  const before = await page.evaluate(() => window.Blinded.state.pages[0].dismissed.size);
  const clicked = await page.evaluate(() => {
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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

  // ---------- asking before the document is thrown away ----------
  //
  // A reload or a closed tab passes through beforeunload and the browser
  // offers to stop it. Opening another file does not: it discards the
  // document without navigating anywhere, so nothing fires and the browser
  // has nothing to offer. The tool has to ask for itself.
  {
    const pagesOpen = () => page.evaluate(() => window.Blinded.state.pages.length);
    const opened = await pagesOpen();
    check('a document is open to be lost', opened > 0, String(opened));

    await page.click('#restart');
    const asked = await page.isVisible('#confirmbox');
    check('opening another file asks first', asked === true);
    const wording = await page.textContent('#confirmbody');
    check('and says what is at stake', /cannot be undone/i.test(wording || ''), wording);
    check('including that nothing has been exported yet',
      /not exported/i.test(wording || ''), wording);
    // The destructive button must not be the one a stray Enter presses.
    const focused = await page.evaluate(() => document.activeElement
      && document.activeElement.id);
    check('and the cancel button holds the focus, not the destructive one',
      focused === 'confirmno', String(focused));

    await page.click('#confirmno');
    const afterCancel = await pagesOpen();
    check('cancelling keeps the document', afterCancel === opened,
      JSON.stringify({ opened, afterCancel }));
    check('and the review is still on screen',
      (await page.isVisible('#view-review')) === true);

    // Escape is the same answer as Cancel.
    await page.click('#restart');
    await page.waitForSelector('#confirmbox:not([hidden])', { timeout: 15000 });
    await page.keyboard.press('Escape');
    check('escape cancels too', (await pagesOpen()) === opened);

    // And confirming actually does it.
    await page.click('#restart');
    await page.waitForSelector('#confirmbox:not([hidden])', { timeout: 15000 });
    await page.click('#confirmyes');
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    check('confirming closes the document', (await pagesOpen()) === 0);
    check('and the question goes away with it',
      (await page.isVisible('#confirmbox')) === false);

    // With nothing open there is nothing to ask about, and a prompt that
    // always fires is one people learn to click through.
    await page.evaluate(() => document.getElementById('restart').click());
    check('with no document open it does not ask',
      (await page.isVisible('#confirmbox')) === false);

    // Put a document back for the tests that follow.
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  }

  // ---------- naming the file on the way out ----------
  //
  // A document can be redacted perfectly and still name its own secret in an
  // attachment line. The name is offered for editing before anything is
  // saved, with anything covered inside the document taken out of it first.
  const naming = await page.evaluate(() => {
    const B = window.Blinded;
    const was = B.state.terms.slice();
    B.state.terms = ['Falcon', 'KAG'];
    const out = {
      stripped: B.cleanName('Project Falcon - KAG term sheet'),
      leavesTheRest: B.cleanName('Board pack Q3'),
      // Case is not a hiding place.
      anyCase: B.cleanName('project falcon summary'),
      // Nor is a name that is nothing but the secret.
      allOfIt: B.cleanName('Falcon'),
      covered: B.coveredText().includes('Falcon'),
    };
    B.state.terms = was;
    return out;
  });
  check('a covered word is taken out of the file name',
    !/Falcon/i.test(naming.stripped) && !/KAG/.test(naming.stripped),
    JSON.stringify(naming));
  check('and what is left still reads as a name',
    /term sheet/.test(naming.stripped), JSON.stringify(naming.stripped));
  check('a name with nothing covered in it is left alone',
    naming.leavesTheRest === 'Board pack Q3', JSON.stringify(naming.leavesTheRest));
  check('matching the name ignores case',
    !/falcon/i.test(naming.anyCase), JSON.stringify(naming.anyCase));
  check('a name that was only the covered word does not survive as one',
    naming.allOfIt === '', JSON.stringify(naming.allOfIt));
  check('the detectors\' matches count as covered too, not just typed words',
    naming.covered === true, JSON.stringify(naming));

  // The dialog itself: offered, editable, and obeyed.
  await redact(page);
  await page.click('#export');
  await page.waitForSelector('#namebox:not([hidden])', { timeout: 15000 });
  const offeredName = await page.inputValue('#savename');
  check('the export asks what to call the file first',
    typeof offeredName === 'string' && offeredName.endsWith('.pdf'), offeredName);
  await page.click('#namecancel');
  const cancelled = await page.evaluate(() =>
    document.getElementById('namebox').hidden);
  check('and cancelling saves nothing', cancelled === true);

  const [renamedFile] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    (async () => {
      await page.click('#export');
      await page.waitForSelector('#namebox:not([hidden])', { timeout: 15000 });
      await page.fill('#savename', 'board-pack.pdf');
      await page.click('#namesave');
    })(),
  ]);
  check('the name the reviewer types is the name it saves under',
    renamedFile.suggestedFilename() === 'board-pack.pdf',
    renamedFile.suggestedFilename());

  // The lossless choice is about how pages are re-encoded, which is a question
  // about the file being saved rather than about the document.
  const saveBox = await page.evaluate(async () => {
    document.getElementById('export').disabled = false;
    document.getElementById('export').click();
    await new Promise(r => setTimeout(r, 200));
    const box = document.getElementById('namebox');
    const inside = !!box.querySelector('#lossless');
    const paint = getComputedStyle(box.querySelector('.busy-inner')).backgroundColor;
    const white = paint === 'rgb(255, 255, 255)';
    document.getElementById('namecancel').click();
    return { inside, paint, white,
             loose: !!document.querySelector('.exportbar #lossless') };
  });
  check('the lossless option lives in the save box', saveBox.inside === true,
    JSON.stringify(saveBox));
  check('and no longer sits in the bar along the bottom',
    saveBox.loose === false, JSON.stringify(saveBox));
  check('the save box is not white, so it reads as sitting on top of the page',
    saveBox.white === false, JSON.stringify(saveBox));

  // ---------- export ----------
  await redact(page);
  const download = await exportFile();
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
  await newFile();
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
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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

  await page.waitForFunction(() => window.Blinded.state.templates.length === 1, undefined, { timeout: 60000 });
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
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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

  // What dragging does by default.
  //
  // A stray drag used to leave a box on a confidential document, because the
  // only way to scroll was to keep the pointer off the pages. The hand tool is
  // the default, and while it is held nothing on the page changes at all.
  const handed = await page.evaluate(() => {
    const B = window.Blinded;
    B.setTool('pan');
    const p = B.state.pages[0];
    const rect = p.canvas.getBoundingClientRect();
    const at = (px, py) => ({
      clientX: rect.left + px * (rect.width / p.canvas.width),
      clientY: rect.top + py * (rect.height / p.canvas.height),
    });
    const send = (type, px, py, extra) => p.canvas.dispatchEvent(
      new PointerEvent(type, { ...at(px, py), ...extra, bubbles: true, pointerId: 71 }));

    const boxes = p.manual.length;
    const dropped = p.dismissed.size;

    // A long drag across the page: with the marking tool this is a box.
    send('pointerdown', 60, 60);
    send('pointermove', 400, 400);
    send('pointerup', 400, 400);

    // And a click straight onto a live mark, which is how one is dismissed.
    const m = p.imageHits.find(h => !p.dismissed.has(h.id));
    let clicked = null;
    if (m) {
      const cx = m.rect.x + m.rect.w / 2;
      const cy = m.rect.y + m.rect.h / 2;
      send('pointerdown', cx, cy);
      send('pointerup', cx, cy);
      clicked = p.dismissed.has(m.id);
    }
    const out = { boxesBefore: boxes, boxesAfter: p.manual.length,
      droppedBefore: dropped, droppedAfter: p.dismissed.size, clicked,
      pressed: document.getElementById('tool-pan').getAttribute('aria-pressed'),
      cursor: getComputedStyle(p.canvas).cursor };
    B.setTool('mark');
    return out;
  });
  check('dragging with the hand tool draws no box',
    handed.boxesAfter === handed.boxesBefore, JSON.stringify(handed));
  check('and clicking a mark with it does not drop the mark',
    handed.clicked === false && handed.droppedAfter === handed.droppedBefore,
    JSON.stringify(handed));
  check('the hand tool shows a hand',
    handed.cursor === 'grab', JSON.stringify(handed));

  // And that it does the thing it exists to do. Drawing no box is only half of
  // it; a hand tool that marks nothing and moves nothing is just a dead page.
  //
  // Driven with a real mouse rather than dispatched events. The synthetic kind
  // does not exercise pointer capture, which is what holds a drag together
  // when the pointer leaves the canvas, and a hand tool that fails only under
  // a real hand would pass a synthetic test every time.
  await page.evaluate(() => {
    window.Blinded.setTool('pan');
    document.querySelector('.stage').scrollTop = 0;
  });
  const canvasBox = await page.locator('.page canvas').first().boundingBox();
  const beforeDrag = await page.evaluate(() => document.querySelector('.stage').scrollTop);
  const boxesBeforeDrag = await page.evaluate(() =>
    window.Blinded.state.pages.reduce((n, p) => n + p.manual.length, 0));
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 260);
  await page.mouse.down();
  // Upwards on the screen, which walks the document downwards.
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 260 - i * 20);
  }
  await page.mouse.up();
  const moved = await page.evaluate(() => ({
    to: document.querySelector('.stage').scrollTop,
    boxes: window.Blinded.state.pages.reduce((n, p) => n + p.manual.length, 0),
  }));
  await page.evaluate(() => {
    document.querySelector('.stage').scrollTop = 0;
    window.Blinded.setTool('mark');
  });
  check('and dragging with it moves the pages',
    moved.to > beforeDrag, JSON.stringify({ from: beforeDrag, ...moved }));
  check('and a real drag across a page leaves no mark behind',
    moved.boxes === boxesBeforeDrag, JSON.stringify({ boxesBeforeDrag, ...moved }));


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
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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
  await newFile();
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', fixturePath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await setTerms(page, ["Jane Doe"]);
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
  const labelled = await exportFile();
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
  await newFile();
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', doublePath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await setTerms(page, [DOUBLE_TERM]);
  await page.waitForTimeout(400);
  // Reading the pages is the default, but this fixture exists to test the
  // shape matcher — the fallback — so it is asked for explicitly.
  await page.evaluate(() => {
    window.Blinded.state.useOcr = false;
    window.Blinded.showWordControls();
  });
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
  await setTerms(page, []);
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

  await newFile();
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', scanPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

  check('the fixture really has no text layer at all',
    (await page.evaluate(() => window.Blinded.state.pages[0].text.trim())) === '',
    await page.evaluate(() => window.Blinded.state.pages[0].text.slice(0, 60)));

  await setTerms(page, ["KAG"]);
  await page.waitForTimeout(400);
  check('and so a typed word finds nothing in it by text',
    await page.evaluate(() => window.Blinded.state.pages[0].hits.length) === 0);
  check('which the term list reports rather than leaving blank',
    (await page.textContent('#termcounts')).includes('not found'),
    await page.textContent('#termcounts'));

  // Reading the pages is the default, but this fixture exists to test the
  // shape matcher — the fallback — so it is asked for explicitly.
  await page.evaluate(() => {
    window.Blinded.state.useOcr = false;
    window.Blinded.showWordControls();
  });
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

  // One number, not two. The reviewer asked how many times the word is in the
  // document; which of those happen to be pictures is the tool's business.
  const tally = await page.evaluate(() => {
    const B = window.Blinded;
    const term = B.state.terms[0];
    const row = document.querySelector('#termcounts li');
    const inText = B.state.pages.reduce((sum, p) =>
      sum + window.BlindedDetect.findTerms(p.text, [term]).length, 0);
    const asPictures = B.state.pages.reduce((sum, p) =>
      sum + p.imageHits.filter(m => m.term === term && !m.superseded).length, 0);
    return { shown: row ? row.querySelector('.n').textContent.trim() : null,
             inText, asPictures };
  });
  check('the tally is one number, not a sum of two',
    !/\+|picture/.test(tally.shown || ''), JSON.stringify(tally));
  check('and it counts the text and the pictures together',
    tally.asPictures > 0 && tally.shown === String(tally.inText + tally.asPictures),
    JSON.stringify(tally));

  // Pressing the number says where they are.
  //
  // Red for what the reading found and amber for what the shape check turned
  // up — the same two colours they are drawn in on the page, because a mark
  // the reading found and one a matcher guessed at do not deserve equal trust.
  const where = await page.evaluate(async () => {
    const B = window.Blinded;
    const p = B.state.pages[0];
    const term = B.state.terms[0];
    // One mark from the shape check, so both kinds are represented.
    p.imageHits.push({ id: 'sweep:x', term, rect: { x: 80, y: 900, w: 90, h: 24 },
      score: 1, bySweep: true });
    B.renderTermCounts();

    const closed = document.querySelectorAll('#termcounts .tallyspot').length;
    const button = document.querySelector('#termcounts button.n');
    const total = button.textContent.trim();
    button.click();
    const rows = [...document.querySelectorAll('#termcounts .tallyspot')];
    const open = rows.length;
    const shown = rows.map(r => r.textContent.trim());
    const shapes = rows.filter(r => r.classList.contains('shape')).length;
    const colours = rows.map(r =>
      getComputedStyle(r.querySelector('.dot')).backgroundColor);
    const listed = B.occurrencesFor(term).length;
    document.querySelector('#termcounts button.n').click();
    const afterSecond = document.querySelectorAll('#termcounts .tallyspot').length;

    p.imageHits = p.imageHits.filter(m => m.id !== 'sweep:x');
    B.state.openTally = null;
    B.renderTermCounts();
    return { closed, open, shown, shapes, colours, listed, afterSecond, term, total };
  });
  check('the list is not there until the number is pressed',
    where.closed === 0, JSON.stringify(where));
  check('pressing it lists every occurrence',
    where.open === where.listed && where.open === Number(where.total),
    JSON.stringify(where));
  check('each one says which page it is on',
    where.shown.every(t => /^Page \d+/.test(t)), JSON.stringify(where.shown));
  check('the shape check\'s find is marked as such',
    where.shapes === 1, JSON.stringify(where));
  check('and the two kinds are not the same colour',
    new Set(where.colours).size === 2, JSON.stringify(where.colours));
  check('pressing it again puts the list away',
    where.afterSecond === 0, JSON.stringify(where));

  // The rows are a way into the document, not just a readout.
  const jumped = await page.evaluate(async () => {
    const B = window.Blinded;
    const stage = document.querySelector('.stage');
    stage.scrollTop = 0;
    B.goToPage(B.state.pages.length - 1);
    await new Promise(r => setTimeout(r, 500));
    const moved = stage.scrollTop;
    stage.scrollTop = 0;
    return { moved, pages: B.state.pages.length };
  });
  check('and a page named in the list can be jumped to',
    jumped.pages < 2 || jumped.moved > 0, JSON.stringify(jumped));

  // ---------- drafts ----------
  //
  // A draft holds the work, not the document: the words, the marks, the boxes
  // drawn by hand, the logos picked out. Not a page of content — which keeps
  // it a few kilobytes and, the reason that matters, means it carries nothing
  // confidential. A draft with the document inside would be a file that looks
  // like a redaction and is the opposite of one.
  {
    // Started from a known file, so that reopening is the same document and
    // the mismatch guard is exercised deliberately below rather than by
    // accident here.
    await newFile();
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Jane']);

    const planted = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      p.manual = [{ id: 'hand1', x: 40, y: 40, w: 120, h: 30 }];
      p.imageHits = [{ id: 'sweep:d', term: B.state.terms[0],
        rect: { x: 200, y: 300, w: 90, h: 24 }, score: 1, bySweep: true }];
      p.dismissed = new Set(['nope']);
      return { terms: B.state.terms.slice(), manual: p.manual.length };
    });

    const draft = await page.evaluate(() => JSON.stringify(window.Blinded.draftData()));
    const parsed = JSON.parse(draft);
    check('a draft records the words and the marks',
      parsed.terms.includes(planted.terms[0]) && parsed.pages[0].manual.length === 1
        && parsed.pages[0].imageHits.length === 1, draft.slice(0, 160));
    check('and which file it belongs to',
      typeof parsed.source.name === 'string' && parsed.source.name.length > 0,
      JSON.stringify(parsed.source));

    // The part that matters: no page content anywhere in it.
    const pageText = await page.evaluate(() => window.Blinded.state.pages[0].text);
    const sample = (pageText.match(/[A-Za-z]{6,}/g) || []).slice(0, 6);
    check('the fixture gives us words to look for', sample.length > 0, JSON.stringify(sample));
    const leaked = sample.filter(word =>
      !parsed.terms.includes(word) && draft.includes(word));
    check('a draft carries no page content', leaked.length === 0, JSON.stringify(leaked));
    check('and is small enough to be a few kilobytes',
      draft.length < 60000, String(draft.length));

    // Saving it hands over a file, and does not count as having exported the
    // redaction — the warning about unsaved work must not be switched off by
    // a draft.
    const [draftFile] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#savedraft'),
    ]);
    check('saving a draft downloads it',
      /\.blinded\.json$/.test(draftFile.suggestedFilename()),
      draftFile.suggestedFilename());
    check('and saving a draft is not exporting a redaction',
      (await page.evaluate(() => window.Blinded.state.exported)) === false);

    const draftPath = join(tmpdir(), 'blinded-draft.blinded.json');
    await draftFile.saveAs(draftPath);

    // Reopening: the draft is chosen first, and waits for its document.
    await newFile();
    await page.setInputFiles('#file', draftPath);
    await page.waitForTimeout(400);
    check('choosing a draft does not open a document on its own',
      (await page.isVisible('#view-drop')) === true);
    const asks = await page.textContent('#drop-error');
    check('it asks for the file the draft belongs to',
      /choose that file/i.test(asks || ''), asks);

    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await page.waitForTimeout(600);
    const restored = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      return { terms: B.state.terms.slice(),
               manual: p.manual.length,
               sweep: p.imageHits.filter(m => m.bySweep).length,
               listed: [...document.querySelectorAll('#termcounts .t')]
                 .map(n => n.textContent.trim()) };
    });
    check('the words come back', restored.terms.join() === planted.terms.join(),
      JSON.stringify(restored));
    check('and so does the box the reviewer drew', restored.manual === 1,
      JSON.stringify(restored));
    check('and the marks the shape check had found',
      restored.sweep === 1, JSON.stringify(restored));
    check('and the list of words is back in the panel, not just in the state',
      restored.listed.join() === planted.terms.join(), JSON.stringify(restored));

    // Marks are placed by position, so putting a draft on the wrong document
    // would cover the wrong things. The draft knows which file it is for.
    await newFile();
    await page.setInputFiles('#file', draftPath);
    await page.waitForTimeout(300);
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#confirmbox:not([hidden])', { timeout: 30000 });
    const warned = await page.textContent('#confirmbody');
    check('putting a draft on a different file is questioned',
      /is not it/i.test(warned || ''), warned);
    await page.click('#confirmno');
    const declined = await page.evaluate(() => ({
      manual: window.Blinded.state.pages[0].manual.length,
      terms: window.Blinded.state.terms.length,
    }));
    check('and declining leaves that document untouched',
      declined.manual === 0 && declined.terms === 0, JSON.stringify(declined));
  }

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

  await newFile();
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

  await newFile();
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', colourPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await setTerms(page, ["KAG"]);
  await page.waitForTimeout(400);
  // Reading the pages is the default, but this fixture exists to test the
  // shape matcher — the fallback — so it is asked for explicitly.
  await page.evaluate(() => {
    window.Blinded.state.useOcr = false;
    window.Blinded.showWordControls();
  });
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
  await newFile();
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', smallLogoPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await page.click('#pick');

  await page.evaluate(({ place, box }) => {
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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

  await page.waitForFunction(() => window.Blinded.state.templates.length === 1, undefined, { timeout: 60000 });
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
  await newFile();
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', wordmarkPath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  await page.click('#pick');

  await page.evaluate(({ place, aspect }) => {
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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

  await page.waitForFunction(() => window.Blinded.state.templates.length === 1, undefined, { timeout: 60000 });
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
  await newFile();
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', fixturePath);
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

  check('undo starts disabled with nothing to undo',
    await page.isDisabled('#undo'));

  const drawBox = (id, x0, y0, x1, y1) => page.evaluate(({ id, x0, y0, x1, y1 }) => {
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
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
  await page.focus('#termbox');
  await page.keyboard.press('Control+z');
  check('ctrl+z in the terms box does not undo a redaction',
    await page.evaluate(() => window.Blinded.state.pages[0].manual.length) === 1);

  // ---------- a plain text document ----------
  await newFile();
  await page.waitForSelector('#view-drop:not([hidden])');
  await page.setInputFiles('#file', textPath);
  await page.waitForSelector('#view-review:not([hidden])');
  check('a text file shows the text view', await page.isVisible('#textview'));
  const marks = await page.locator('#textview mark').count();
  check('the text view marks the email and the phone number', marks === 2, String(marks));

  await setTerms(page, ["Jane Doe"]);
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
  const textDownload = await exportFile();
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
  await newFile();
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

  // ---------- one control, not two ----------
  //
  // There used to be a Word match slider beside the image sensitivity. Reading
  // the pages has no threshold, so it governed a method the reviewer almost
  // never meets, and asked them to tune something they had no way to judge.
  // The shape fallback now runs at the value measured across three documents.
  const bars = await page.evaluate(() => {
    const B = window.Blinded;
    return {
      wordControl: Boolean(document.getElementById('wordsens')),
      imageControl: Boolean(document.getElementById('sens')),
      shortBar: B.wordBarFor('KAG'),
      longBar: B.wordBarFor('proprietary'),
      phraseBar: B.wordBarFor('proprietary innovation'),
    };
  });
  check('the word sensitivity control is gone', bars.wordControl === false);
  check('the image sensitivity control remains', bars.imageControl === true);
  check('the fallback still holds a short word to the measured bar',
    Math.abs(bars.shortBar - 0.66) < 1e-9, String(bars.shortBar));
  check('and still lets a long word down, since it scores lower',
    bars.longBar < bars.shortBar, JSON.stringify(bars));
  check('while a phrase gets no relief',
    bars.phraseBar === bars.shortBar, JSON.stringify(bars));

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

  // ---------- reading a page, which is now the default ----------
  //
  // Everything above about typefaces, resampling and thresholds is the shape
  // matcher. This is the path a reviewer actually gets, and it has to be
  // exercised end to end: the engine really loads, really reads a rendered
  // page, and the words it read really become marks in the right places.
  {
    // Earlier sections may have left the document closed, so ask for the drop
    // view rather than assuming which one is showing.
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', readablePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await page.evaluate(() => {
      window.Blinded.state.useOcr = true;
      window.Blinded.state.ocrFailed = false;
      window.Blinded.showWordControls();
    });
    await setTerms(page, ["Jane Doe"]);
    await page.waitForTimeout(400);
  
    const started = Date.now();
    await redact(page);
    const took = Date.now() - started;

    const read = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      const mine = p.imageHits.filter(m => m.term === 'Jane Doe');
      return {
        words: (p.ocrItems || []).length,
        sawName: /Jane\s+Doe/i.test(p.ocrText || ''),
        marks: mine.length,
        insidePage: mine.every(m => m.rect.x >= 0 && m.rect.y >= 0
          && m.rect.x + m.rect.w <= p.source.width
          && m.rect.y + m.rect.h <= p.source.height),
        allRead: mine.every(m => m.read === true),
        failed: B.state.ocrFailed,
      };
    });
    check('the reader loaded and did not fall back', read.failed === false, JSON.stringify(read));
    check('the page came back as words', read.words > 10, String(read.words));
    check('and the name is among what was read', read.sawName, JSON.stringify(read));
    check('which becomes at least one mark', read.marks > 0, JSON.stringify(read));
    check('every mark sits inside the page', read.insidePage, JSON.stringify(read));
    check('and is recorded as read rather than matched', read.allRead, JSON.stringify(read));
    // Not a benchmark, a tripwire: this was eight to ten seconds a page before
    // the engine build was pinned and the reading was split across engines.
    check('reading a page is not pathologically slow', took < 60000, took + 'ms');
  }

  // ---------- what a reviewer gets without touching anything ----------
  //
  // The markup and the state each used to assert a default of their own, which
  // is two places to disagree about the same thing.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    const fresh = await page.evaluate(() => ({
      box: document.getElementById('termimages'),
      state: window.Blinded.state.termImages,
      reading: window.Blinded.state.useOcr,
    }));
    check('words are looked for inside pictures without being asked',
      fresh.state === true, JSON.stringify(fresh));
    // And it cannot be turned off. Switching it off is not a trade a reviewer
    // can make sensibly: a document whose name appears only in a screenshot
    // would come out looking redacted and not be.
    check('and there is no way to turn it off', fresh.box === null,
      JSON.stringify(fresh));
    check('reading is what does it', fresh.reading === true, JSON.stringify(fresh));
  }

  // ---------- the thorough sweep ----------
  //
  // What replaced the amber doubt boxes. Nothing is flagged on suspicion any
  // more; instead the whole document can be searched for the shape of each
  // word, and whatever that turns up beyond what the reading found is added as
  // a mark and drawn amber.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', readablePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    // Nothing is offered before there is a redaction to be thorough about.
    const early = await page.evaluate(() => {
      const B = window.Blinded;
      B.state.terms = ['Amphitheatre'];
      B.state.applied = false;
      B.renderSweep();
      return document.getElementById('sweepbox').hidden;
    });
    check('the thorough check is not offered before anything has been redacted',
      early === true, String(early));

    const offered = await page.evaluate(() => {
      const B = window.Blinded;
      B.state.applied = true;
      B.renderSweep();
      return {
        hidden: document.getElementById('sweepbox').hidden,
        button: document.getElementById('sweep').hidden,
        note: document.getElementById('sweepnote').textContent,
      };
    });
    check('and is offered once one has been', offered.hidden === false
      && offered.button === false, JSON.stringify(offered));
    // It is slow enough that springing it on someone would be a trap.
    check('the offer says how long it will take',
      /about \d+ (second|minute)s?\b/i.test(offered.note), JSON.stringify(offered.note));
    check('and says the document stays usable while it runs',
      /carry on reviewing/.test(offered.note), JSON.stringify(offered.note));

    // The sweep draws every typeface, not the two the old fallback used: the
    // whole reason to run it is that the reading was defeated by unusual type.
    const faces = await page.evaluate(() => {
      const TI = window.BlindedTextImage;
      const B = window.Blinded;
      B.state.terms = ['KNW'];
      const entries = B.sweepTemplates();
      return { count: entries.length, all: TI.FACES.length,
        used: TI.SWEEP_FACES.map(f => f.name),
        everyOneSmall: entries.every(e => e.smallText === true) };
    });
    // Two, not eight: eight was four times the cost for a second opinion on
    // work the reading has already done well.
    check('the sweep draws two typefaces per word, not all eight',
      faces.count === 2 && faces.all === 8, JSON.stringify(faces));
    // One upright and one slanted, because a single upright face misses
    // italic captions outright.
    check('one upright and one slanted',
      faces.used.length === 2
        && faces.used.filter(n => /italic/.test(n)).length === 1,
      JSON.stringify(faces.used));
    // Bold, which was measured: on rendered PDF text the regular-weight pair
    // scored 0.56 and 0.33 against a threshold of 0.636 and found nothing.
    check('and both are the heavier weight, which is what matches rendered ink',
      faces.used.every(n => /bold/.test(n)), JSON.stringify(faces.used));
    check('and treats them all as small text, which is where reading fails',
      faces.everyOneSmall === true, JSON.stringify(faces));

    // A sweep that re-proposed what was already marked would bury its genuine
    // additions in duplicates, which is the failure this feature replaces.
    const dedupe = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      const kept = { x: 100, y: 100, w: 60, h: 20 };
      p.imageHits = [{ id: 'existing', term: 'KNW', rect: kept, score: 1 }];
      const out = {
        onTop: B.alreadyCovered(p, { x: 104, y: 102, w: 60, h: 20 }),
        elsewhere: B.alreadyCovered(p, { x: 400, y: 400, w: 60, h: 20 }),
      };
      p.imageHits = [];
      return out;
    });
    check('a spot already marked is not proposed again',
      dedupe.onTop === true, JSON.stringify(dedupe));
    check('but a spot nothing has touched is', dedupe.elsewhere === false,
      JSON.stringify(dedupe));

    // Amber has to reach the screen, or the distinction does not exist.
    // Checked as pixels for that reason.
    const drawn = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      const ctx = p.canvas.getContext('2d');
      const at = () => [...ctx.getImageData(100, 75, 1, 1).data].slice(0, 3);
      const rect = { x: 60, y: 60, w: 80, h: 30 };

      B.state.applied = false;
      // Planted marks, so the search that would normally have produced them
      // has to be declared: nothing found is drawn before one has run.
      B.state.searched = true;
      p.imageHits = [];
      B.redrawAll();
      const plain = at();

      p.imageHits = [{ id: 'ordinary', term: 'KNW', rect, score: 1 }];
      B.redrawAll();
      const red = at();

      p.imageHits = [{ id: 'found', term: 'KNW', rect, score: 1, bySweep: true }];
      B.redrawAll();
      const amber = at();

      p.imageHits = [];
      B.redrawAll();
      return { plain, red, amber };
    });
    check('a mark the sweep added changes what is on the page',
      drawn.plain.join() !== drawn.amber.join(), JSON.stringify(drawn));
    // Amber and red are both warm, so the green channel is what separates
    // them. Comparing against the ordinary red mark rather than a constant
    // means this fails if the two are ever painted the same.
    check('and it is amber, not the red an ordinary mark gets',
      drawn.amber[1] > drawn.red[1] && drawn.amber.join() !== drawn.red.join(),
      JSON.stringify(drawn));

    // Running it end to end on a real page: the word is in the fixture, so a
    // sweep must find it, mark it, and say what it did.
    const swept = await page.evaluate(async () => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      B.state.terms = ['Parkway'];
      B.state.applied = true;
      p.imageHits = [];
      p.hits = [];
      const added = await B.runSweep();
      const out = {
        added,
        marks: p.imageHits.filter(m => m.bySweep).length,
        note: document.getElementById('sweepnote').textContent,
        buttonGone: document.getElementById('sweep').hidden,
      };
      p.imageHits = [];
      B.state.sweptTerms = [];
      B.state.terms = [];
      return out;
    });
    // It runs in the background: no overlay, an inline bar, and the page keeps
    // painting. A reviewer reported the tab going unresponsive with no bar at
    // all, which was the greyscale for every page being made on the main
    // thread before it was handed to a worker.
    const background = await page.evaluate(async () => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      B.state.terms = ['Parkway'];
      B.state.applied = true;
      p.imageHits = [];
      p.hits = [];

      let frames = 0;
      let overlay = false;
      let inlineBar = false;
      let running = true;
      const tick = () => {
        frames++;
        if (!document.getElementById('busy').hidden) overlay = true;
        if (!document.getElementById('sweeprun').hidden) inlineBar = true;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await B.runSweep();
      running = false;
      const out = { frames, overlay, inlineBar };
      p.imageHits = [];
      B.state.sweptTerms = [];
      B.state.terms = [];
      return out;
    });
    check('the sweep does not put the blocking overlay up',
      background.overlay === false, JSON.stringify(background));
    check('it shows its progress in the panel instead',
      background.inlineBar === true, JSON.stringify(background));
    // If the main thread were doing the pixel work, frames would not be drawn.
    check('and the page keeps painting while it runs',
      background.frames >= 5, JSON.stringify(background));

    // Redacting while the check is running.
    //
    // Left to race, the two would spawn competing workers and — worse — the
    // check would finish afterwards and call markPending, putting the document
    // back into review seconds after the reviewer had just redacted it. So the
    // check stands down first, and is asked about rather than killed silently.
    const raced = await page.evaluate(async () => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      B.state.terms = ['Parkway'];
      B.state.applied = true;
      p.imageHits = [];

      const sweeping = B.runSweep();
      // Press the button while it is still going.
      const redaction = B.runSearch().then(() => B.coverMarks());
      const asked = !document.getElementById('confirmbox').hidden;
      const wording = document.getElementById('confirmbody').textContent;
      document.getElementById('confirmyes').click();
      await redaction;
      await sweeping;
      const out = {
        asked, wording,
        running: B.state.sweepRunning,
        // The document must be redacted when the dust settles, not flipped
        // back into review by the check landing late.
        applied: B.state.applied,
      };
      p.imageHits = [];
      B.state.sweptTerms = [];
      B.state.terms = [];
      return out;
    });
    check('redacting during the check asks before stopping it',
      raced.asked === true, JSON.stringify(raced));
    check('and says what will be lost', /stops it at page/i.test(raced.wording || ''),
      raced.wording);
    check('the check is not left running afterwards',
      raced.running === false, JSON.stringify(raced));
    check('and the document stays redacted rather than being flipped back',
      raced.applied === true, JSON.stringify(raced));

    // Declining leaves both alone.
    const declined = await page.evaluate(async () => {
      const B = window.Blinded;
      B.state.terms = ['Parkway'];
      B.state.applied = true;
      const sweeping = B.runSweep();
      // Not awaited before answering: the redaction is sitting on the
      // question, so awaiting it here would wait for a click that has not
      // happened yet and never return.
      const redaction = B.applyRedaction();
      const asked = !document.getElementById('confirmbox').hidden;
      document.getElementById('confirmno').click();
      await redaction;
      const stillSweeping = B.state.sweepRunning;
      await B.settleSweep();
      await sweeping;
      B.state.sweptTerms = [];
      B.state.terms = [];
      for (const p of B.state.pages) p.imageHits = [];
      return { asked, stillSweeping };
    });
    check('declining leaves the check running', declined.stillSweeping === true,
      JSON.stringify(declined));

    // And the check cannot be started on top of a redaction either.
    const blocked = await page.evaluate(async () => {
      const B = window.Blinded;
      B.state.terms = ['Parkway'];
      B.state.redacting = true;
      const added = await B.runSweep();
      B.state.redacting = false;
      B.state.terms = [];
      return { added, running: B.state.sweepRunning };
    });
    check('and the check will not start on top of a redaction',
      blocked.added === 0 && blocked.running === false, JSON.stringify(blocked));

    check('the sweep finds a word that is really on the page',
      swept.added >= 1 && swept.marks === swept.added, JSON.stringify(swept));
    check('and every mark it adds is flagged as its own',
      swept.marks >= 1, JSON.stringify(swept));
    check('afterwards it says what it added', /added \d+ mark/.test(swept.note),
      JSON.stringify(swept.note));
    check('and stops offering itself for the same words',
      swept.buttonGone === true, JSON.stringify(swept));

    // The sweep costs minutes. Editing one word and pressing Redact used to
    // throw away everything it found, while the note still said the marks
    // were on the page — the reading pass rebuilt the term marks from scratch
    // and took the sweep's with them.
    const kept = await page.evaluate(async () => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      const planted = { id: 'sweep:Parkway:0:900:900', term: 'Parkway',
        rect: { x: 900, y: 900, w: 120, h: 30 }, score: 1, bySweep: true };
      B.state.terms = ['Parkway'];
      B.state.sweptTerms = ['Parkway'];
      B.state.sweepAdded = 1;
      p.imageHits = [planted];

      // Adding a word keeps what the sweep found for the words already there.
      B.state.terms = ['Parkway', 'Amphitheatre'];
      B.matchOcr();
      const afterRescan = p.imageHits.filter(m => m.bySweep).length;

      // Deleting the word it belongs to does not.
      B.dropTerm('Parkway');
      await new Promise(r => setTimeout(r, 200));
      const afterDelete = p.imageHits.filter(m => m.bySweep).length;
      p.imageHits = [];
      B.state.sweptTerms = [];
      B.state.terms = [];
      return { afterRescan, afterDelete };
    });
    check('a mark the sweep found survives a rerun of the reading',
      kept.afterRescan === 1, JSON.stringify(kept));
    check('but not the deletion of the word it belongs to',
      kept.afterDelete === 0, JSON.stringify(kept));
  }

  // ---------- every long pass reports the same way ----------
  //
  // Rendering the pages, reading them, searching them and flattening them for
  // export are four passes over the same document. Each used to announce
  // itself differently, and only one of them had a bar.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');

    const seen = page.evaluate(() => new Promise(resolve => {
      const started = Date.now();
      const texts = [];
      const notes = [];
      const withBar = [];
      // Watched rather than sampled. A poll every 25ms missed the bar on a
      // short document perhaps one run in three — not because the bar was
      // absent but because rendering two pages is quicker than the sampler.
      // An observer sees every change to the overlay whether or not the
      // browser happened to yield while it was on screen.
      const sample = () => {
        const busy = document.getElementById('busy');
        if (busy.hidden) return;
        texts.push(document.getElementById('busy-text').textContent);
        notes.push(document.getElementById('busy-note').textContent);
        withBar.push(!document.getElementById('busy-legs').hidden);
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.getElementById('busy'),
        { attributes: true, childList: true, characterData: true, subtree: true });
      sample();
      const watch = setInterval(sample, 25);
      // Watch until the document is open rather than for a fixed stretch: a
      // window long enough today is a race tomorrow, and a flaky check is
      // worse than no check.
      const until = setInterval(() => {
        const open = !document.getElementById('view-review').hidden;
        if (open || Date.now() - started > 15000) {
          clearInterval(watch); clearInterval(until); observer.disconnect();
          resolve({ texts, notes, withBar });
        }
      }, 20);
    }));
    // Loading happens while that watcher runs.
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    const sample = await seen;
    // Watching a file be worked on for the first time is exactly when someone
    // wonders where it has gone.
    check('loading a file says where the file is going',
      sample.notes.some(n => /locally on your device/.test(n) && /Nothing is uploaded/.test(n)),
      JSON.stringify([...new Set(sample.notes)].slice(0, 3)));
    check('rendering a document reports its pages like everything else',
      sample.withBar.some(Boolean), JSON.stringify([...new Set(sample.texts)].slice(0, 4)));
    check('and the note is gone once the file is open',
      await page.evaluate(() => document.getElementById('busy-note').hidden) === true);
    check('and no pass announces itself in the old wording',
      !sample.texts.some(t => /Rendering page|Flattening page|Searching for/.test(t)),
      JSON.stringify([...new Set(sample.texts)].slice(0, 4)));
  }

  // ---------- one bar for both passes ----------
  //
  // Reading the pages and searching them for a picked image are separate jobs,
  // but they are two passes over the same document, one after the other. Two
  // bars filling in sequence reads as the first one having lied, so the work
  // is counted once and both legs report into it.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const seen = await page.evaluate(async () => {
      const B = window.Blinded;
      const widths = [];
      const texts = [];
      // Watch the bar while a run goes on.
      const watch = setInterval(() => {
        const row = document.querySelector('[data-leg="search"], [data-leg="only"]');
        if (row) {
          widths.push(parseFloat(row.querySelector('[data-fill]').style.width) || 0);
          texts.push(row.querySelector('[data-count]').textContent);
        }
      }, 60);
      const wasOn = B.state.termImages;
      B.state.termImages = false;         // a picked image only, no reading
      await B.addTemplate(B.state.pages[0], { x: 40, y: 40, w: 120, h: 120 });
      await B.applyRedaction();
      clearInterval(watch);
      const out = { widths, texts: [...new Set(texts)].slice(0, 4),
                    templates: B.state.templates.length };
      // Put back what the later sections expect to find.
      B.state.termImages = wasOn;
      return out;
    });
    check('an image search reports progress on a bar of its own',
      seen.widths.length > 0, JSON.stringify(seen).slice(0, 200));
    // Not just that a bar appeared: that it moved. Showing one and leaving it
    // at nothing for the whole search is worse than showing none.
    check('and the bar actually advances as pages are searched',
      new Set(seen.widths).size > 1, JSON.stringify(seen.widths));
    check('and counts them the way every other leg does',
      seen.texts.every(t => /^\d+ of \d+$/.test(t)), JSON.stringify(seen.texts));
    check('the bar only ever moves forward',
      seen.widths.every((w, i) => i === 0 || w >= seen.widths[i - 1]),
      JSON.stringify(seen.widths));
  }

  // ---------- the Images hint belongs to the Images section ----------
  //
  // It sits under "Select an image to redact". A word search used to report
  // into it, so a reviewer who had picked no image at all was told "Found 2
  // times" underneath a button they had never pressed — a count of something
  // else entirely, in the one place it could only be read as being about an
  // image.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', readablePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const before = await page.evaluate(() => ({
      hidden: document.getElementById('pickhint').hidden,
      templates: window.Blinded.state.templates.length,
    }));
    check('with no image picked the Images hint says nothing',
      before.hidden === true && before.templates === 0, JSON.stringify(before));

    // A word search, by the shape fallback, with no image picked at all.
    await page.evaluate(() => {
      window.Blinded.state.useOcr = false;
      window.Blinded.showWordControls();
    });
    await setTerms(page, ["Jane"]);
    await page.waitForTimeout(300);
    await redact(page);

    const after = await page.evaluate(() => ({
      hidden: document.getElementById('pickhint').hidden,
      text: document.getElementById('pickhint').textContent,
      templates: window.Blinded.state.templates.length,
      termCounts: document.getElementById('termcounts').textContent.replace(/\s+/g, ' ').trim(),
    }));
    check('and still says nothing after a word search finds things',
      after.hidden === true, JSON.stringify(after));
    check('no image having been picked', after.templates === 0, JSON.stringify(after));
    // What the word search found is reported where words are listed.
    check('the term list is where the word count appears',
      /Jane/.test(after.termCounts), JSON.stringify(after.termCounts));
  }

  // ---------- changing the terms after a run ----------
  //
  // Reading a page and matching terms against what was read are different jobs
  // with different costs, and only one depends on the settings. A term added
  // after a run — or during a pause — has to be matched against every page
  // already read, but those pages must not be read again: on a hundred-page
  // document that would turn a change of mind into another minute of waiting.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', readablePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ["Jane"]);
    await page.waitForTimeout(300);
    await redact(page);

    const first = await page.evaluate(() => {
      const p = window.Blinded.state.pages[0];
      // Stamp the read words so a second reading can be told from a re-match.
      p.ocrItems.__stamp = 'first';
      return {
        marks: p.imageHits.filter(m => m.term).length,
        terms: window.Blinded.state.searchedTerms.slice(),
      };
    });
    check('the first term is matched in what was read',
      first.marks > 0, JSON.stringify(first));

    // Add a second term, as a reviewer would after looking at the marks.
    await setTerms(page, ["Jane", "Account"]);
    await page.waitForTimeout(400);
    const stale = await page.evaluate(() => window.Blinded.ocrMatchStale());
    check('a newly typed term leaves the matching out of date', stale === true);
    check('which the Redact button notices',
      await page.evaluate(() => window.Blinded.ocrPending()) === true);

    await redact(page);
    const second = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      return {
        stamp: p.ocrItems.__stamp,
        terms: B.state.searchedTerms.slice(),
        byTerm: B.state.terms.map(t => ({
          term: t, marks: p.imageHits.filter(m => m.term === t).length })),
      };
    });
    check('the pages are not read a second time',
      second.stamp === 'first', JSON.stringify(second));
    check('but the new term is matched against them',
      second.terms.includes('Account'), JSON.stringify(second));
    check('and both terms are now accounted for',
      second.byTerm.every(t => t.marks >= 0) && second.terms.length === 2,
      JSON.stringify(second));
  }

  // ---------- pages that cannot hide anything ----------
  //
  // A page with no images and no filled paths has nowhere to put lettering the
  // text layer does not already report, so reading it can only find what is
  // already known. Worth saying what this is and is not worth: on a slide deck
  // it skips nothing, because every page has images, and the asking costs
  // about half a second. That is why the asking stops at the first page that
  // has to be read.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    const plain = await page.evaluate(() => window.Blinded.state.pages.map(p => p.couldHideText));
    check('a page of nothing but text is known to hide nothing',
      plain.every(v => v === false), JSON.stringify(plain));

    await setTerms(page, ["Jane Doe"]);
    await page.waitForTimeout(300);
    const started = Date.now();
    await redact(page);
    const skipped = await page.evaluate(() => {
      const B = window.Blinded;
      return {
        skipped: B.state.pages.filter(p => p.ocrSkipped).length,
        total: B.state.pages.length,
        textHits: B.state.pages.reduce((n, p) => n + (p.hits || []).length, 0),
        applied: B.state.applied,
      };
    });
    check('so it is not read at all', skipped.skipped === skipped.total, JSON.stringify(skipped));
    check('and the words in its text are still covered',
      skipped.textHits > 0, JSON.stringify(skipped));
    check('the redaction still completes', skipped.applied === true, JSON.stringify(skipped));
    // The saving is the whole of the reading, so this should be quick. Loose,
    // because it is a tripwire and not a benchmark.
    check('skipping is much faster than reading would have been',
      Date.now() - started < 1500, (Date.now() - started) + 'ms');

    // A page with pictures on it is never skipped, whatever else is true.
    await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    const drawn = await page.evaluate(() => window.Blinded.state.pages.map(p => p.couldHideText));
    check('a page with pictures on it is always read',
      drawn.every(v => v === true), JSON.stringify(drawn));
  }

  // ---------- progress, and stopping to look ----------
  //
  // A hundred pages is long enough that a reviewer will want to see what has
  // been found before it finishes, and having seen it may want to change the
  // terms rather than wait out a run looking for the wrong thing. Stopping is
  // between pages: what has been read is kept, and carrying on resumes rather
  // than starting again — re-reading would make pausing cost more than
  // waiting, which is no pause at all.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    // Two pages, because stopping happens between them: on a one-page document
    // a pause can never arrive in time to prevent that page being read, and
    // asserting that it does would be asserting the wrong thing.
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ["Jane Doe"]);
    await page.waitForTimeout(300);

    const shape = await page.evaluate(() => {
      const host = document.getElementById('busy-legs');
      const pause = document.getElementById('busy-pause');
      return { host: Boolean(host), pause: Boolean(pause),
               rows: host.children.length, hiddenAtRest: host.hidden && pause.hidden };
    });
    check('the overlay can hold progress bars and a pause button',
      shape.host && shape.pause, JSON.stringify(shape));
    check('and shows neither when nothing is running',
      shape.hiddenAtRest && shape.rows === 0, JSON.stringify(shape));

    const reported = await page.evaluate(() => {
      const B = window.Blinded;
      B.busy(true, 'Working…');
      B.legs([{ key: 'read', label: 'Reading pages', total: 100 }]);
      B.leg('read', 29);
      const row = document.querySelector('[data-leg="read"]');
      const out = {
        label: row.querySelector('.leg-label span').textContent,
        count: row.querySelector('[data-count]').textContent,
        width: row.querySelector('[data-fill]').style.width,
        shown: !document.getElementById('busy-legs').hidden,
      };
      B.busy(false);
      out.afterStop = document.getElementById('busy-legs').hidden;
      return out;
    });
    check('a leg says what it is doing', reported.label === 'Reading pages',
      JSON.stringify(reported));
    check('and how far through it is', reported.count === '29 of 100',
      JSON.stringify(reported));
    // The browser normalises the string, so compare the number, not the text.
    check('its bar matches that',
      Math.abs(parseFloat(reported.width) - 29) < 0.5, reported.width);
    check('bars show while a run is going', reported.shown === true);
    check('and are packed away when it ends', reported.afterStop === true);

    const unknown = await page.evaluate(() => {
      const B = window.Blinded;
      B.busy(true, 'Fetching the page reader…');
      const shown = !document.getElementById('busy-legs').hidden;
      B.busy(false);
      return shown;
    });
    check('a run whose length is not known shows no bar, rather than a still one',
      unknown === false);

    // A leg with no work is not drawn. An empty bar for a search nobody asked
    // for is a bar that will never move.
    const skipped = await page.evaluate(() => {
      const B = window.Blinded;
      B.busy(true, 'Working…');
      B.legs([
        { key: 'read', label: 'Reading pages', total: 12 },
        { key: 'search', label: 'Searching images', total: 0 },
      ]);
      const out = {
        rows: [...document.querySelectorAll('[data-leg]')].map(r => r.dataset.leg),
      };
      B.busy(false);
      return out;
    });
    check('a leg with nothing to do is not drawn',
      skipped.rows.length === 1 && skipped.rows[0] === 'read', JSON.stringify(skipped));

    // Both at once, which is the point: on a pause the reviewer can see that
    // the pages are read to here and the images are not started.
    const both = await page.evaluate(() => {
      const B = window.Blinded;
      B.busy(true, 'Working…');
      B.legs([
        { key: 'read', label: 'Reading pages', total: 100 },
        { key: 'search', label: 'Searching images', total: 100 },
      ]);
      B.leg('read', 40);
      const rows = [...document.querySelectorAll('[data-leg]')].map(r => ({
        key: r.dataset.leg,
        count: r.querySelector('[data-count]').textContent,
        width: r.querySelector('[data-fill]').style.width,
      }));
      B.busy(false);
      return rows;
    });
    check('both legs are shown together, not one after the other',
      both.length === 2, JSON.stringify(both));
    check('each carries its own count',
      both[0].count === '40 of 100' && both[1].count === '0 of 100',
      JSON.stringify(both));
    check('so a pause says which part got how far, not just a percentage',
      parseFloat(both[0].width) > 0 && parseFloat(both[1].width) === 0,
      JSON.stringify(both));

    const paused = await page.evaluate(async () => {
      const B = window.Blinded;
      B.state.termImages = true;
      B.state.useOcr = true;
      // Pressing Redact clears any earlier pause, so the only way to stop a
      // run is to ask while it is running — which is what the button does.
      const run = B.applyRedaction();
      await new Promise(done => setTimeout(done, 50));
      B.requestPause();
      await run;
      return {
        applied: B.state.applied,
        ocrRead: B.state.ocrRead,
        read: B.state.pages.filter(p => p.ocrItems).length,
        total: B.state.pages.length,
        overlay: document.getElementById('busy').hidden,
      };
    });
    check('a paused run does not claim the document is redacted',
      paused.applied === false, JSON.stringify(paused));
    check('and leaves the overlay down so the marks can be looked at',
      paused.overlay === true, JSON.stringify(paused));
    check('and does not record the document as read',
      paused.ocrRead === false, JSON.stringify(paused));
    // How far it got depends on where the pause landed — possibly before the
    // first page, if the engines were still starting. What matters is that it
    // stopped short and kept whatever it had.
    check('having stopped short of the whole document',
      paused.read < paused.total, JSON.stringify(paused));

    const resumed = await page.evaluate(async () => {
      const B = window.Blinded;
      B.state.paused = false;
      await B.runSearch();
      B.coverMarks();
      return {
        applied: B.state.applied,
        read: B.state.pages.filter(p => p.ocrItems).length,
        total: B.state.pages.length,
        ocrRead: B.state.ocrRead,
      };
    });
    check('carrying on reads the rest of the document',
      resumed.read === resumed.total, JSON.stringify(resumed));
    check('and finishes the redaction', resumed.applied === true, JSON.stringify(resumed));
    check('which is then recorded as read', resumed.ocrRead === true, JSON.stringify(resumed));
  }

  // ---------- a second document is a second document ----------
  //
  // The reader is run once per document and the result kept, because a page's
  // words do not change when the terms list is edited. That flag was not being
  // cleared when a new document was opened, so the second document was never
  // read: the box was ticked, the work looked done, nothing ran, and the file
  // came back with the words still on it and no sign that anything was wrong.
  // It took a page refresh to clear, which is not something a reviewer would
  // think to do.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', readablePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ["Jane Doe"]);
    await page.waitForTimeout(300);
    await redact(page);
    const first = await page.evaluate(() =>
      (window.Blinded.state.pages[0].ocrItems || []).length);

    // Now a different document, without reloading the page.
    await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', wordmarkPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    const carried = await page.evaluate(() => ({
      read: window.Blinded.state.ocrRead,
      failed: window.Blinded.state.ocrFailed,
    }));
    check('opening a document forgets that the last one was read',
      carried.read === false, JSON.stringify(carried));
    check('and forgets that the last one fell back',
      carried.failed === false, JSON.stringify(carried));

    await setTerms(page, ["KAG"]);
    await page.waitForTimeout(300);
    await redact(page);
    const second = await page.evaluate(() =>
      (window.Blinded.state.pages[0].ocrItems || []).length);
    check('the first document was read', first > 0, String(first));
    check('and so is the second, without a refresh', second > 0, String(second));
  }

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

  // ---------- the "?" hints ----------
  //
  // These used to be title attributes, which wait a second or two, never
  // appear on a touch screen, and cannot be reached from the keyboard — so
  // they read as decoration that does nothing. What matters is that the text
  // actually becomes visible, so that is what is asserted, not that a handler
  // is attached.
  // Three, not four: the fourth explained the "find these words as pictures"
  // checkbox, which is gone — the tool always does that now, and what it means
  // is answered on the questions page instead.
  const whyCount = await page.evaluate(() => document.querySelectorAll('.why').length);
  check('the panel still has its hints', whyCount === 3, String(whyCount));
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

  // ---------- the questions page ----------
  //
  // The claim on the front page is that nothing is uploaded. That claim is
  // only checkable if a reader can reach the source, so the link is part of
  // the argument rather than decoration. It used to sit in the footer; it now
  // lives on the questions page, reached from the header, and the test follows
  // the same route a reader would.
  const headerLink = await page.evaluate(() => {
    const a = document.querySelector('.top .top-link');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { href: a.getAttribute('href'), text: a.textContent.trim(),
             visible: r.width > 0 && r.height > 0,
             onTheRight: r.left > window.innerWidth / 2 };
  });
  check('the header carries a link to the questions',
    headerLink !== null && /faq/.test(headerLink.href), JSON.stringify(headerLink));
  check('and it is labelled Q&A', headerLink && headerLink.text === 'Q&A',
    headerLink && headerLink.text);
  check('and it is on the right of the strip, where it was asked for',
    headerLink && headerLink.visible && headerLink.onTheRight, JSON.stringify(headerLink));

  await page.click('.top .top-link');
  await page.waitForSelector('.faq', { timeout: 15000 });
  const faq = await page.evaluate(() => {
    const link = document.querySelector('.faq a[href*="github.com"]');
    const r = link && link.getBoundingClientRect();
    return {
      questions: document.querySelectorAll('.faq h2').length,
      answered: [...document.querySelectorAll('.faq')].every(s =>
        s.querySelector('p') && s.querySelector('p').textContent.trim().length > 40),
      href: link && link.getAttribute('href'),
      visible: !!(r && r.width > 0 && r.height > 0),
      icon: !!(link && link.querySelector('svg')),
      // The claim the whole tool rests on should be the first thing answered.
      firstQuestion: (document.querySelector('.faq h2') || {}).textContent,
      openSource: /free and open source/i.test(document.body.textContent),
      back: !!document.querySelector('a[href="index.html"]'),
    };
  });
  check('the questions page asks between five and ten things',
    faq.questions >= 5 && faq.questions <= 10, String(faq.questions));
  check('and every one of them is actually answered', faq.answered === true);
  check('it leads with whether the document is uploaded',
    /upload/i.test(faq.firstQuestion || ''), faq.firstQuestion);
  check('it carries the link to the source', faq.href === 'https://github.com/jaredsia-svg/blinded',
    faq.href);
  check('the link is actually rendered, not just present', faq.visible === true);
  check('the link carries its mark', faq.icon === true);
  check('and it still says the tool is free and open source', faq.openSource === true);
  check('there is a way back to the tool', faq.back === true);

  await page.goBack();
  await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });

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
