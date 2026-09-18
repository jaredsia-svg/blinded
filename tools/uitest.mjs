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
import { buildTextPdf, buildReadablePdf, buildLogoPdf, buildLockedPdf, buildManyPdf, LOGO_PLACEMENTS,
  buildWordmarkPdf, WORDMARK_PLACEMENTS, WORDMARK_ASPECT,
  buildSmallLogoPdf, SMALL_LOGO_PLACEMENTS, WORDMARK_BOX,
  buildDoubleFoundPdf, DOUBLE_TERM, buildStackedPdf,
  buildPausePdf } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(join(here, '..'));

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) passed++;
  else failures.push(label + (detail === undefined ? '' : ' — ' + detail));
};

// Running one section of this suite instead of all of it.
//
// The whole pass is minutes, because it does the real work: real PDFs
// rendered, real OCR, real second checks, in a real browser. That is
// the point of it, and it is also the wrong price for checking one small edit.
// ONLY=<text> runs the sections whose names contain that text, as a regular
// expression, and skips the rest.
//
// A filtered run is a convenience, never the answer. The sections share a
// browser and, in places, a loaded document, so one run alone can fail for
// want of something a section before it did. Both the banner at the start and
// the count at the end say the run was partial, so a green filtered run can
// never be mistaken for a green suite. Push on the full one.
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
let skippedParts = 0;
const partNames = [];

async function part(name, body) {
  partNames.push(name);
  if (ONLY && !ONLY.test(name)) { skippedParts++; return; }
  await body();
}

if (ONLY) {
  console.log('\nONLY=' + process.env.ONLY + ' - running part of the suite.'
    + ' The full pass is the one that counts.\n');
}

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
const manyPath = join(tmpdir(), 'blinded-many.pdf');
writeFileSync(manyPath, buildManyPdf(14));
const lockedPath = join(tmpdir(), 'blinded-locked.pdf');
writeFileSync(lockedPath, buildLockedPdf('letmein'));
const doublePath = join(tmpdir(), 'blinded-double.pdf');
writeFileSync(doublePath, buildDoubleFoundPdf());
const stackedPath = join(tmpdir(), 'blinded-stacked.pdf');
writeFileSync(stackedPath, buildStackedPdf());
const pausePath = join(tmpdir(), 'blinded-pause.pdf');
writeFileSync(pausePath, buildPausePdf(8));
const smallLogoPath = join(tmpdir(), 'blinded-smalllogo.pdf');
writeFileSync(smallLogoPath, buildSmallLogoPdf());
const wordmarkPath = join(tmpdir(), 'blinded-wordmark.pdf');
writeFileSync(wordmarkPath, buildWordmarkPdf());
const textPath = join(tmpdir(), 'blinded-fixture.txt');
// The address line is here so that a typed word can be tested inside a
// shape-only finding, which is the case that used to lose both.
writeFileSync(textPath, 'Jane Doe — jane.doe@example.com — (415) 555-0132\n'
  // A number in the form the detector still proposes. The local one above it
  // stays: the phone detector now takes only +country-code forms, because OCR
  // of chart labels and currency blobs invented the local shapes constantly,
  // and the tests below say so out loud rather than leaving it to be
  // discovered on somebody's document.
  + 'Direct line +44 20 7946 0958.\n'
  + 'Mailing address: 1600 Amphitheatre Parkway, 94043.\n'
  + 'nothing sensitive here\n');

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
  // The box lives inside a section that can be shut, and a reviewer opens the
  // section before typing into it. Without this the fill waits on a control
  // that is not on screen and the whole suite dies where it stands, several
  // hundred checks after whatever closed the section.
  await reveal(page, 'termbox');
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
// Tick every detector.
//
// They are off when a document opens — the reviewer decides what to look for
// — so any test about what a detector finds has to ask for it first, the way
// a reviewer would.
async function useDetectors(page) {
  await page.evaluate(() => {
    const B = window.Blinded;
    for (const row of window.BlindedDetect.KINDS) B.state.enabled.add(row.kind);
    B.renderKinds();
    B.rescan({ settled: true });
    B.refreshApply();
  });
}

// And the other way: every detector off, the state a document opens in. The
// choice is kept across documents in a session, so a test that has ticked
// them has to put them back before asserting anything about a quiet panel.
async function noDetectors(page) {
  await page.evaluate(() => {
    const B = window.Blinded;
    for (const row of window.BlindedDetect.KINDS) B.state.enabled.delete(row.kind);
    B.renderKinds();
    B.rescan({ settled: true });
    B.refreshApply();
  });
}

// A search now ends by offering the second check, in a dialog over the panel.
// A reviewer answers it before doing anything else, so the suite does too —
// otherwise every click after a search lands on the dialog's backdrop, which
// is exactly how this suite stopped running: the next press of Redact waited
// for a button that something else was covering.
async function dismissSweepOffer(page) {
  // Pressed through the DOM rather than with the mouse: the dialog's own
  // backdrop is what the pointer would land on, which is the whole reason
  // this helper exists.
  await page.evaluate(() => {
    const box = document.getElementById('sweepoffer');
    const skip = document.getElementById('sweepofferskip');
    if (box && !box.hidden && skip) skip.click();
  });
  await page.waitForTimeout(60);
}

// "Nothing is running", whichever way the run reports itself.
//
// A search used to hold the page behind a dialog, so waiting for the dialog to
// go was waiting for the search. It reports itself along the foot of the page
// now and leaves the page alone — which means the dialog is already hidden
// while the search is still going, and every wait written against it returns
// at once and tests the document mid-search.
const settled = () => `!window.Blinded || (document.getElementById('busy').hidden
  && !window.Blinded.state.redacting && !window.Blinded.state.sweepRunning)`;

async function redact(page) {
  await dismissSweepOffer(page);
  // Search and Redact are two buttons, and only the one whose turn it is is
  // on screen. Search when there is something left to search for -- which is
  // exactly when that button is the one showing.
  if (await page.isVisible('#search') && !(await page.isDisabled('#search'))) {
    await page.click('#search');
    await page.waitForFunction(() => window.Blinded.state.searched === true,
      undefined, { timeout: 240000 });
  }
  await page.waitForFunction(settled(),
    undefined, { timeout: 240000 });
  await dismissSweepOffer(page);
  // Only if there is something to cover: with nothing found the button is
  // rightly dead, and a test that only wanted the search is finished.
  const canCover = await page.evaluate(() => !window.Blinded.state.applied
    && !document.getElementById('apply').disabled);
  if (canCover) {
    await dismissSweepOffer(page);
    await page.click('#apply');
    await page.waitForFunction(() => window.Blinded.state.applied === true,
      undefined, { timeout: 60000 });
  }
  await page.waitForFunction(settled(),
    undefined, { timeout: 240000 });
}

// Every click in this file goes through the second-check offer first.
//
// That offer is a modal: while it is up, a click anywhere else lands on its
// backdrop. A reviewer answers it and carries on, and so must the suite —
// but saying so at sixty call sites is sixty chances to forget, and forgetting
// looks like "the button does not work" half an hour into a run.
const rawClick = page.click.bind(page);
page.click = async (selector, options) => {
  await dismissSweepOffer(page);
  return rawClick(selector, options);
};

const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  // Opening another file now asks before it throws the current one away, so
  // every reset in these tests goes through that step rather than around it.
  const newFile = async () => {
    // The second-check offer is modal, and a reviewer answers it before doing
    // anything else. Every route out of a searched document goes through it.
    await dismissSweepOffer(page);
    await page.click('#reset-top');
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
  // Asked for first: the detectors are off when a document opens, so that a
  // reviewer decides what to look for rather than arriving at five questions
  // the tool put to itself.
  await useDetectors(page);
  const kinds = await page.evaluate(() =>
    window.Blinded.state.pages[0].findings.map(f => f.kind));
  for (const kind of ['email', 'phone', 'url']) {
    check('the page view detected a ' + kind, kinds.includes(kind), kinds.join(','));
  }

  const boxCount = await page.evaluate(() =>
    window.Blinded.state.pages[0].hits.filter(h => h.rects.length).length);
  check('every detection produced at least one box', boxCount === kinds.length,
    boxCount + ' of ' + kinds.length);

  // ---------- a typed word is never lost to a detector ----------
  //
  // Overlapping findings collapse to a single winner, longest first. The
  // address around the typed word is longer, so it wins — and used to carry
  // the word off with it, leaving a reviewer who had explicitly asked for that
  // word told it was found nowhere. The wider span is still the one that gets
  // covered, which is more ink, not less; what it must not do is keep its own
  // name. On a PDF the reading happened to find the word anyway; on a text
  // file there is no such second chance, which is what this checks.
  await part("a typed word is never lost to a detector", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', textPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Amphitheatre']);

    const seen = await page.evaluate(() => {
      const B = window.Blinded;
      const D = window.BlindedDetect;
      return {
        inTheText: /Amphitheatre/.test(B.state.text),
        // The address around it, on its own, is the span that used to win.
        addressExists: D.findAll(B.state.text, { kinds: ['address'] })
          .some(f => f.kind === 'address'),
        // The span that carries the word: either the word itself, or the
        // longer thing that grew around it and now records what it holds.
        marked: B.state.findings.filter(f =>
          f.term === 'Amphitheatre'
          || (f.holds && f.holds.includes('Amphitheatre'))).length,
        covers: (B.state.findings.find(f =>
          f.term === 'Amphitheatre'
          || (f.holds && f.holds.includes('Amphitheatre'))) || {}).text || '',
      };
    });
    check('the fixture really does hold the word', seen.inTheText === true,
      JSON.stringify(seen));
    check('and an address around it, which is the longer span',
      seen.addressExists === true, JSON.stringify(seen));
    check('the typed word is still marked', seen.marked === 1, JSON.stringify(seen));
    // And the panel says so: a word swallowed by a longer span is still a
    // word the reviewer asked for and still has somewhere to point at.
    check('and the panel can still say where it is',
      (await page.evaluate(() => window.Blinded.occurrencesFor('Amphitheatre').length
        || window.Blinded.state.findings.filter(f => f.holds
          && f.holds.includes('Amphitheatre')).length)) >= 1);
    check('and the mark covers the whole address, not just the word',
      seen.covers.includes('1600') && seen.covers.includes('Parkway'),
      JSON.stringify(seen));

    await redact(page);
    const out = await exportFile();
    const saved = join(tmpdir(), 'blinded-term-overlap.txt');
    await out.saveAs(saved);
    const text = readFileSync(saved, 'utf8');
    // The whole point of the tool: what was asked for is not in the file.
    // Paired with a check that the rest of the file is still there, so an
    // empty export cannot pass this by saying nothing at all.
    check('and it is gone from the exported file',
      !/Amphitheatre/.test(text), text.slice(0, 200));
    check('while the rest of the file survives',
      /nothing sensitive here/.test(text), text.slice(0, 200));
  });

  // ---------- adding a word ----------
  //
  // The list used to be a textarea read on every keystroke, so a name being
  // typed was searched for at every prefix. A word joins the list when the
  // reviewer says so.
  await part("adding a word", async () => {
    await newFile();
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const listed = () => page.evaluate(() => ({
      words: [...document.querySelectorAll('#termcounts .t')].map(n => n.textContent.trim()),
      state: window.Blinded.state.terms.slice(),
      tallies: [...document.querySelectorAll('#termcounts .n')].filter(n => !n.hidden).length,
      unknown: document.querySelectorAll('#termcounts .n.unknown').length,
      numbers: [...document.querySelectorAll('#termcounts .n')]
        .filter(n => /^\d+$/.test(n.textContent.trim())).length,
      notFound: [...document.querySelectorAll('#termcounts .n')]
        .filter(n => /not found/.test(n.textContent)).length,
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
    check('no number until something has searched',
      added.unknown === 1 && added.numbers === 0, JSON.stringify(added));

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
      searched.numbers + searched.notFound === 2 && searched.unknown === 0,
      JSON.stringify(searched));

    // And a word added after that search keeps the others' numbers while
    // wearing its own question mark: an answer from a minute ago is still an
    // answer, and blanking the lot threw away work that was still good.
    await page.fill('#termbox', 'Parkway');
    await page.press('#termbox', 'Enter');
    await page.waitForTimeout(250);
    const mixed = await listed();
    check('a word added later does not blank the others',
      mixed.numbers + mixed.notFound === 2, JSON.stringify(mixed));
    check('and wears its own question mark until the next search',
      mixed.unknown === 1, JSON.stringify(mixed));
    await page.evaluate(() => window.Blinded.dropTerm('Parkway'));
    await page.waitForTimeout(200);

    // And a word can be taken off again. Searched first, so that what is
    // being tested is what removal does rather than what the last add did.
    await redact(page);
    await page.click('#termcounts li.word .termdrop');
    await page.waitForTimeout(300);
    const dropped = await listed();
    check('a word can be removed from the list',
      dropped.words.join() === 'Amphitheatre', JSON.stringify(dropped));
    // Nothing new needs finding when a word comes off, so the reviewer is not
    // sent back to Search to be told the same thing about the words they kept.
    const afterDrop = await page.evaluate(() => ({
      searched: window.Blinded.state.searched,
      label: document.getElementById('apply').textContent.trim(),
      numbers: [...document.querySelectorAll('#termcounts .dot-green')]
        .filter(n => /^\d+$/.test(n.textContent.trim())).length,
      marks: window.Blinded.state.pages.reduce(
        (n, p) => n + window.Blinded.activeBoxes(p).length, 0),
      forDropped: window.Blinded.state.pages.reduce(
        (n, p) => n + p.imageHits.filter(m => m.term === 'Jane').length, 0),
    }));
    check('removing one does not put it back to Search',
      afterDrop.searched === true && afterDrop.label !== 'Search',
      JSON.stringify(afterDrop));
    check('the words that stayed keep their tallies',
      afterDrop.numbers === 1, JSON.stringify(afterDrop));
    check('and only the removed word loses its marks',
      afterDrop.forDropped === 0 && afterDrop.marks > 0, JSON.stringify(afterDrop));
  });

  // ---------- search, redact, export ----------
  //
  // Search or Redact, and Export beside it. They are separate buttons rather
  // than one that renames itself, so nothing under the pointer changes
  // meaning mid-press -- but only the one whose turn it is is on screen:
  // both at once read as two things to do at once, in a row whose whole job
  // is to say what to do next.
  // Marks used to appear the instant a word was typed, which put an
  // outline on the page while the reviewer was still typing — showing a
  // half-typed word's matches as if they were an answer.
  await part("search, redact, export", async () => {
    const state = () => page.evaluate(() => ({
      label: document.getElementById('apply').textContent.trim(),
      canSearch: !document.getElementById('search').disabled,
      canRedact: !document.getElementById('apply').disabled,
      green: document.getElementById('apply').classList.contains('done'),
      red: document.getElementById('search').classList.contains('hunt'),
      // The circles the red is supposed to be answering — every one of them,
      // the detectors included: each of those wears a red ? until a search
      // has run, and the button is what answers them.
      marks: document.querySelectorAll(
        '.termcounts .n.unknown, .templates .n.unknown, .kind .n.unknown').length,
      words: document.querySelectorAll('.termcounts .n.unknown').length,
      searched: window.Blinded.state.searched,
      applied: window.Blinded.state.applied,
      drawn: window.Blinded.state.pages.reduce(
        (n, p) => n + window.Blinded.activeBoxes(p).length, 0),
      exportOff: document.getElementById('export').disabled,
      showing: ['search', 'apply', 'export']
        .filter(id => !document.getElementById(id).hidden),
    }));

    await newFile();
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    // What a detector is ticked to is the reviewer's, and it is kept from one
    // document to the next — so a suite that has ticked them earlier has to
    // put them back before asking what a fresh panel looks like.
    await noDetectors(page);

    const opened = await state();
    check('a document opens asking to be searched, not redacted',
      opened.canSearch === true && opened.canRedact === false,
      JSON.stringify(opened));
    check('and shows the one button whose turn it is, with Export beside it',
      opened.showing.join() === 'search,export', JSON.stringify(opened));
    // Nothing typed and no detector ticked, so there is no red ? anywhere and
    // nothing for a red button to be about. An alarm raised over nothing
    // teaches the reviewer to stop reading it.
    check('a freshly opened document asks nothing of its own',
      opened.marks === 0 && opened.words === 0, JSON.stringify(opened));
    check('so the button is not red', opened.red === false, JSON.stringify(opened));

    // Ticking a detector is the same act as typing a word: a question nothing
    // has answered yet, on the row and on the button.
    const tickedKind = await page.evaluate(async () => {
      const box = document.querySelector('.kind input[data-kind="email"]');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      const out = {
        marks: document.querySelectorAll('.kind .n.unknown').length,
        red: document.getElementById('search').classList.contains('hunt'),
        unknown: window.Blinded.unknownKinds(),
      };
      const again = document.querySelector('.kind input[data-kind="email"]');
      again.checked = false;
      again.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      out.afterUntick = document.querySelectorAll('.kind .n.unknown').length;
      out.redAfter = document.getElementById('search').classList.contains('hunt');
      return out;
    });
    check('ticking a detector puts a red ? on its row',
      tickedKind.marks === 1 && tickedKind.unknown === 1, JSON.stringify(tickedKind));
    check('and turns the button red to answer it',
      tickedKind.red === true, JSON.stringify(tickedKind));
    check('unticking it takes the question back',
      tickedKind.afterUntick === 0 && tickedKind.redAfter === false,
      JSON.stringify(tickedKind));

    await setTerms(page, ["Jane"]);
    await page.waitForTimeout(400);
    const typed = await state();
    check('typing a word marks nothing on the page',
      typed.drawn === 0, JSON.stringify(typed));
    check('and Search is still the button that is live',
      typed.canSearch === true && typed.canRedact === false
      && typed.searched === false, JSON.stringify(typed));
    // The note counts them by showing the mark, not by describing it: "2 red ?
    // marks above" asks the reviewer to translate a sentence back into a thing
    // on the panel.
    {
      const note = await page.evaluate(() => {
        const el = document.getElementById('exportnote');
        const mark = el.querySelector('.qmark');
        const s = mark && getComputedStyle(mark);
        const circle = s && document.querySelector('.termcounts .n.unknown');
        return {
          text: el.textContent.trim(),
          mark: mark && mark.textContent,
          round: s && parseFloat(s.borderRadius) >= 9,
          ink: s && s.color,
          fill: s && s.backgroundColor,
          panelInk: circle && getComputedStyle(circle).color,
          panelFill: circle && getComputedStyle(circle).backgroundColor,
          // Where its middle sits against the middle of the words beside it.
          // A fixed nudge in pixels had it hanging low.
          offset: (() => {
            if (!mark) return null;
            const probe = document.createElement('span');
            probe.textContent = 'above';
            mark.after(probe);
            const m = mark.getBoundingClientRect();
            const p = probe.getBoundingClientRect();
            probe.remove();
            return Math.round(((m.top + m.height / 2) - (p.top + p.height / 2)) * 10) / 10;
          })(),
        };
      });
      check('the note beside the button shows the mark itself',
        note.mark === '?' && note.round === true, JSON.stringify(note));
      check('painted like the ones on the panel it is counting',
        note.ink === note.panelInk && note.fill === note.panelFill,
        JSON.stringify(note));
      check('and no longer spells out "? marks" in words',
        !/\?\s*marks?/i.test(note.text), note.text);
      check('sitting on the same middle as the words beside it',
        note.offset !== null && Math.abs(note.offset) <= 1, String(note.offset));
    }

    // Now there is a red ? beside the word, and the button that answers it
    // wears the same red.
    check('a word nothing has looked for puts a red ? on the panel',
      typed.words === 1 && typed.marks === opened.marks + 1, JSON.stringify(typed));
    check('and turns the button red to match it',
      typed.red === true, JSON.stringify(typed));

    await page.click('#search');
    await page.waitForFunction(() => window.Blinded.state.searched === true,
      undefined, { timeout: 240000 });
    await page.waitForFunction(settled(),
      undefined, { timeout: 240000 });
    const found = await state();
    check('searching proposes what it found', found.drawn > 0, JSON.stringify(found));
    check('but covers nothing yet', found.applied === false, JSON.stringify(found));
    check('and Redact is the button that is live now',
      found.canRedact === true && found.canSearch === false && !found.green,
      JSON.stringify(found));
    // And Search has gone with its turn. A dead Search beside a live Redact
    // is a row saying "do this, and also do not do that".
    check('and it has taken Search\'s place rather than sitting beside it',
      found.showing.join() === 'apply,export', JSON.stringify(found));
    check('the red ? is answered, so neither it nor the red button remains',
      found.marks === 0 && found.red === false, JSON.stringify(found));
    check('the export stays shut until it is redacted',
      found.exportOff === true, JSON.stringify(found));

    // After a search has read the pages, ticking detectors is answered from
    // what is already in hand — not another red ? waiting on Search.
    const afterAll = await page.evaluate(async () => {
      const box = document.getElementById('kinds-all');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      const unknowns = [...document.querySelectorAll('.kind .n.unknown')]
        .map(n => n.textContent.trim());
      const greens = [...document.querySelectorAll('.kind .n.dot-green')]
        .filter(n => n.textContent.trim() !== '');
      return {
        unknowns,
        greenCount: greens.length,
        unknownKinds: window.Blinded.unknownKinds(),
        counted: window.Blinded.state.countedKinds.slice(),
        ocrRead: window.Blinded.state.ocrRead,
      };
    });
    check('ticking all detectors after a search does not leave red ? tallies',
      afterAll.unknowns.length === 0 && afterAll.unknownKinds === 0,
      JSON.stringify(afterAll));
    check('and shows green match counts instead',
      afterAll.greenCount > 0 && afterAll.counted.length > 0,
      JSON.stringify(afterAll));

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
    // Against what was on the page when it was covered, not against a count
    // taken before the detectors above were ticked: those added marks of
    // their own, and comparing across that change asks whether uncovering
    // undid somebody else's decision.
    check('the marks are still there, just not covered',
      back.drawn === covered.drawn, JSON.stringify({ back, covered }));
    check('and the button offers to redact once more',
      back.label === 'Redact' && back.green === false, JSON.stringify(back));
    // Stepping back out must not need the search run again.
    check('stepping back does not undo the search',
      back.searched === true, JSON.stringify(back));

    // Not the same class, the same colour: the button is supposed to be the
    // circle's red, and a hex typed twice is a hex that drifts.
    {
      await setTerms(page, ["Zebediah"]);
      await page.waitForTimeout(400);
      // Off the button: the last click left the pointer on it, and hover is a
      // darker red than the one being compared.
      await page.mouse.move(5, 300);
      const paint = await page.evaluate(() => {
        const circle = document.querySelector('.termcounts .n.unknown');
        // Search wears the red now: it is the button that answers the mark.
        const button = document.getElementById('search');
        return circle
          ? { ink: getComputedStyle(circle).color,
              fill: getComputedStyle(button).backgroundColor }
          : null;
      });
      check('the button is painted in the question mark\'s own red',
        paint && paint.ink === paint.fill, JSON.stringify(paint));
    }

    // Changing what to look for is a different question, so the answer goes.
    await setTerms(page, ["Jane", "Amphitheatre"]);
    await page.waitForTimeout(400);
    const changed = await state();
    check('editing the words puts Search back in play',
      changed.canSearch === true && changed.searched === false,
      JSON.stringify(changed));
    // The words' marks go; the detectors' stay.
    //
    // What a change invalidates is the answer to the question that changed.
    // Editing the word list un-answers the words — nothing typed has been
    // looked for at this spelling — and says nothing about the email address
    // a detector found, which is still there and still found.
    const whatWent = await page.evaluate(() => {
      const B = window.Blinded;
      let words = 0;
      let kinds = 0;
      for (const p of B.state.pages) {
        for (const box of B.activeBoxes(p)) {
          const isWord = p.hits.some(h => h.finding.term
            && h.rects.some(r => Math.abs(r.x - box.x) < 2 && Math.abs(r.y - box.y) < 2));
          if (isWord) words++; else kinds++;
        }
      }
      return { words, kinds };
    });
    check('and takes the old marks off the page',
      whatWent.words === 0, JSON.stringify(whatWent));
    check('while what the detectors found stays where it is',
      whatWent.kinds > 0, JSON.stringify(whatWent));
  });

  // ---------- marked in red, then covered in black ----------
  //
  // Nothing is covered until Redact is pressed. Before it, a mark is outlined
  // so the reviewer can still read what is about to disappear — which is the
  // whole point of reviewing, and impossible once it is filled in.
  //
  // Searching first, because nothing at all is drawn before that: the marks
  // this checks the colour of do not exist until the reviewer asks for them.
  await useDetectors(page);
  await page.evaluate(async () => { await window.Blinded.runSearch(); });
  await page.waitForFunction(() => window.Blinded.state.searched === true,
    undefined, { timeout: 240000 });
  const sample = () => page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => h.finding.kind === 'email');
    const r = hit.rects[0];
    const ctx = p.canvas.getContext('2d');
    // The canvas shows the page at whatever size it is displayed, which is
    // smaller than the page. A rect in the page's own pixels has to be scaled
    // to find the pixel that draws it.
    const k = p.canvas.width / p.source.width;
    const mid = ctx.getImageData(Math.round((r.x + r.w / 2) * k),
      Math.round((r.y + r.h / 2) * k), 1, 1).data;
    // The outline is about a pixel wide on screen, and which pixel it lands on
    // depends on rounding. Scanned across the left edge rather than guessed
    // at: the strongest colour in that run is the stroke.
    const y = Math.round((r.y + r.h / 2) * k);
    const from = Math.max(0, Math.round(r.x * k) - 2);
    const run = ctx.getImageData(from, y, 6, 1).data;
    let edge = [run[0], run[1], run[2]];
    for (let i = 0; i < run.length; i += 4) {
      if (run[i + 1] - run[i] > edge[1] - edge[0]) {
        edge = [run[i], run[i + 1], run[i + 2]];
      }
    }
    return { mid: [mid[0], mid[1], mid[2]], edge, applied: window.Blinded.state.applied };
  });

  const unapplied = await sample();
  check('a document opens in review, with nothing applied', unapplied.applied === false);
  check('a marked box is not blacked out before Redact',
    !(unapplied.mid[0] === 0 && unapplied.mid[1] === 0 && unapplied.mid[2] === 0), JSON.stringify(unapplied.mid));
  // Green, not red. A proposed redaction is the tool doing what it was asked,
  // and a page of red boxes over someone's document reads as a page of errors.
  check('it is tinted green instead',
    unapplied.mid[1] > unapplied.mid[0] + 8 && unapplied.mid[1] > unapplied.mid[2] + 4,
    JSON.stringify(unapplied.mid));
  check('and outlined in green',
    unapplied.edge[1] > unapplied.edge[0] + 30 && unapplied.edge[1] > unapplied.edge[2] + 20,
    JSON.stringify(unapplied.edge));
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
    const hit = p.hits.find(h => h.finding.text === '+14155550132');
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

  // Hover on the tool already in use used to grey it out, because :hover is a
  // pseudo-class and outran the attribute selector that paints the selection.
  // Pointing at the selected tool then looked like deselecting it.
  {
    const paint = async id => {
      await page.hover('#' + id);
      return page.evaluate(name => {
        const s = getComputedStyle(document.getElementById(name));
        return { bg: s.backgroundColor, ink: s.color,
                 on: document.getElementById(name).getAttribute('aria-pressed') };
      }, id);
    };
    const held = await paint('tool-pan');      // the one that is selected
    const idle = await paint('tool-mark');     // the one that is not
    await page.mouse.move(5, 400);
    const atRest = await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById('tool-pan'));
      return { bg: s.backgroundColor, ink: s.color };
    });
    check('hovering the tool in use leaves it blue and white',
      held.on === 'true' && held.ink === 'rgb(255, 255, 255)'
        && held.bg !== idle.bg, JSON.stringify({ held, idle }));
    check('and only a shade off what it looks like at rest',
      held.bg !== atRest.bg && held.ink === 'rgb(255, 255, 255)',
      JSON.stringify({ held, atRest }));
    check('while hovering an unselected one still greys it',
      idle.on === 'false' && idle.bg === 'rgb(238, 241, 246)',
      JSON.stringify(idle));
  }

  // Four icons in a 320px panel. Words did not fit: the row overflowed and the
  // last controls could only be reached by scrolling sideways, which is how
  // this was reported. Sizes are asserted rather than eyeballed.
  const bar = await page.evaluate(() => {
    // Scoped to the head: the Organise section has a joined icon bar of its
    // own now, and a bare .tools query counts both.
    const tools = document.querySelector('.panel-head .tools').getBoundingClientRect();
    const panel = document.querySelector('.panel').getBoundingClientRect();
    const ids = ['tool-pan', 'tool-mark', 'zoom-out', 'zoom-in', 'undo',
                 'savedraft'];
    const buttons = ids.map(id => document.getElementById(id));
    return {
      count: document.querySelectorAll('.panel-head .tools .tool').length,
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
  // Nor when picking a logo. The button that enters that mode says what it
  // does and the cursor changes; a sentence under the toolbar restating it was
  // one more thing on screen.
  const picking = await page.evaluate(() => {
    const B = window.Blinded;
    B.setMode('pick');
    const shown = { hidden: document.getElementById('tip').hidden,
                    text: document.getElementById('tip').textContent.trim() };
    B.setMode('box');
    return shown;
  });
  check('and says nothing when picking a logo either',
    picking.hidden === true && picking.text === '', JSON.stringify(picking));

  // Both halves of what the tool does, in the reviewer's words: a box drawn by
  // hand, and a box taken off again. It used to say "draw a box to redact
  // selection, click box to undo", which described the gesture rather than
  // the job.
  check('the crosshair says what it is for instead',
    /mark/i.test(chrome.markTitle), chrome.markTitle);
  check('and that it takes marks off as well as putting them on',
    /unmark/i.test(chrome.markTitle), chrome.markTitle);

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
    const hit = p.hits.find(h => h.finding.kind === 'url');
    const r = hit.rects[0];
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.source.width;
    const x = rect.left + (r.x + r.w / 2) * sx;
    const y = rect.top + (r.y + r.h / 2) * (rect.height / p.source.height);
    for (const type of ['pointerdown', 'pointerup']) {
      p.canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1 }));
    }
    return p.dismissed.size;
  });
  check('clicking a detection dismisses it', clicked === before + 1, before + ' -> ' + clicked);
  // The panel's running total is gone — every number in it was already beside
  // the thing it counted. What a dismissal has to do is stop the mark being
  // covered, which is checked on the page itself rather than in a summary.
  check('a dismissed detection stops counting towards the redaction',
    await page.evaluate(() => {
      const p = window.Blinded.state.pages[0];
      const live = window.Blinded.activeBoxes(p).length;
      const all = p.hits.length + p.manual.length;
      return live < all;
    }));

  // ---------- a dismissed mark keeps its own colour ----------
  //
  // Dashed is what says "not going to be covered". Everything dismissed was
  // also being redrawn amber, which is the colour the second check
  // uses — so clicking a green mark off turned it into something that looked
  // like a different kind of find.
  await part("a dismissed mark keeps its own colour", async () => {
    // Counts the outline colours in the band along a box's edge, read back
    // off the canvas, because the colour of a line is not in any variable.
    const band = () => page.evaluate(() => {
      const p = window.Blinded.state.pages[0];
      const hit = p.hits.find(h => p.dismissed.has(h.finding.id));
      if (!hit) return null;
      const r = hit.rects[0];
      const k = p.canvas.width / p.source.width;
      const pad = Math.ceil(4 * k);
      const x = Math.max(0, Math.round(r.x * k) - pad);
      const y = Math.max(0, Math.round(r.y * k) - pad);
      const w = Math.min(p.canvas.width - x, Math.round(r.w * k) + pad * 2);
      const h = Math.min(p.canvas.height - y, Math.round(r.h * k) + pad * 2);
      const px = p.canvas.getContext('2d').getImageData(x, y, w, h).data;
      // Near the exact ink, not merely warm or cool. A looser rule counted
      // the page's own brown-black lettering as amber, so the check could
      // never have gone to zero and was asserting nothing.
      const near = (r0, g0, b0) => (red, g, b) =>
        Math.abs(red - r0) < 40 && Math.abs(g - g0) < 40 && Math.abs(b - b0) < 40;
      const isGreen = near(17, 138, 78);     // MARK_GREEN
      const isAmber = near(217, 139, 31);    // what the second check uses
      let green = 0, amber = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (isGreen(px[i], px[i + 1], px[i + 2])) green++;
        else if (isAmber(px[i], px[i + 1], px[i + 2])) amber++;
      }
      return { green, amber };
    });

    const off = await band();

    // And once the rest are covered, it is not on the page at all: the page
    // is now what the file will be, and the file has no mark here.
    // Covered directly rather than through the button: the button's meaning
    // depends on whether a search has been run, and this block has not run
    // one. What is being checked is what drawPage does with state.applied.
    await page.evaluate(() => {
      window.Blinded.state.searched = true;
      window.Blinded.coverMarks();
    });
    const covered = await band();

    // The reading with the outline gone is the baseline: whatever ink the
    // page itself has in this band is in both readings, so what the outline
    // contributed is the difference between them.
    check('a dismissed mark is outlined in the colour it was found in',
      off && covered && off.green - covered.green > 20,
      JSON.stringify({ off, covered }));
    check('and adds nothing in the colour the second check uses',
      off && covered && off.amber === covered.amber,
      JSON.stringify({ off, covered }));
    check('and once Redact is pressed the dashed outline goes',
      covered && covered.green === 0, JSON.stringify(covered));
    check('without the area under it being covered',
      await page.evaluate(() => {
        const p = window.Blinded.state.pages[0];
        const hit = p.hits.find(h => p.dismissed.has(h.finding.id));
        return !window.Blinded.activeBoxes(p).some(b => b.x === hit.rects[0].x
          && b.y === hit.rects[0].y);
      }));
    // Back to a proposal, which is what the checks below expect to find.
    await page.evaluate(() => {
      window.Blinded.uncoverMarks();
      window.Blinded.state.searched = false;
      window.Blinded.redrawAll();
    });
  });

  const restored = await page.evaluate(() => {
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => p.dismissed.has(h.finding.id));
    const r = hit.rects[0];
    const rect = p.canvas.getBoundingClientRect();
    const x = rect.left + (r.x + r.w / 2) * (rect.width / p.source.width);
    const y = rect.top + (r.y + r.h / 2) * (rect.height / p.source.height);
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
    const sx = rect.width / p.source.width;
    const sy = rect.height / p.source.height;
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
  await part("asking before the document is thrown away", async () => {
    const pagesOpen = () => page.evaluate(() => window.Blinded.state.pages.length);
    const opened = await pagesOpen();
    check('a document is open to be lost', opened > 0, String(opened));

    await page.click('#reset-top');
    const asked = await page.isVisible('#confirmbox');
    check('opening another file asks first', asked === true);
    const wording = await page.textContent('#confirmbody');
    check('and says what is at stake', /cannot be undone/i.test(wording || ''), wording);
    check('including that nothing has been exported yet',
      /not exported/i.test(wording || ''), wording);
    // The destructive button must not be the one a stray Enter presses.
    const focused = await page.evaluate(() => document.activeElement
      && document.activeElement.id);
    // The way out is the cross in the corner now, not a worded Cancel button.
    // What must not change is which control the keyboard lands on: a stray
    // Enter must not be the thing that loses the document.
    check('and the way out holds the focus, not the destructive one',
      focused === 'confirmx', String(focused));

    await page.click('#confirmx');
    const afterCancel = await pagesOpen();
    check('cancelling keeps the document', afterCancel === opened,
      JSON.stringify({ opened, afterCancel }));
    check('and the review is still on screen',
      (await page.isVisible('#view-review')) === true);

    // Escape is the same answer as Cancel.
    await page.click('#reset-top');
    await page.waitForSelector('#confirmbox:not([hidden])', { timeout: 15000 });
    await page.keyboard.press('Escape');
    check('escape cancels too', (await pagesOpen()) === opened);

    // So is a press on the dimmed page behind the box. It has to cancel and
    // not confirm: a stray tap must never be the thing that loses a document.
    await page.click('#reset-top');
    await page.waitForSelector('#confirmbox:not([hidden])', { timeout: 15000 });
    await page.evaluate(() => {
      const box = document.getElementById('confirmbox');
      box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 61 }));
    });
    await page.waitForTimeout(80);
    check('pressing outside the box cancels', (await pagesOpen()) === opened
      && (await page.isVisible('#confirmbox')) === false,
      JSON.stringify({ opened, now: await pagesOpen() }));

    // But a press inside it is not outside it.
    await page.click('#reset-top');
    await page.waitForSelector('#confirmbox:not([hidden])', { timeout: 15000 });
    await page.evaluate(() => {
      document.querySelector('#confirmbox .busy-inner')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 62 }));
    });
    await page.waitForTimeout(80);
    check('but a press inside it leaves the question standing',
      (await page.isVisible('#confirmbox')) === true);

    // The way out that keeps the work, offered beside the way that loses it.
    const offered = await page.evaluate(() => {
      const save = document.getElementById('confirmsave');
      const yes = document.getElementById('confirmyes');
      return {
        shown: save.hidden === false,
        says: save.textContent.trim(),
        red: yes.textContent.trim(),
        // Left of the red one, and after Cancel.
        before: save.compareDocumentPosition(yes) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false,
      };
    });
    check('the reset question offers to save a draft',
      offered.shown === true && offered.says === 'Save draft & close file',
      JSON.stringify(offered));
    check('with the closing button beside it, named for what it does',
      offered.red === 'Close file' && offered.before === true, JSON.stringify(offered));

    // Armed before the click and awaited after it. Waiting for the download
    // first only blocks until the timeout, because nothing has asked for one
    // yet — and no catch around it, so a save that never happens fails here
    // rather than a line later with the reason gone.
    const saving = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#confirmsave');
    const draft = await saving;
    check('and saving one writes a draft before closing',
      /\.json$/i.test(draft.suggestedFilename()), draft.suggestedFilename());
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    check('then closes the document', (await pagesOpen()) === 0);

    // Put a document back for what follows.
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    // And confirming actually does it.
    await page.click('#reset-top');
    await page.waitForSelector('#confirmbox:not([hidden])', { timeout: 15000 });
    await page.click('#confirmyes');
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    check('confirming closes the document', (await pagesOpen()) === 0);
    check('and the question goes away with it',
      (await page.isVisible('#confirmbox')) === false);

    // With nothing open there is nothing to ask about, and a prompt that
    // always fires is one people learn to click through.
    await page.evaluate(() => document.getElementById('reset-top').click());
    check('with no document open it does not ask',
      (await page.isVisible('#confirmbox')) === false);

    // Put a document back for the tests that follow.
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
  });

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
  for (const secret of ['jane.doe@example.com', 'key=abc123', '555-0132', 'Jane Doe', 'Helvetica']) {
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
    (await page.textContent('#picklabel')).trim() === 'Cancel',
    await page.textContent('#picklabel'));

  // Picking happens on the document, not in the panel, and the dimming says
  // so — what is lit is what you can use. A sentence used to say it and
  // nobody read it.
  const dimmed = await page.evaluate(() => {
    const lit = sel => {
      const n = document.querySelector(sel);
      return n ? Number(getComputedStyle(n).zIndex) : null;
    };
    const veil = getComputedStyle(document.body, '::before');
    return {
      on: document.body.classList.contains('picking'),
      veilShown: veil.content !== 'none',
      stage: lit('.stage'),
      images: lit('#imagesect'),
      // The bar along the bottom is dimmed with everything else.
      bar: lit('.exportbar'),
    };
  });
  check('picking dims the page', dimmed.on === true && dimmed.veilShown === true,
    JSON.stringify(dimmed));
  check('the document stays lit', dimmed.stage > 0, JSON.stringify(dimmed));
  check('and so does the section it was started from',
    dimmed.images > 0, JSON.stringify(dimmed));
  check('the bar along the bottom is dimmed too',
    !(dimmed.bar > dimmed.stage), JSON.stringify(dimmed));

  // The row itself reads like the box a word is typed into, because it asks
  // the same kind of question.
  const shaped = await page.evaluate(() => {
    const row = document.getElementById('pick');
    const field = row.querySelector('.pickfield');
    const go = row.querySelector('.pickgo');
    const termInput = document.getElementById('termbox');
    const termGo = document.getElementById('termgo');
    const near = (a, b) => Math.abs(a - b) <= 3;
    const box = n => n.getBoundingClientRect();
    return {
      sameWidth: near(box(row).width, box(termInput).width + box(termGo).width),
      sameHeight: near(box(field).height, box(termInput).height),
      buttonSameWidth: near(box(go).width, box(termGo).width),
      hasPlus: !!go.querySelector('svg'),
    };
  });
  check('the image row is shaped like the word row',
    shaped.sameWidth && shaped.sameHeight && shaped.buttonSameWidth,
    JSON.stringify(shaped));
  check('and carries a plus of its own', shaped.hasPlus === true,
    JSON.stringify(shaped));

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
    const sx = rect.width / p.source.width;
    const sy = rect.height / p.source.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 9,
    }));
    send('pointerdown', cx, cy);
    send('pointermove', cx + cw, cy + ch);
    send('pointerup', cx + cw, cy + ch);
  }, first);

  // A drag on the page no longer becomes a template on its own: what was drawn
  // at reviewing size is a few dozen pixels, where a box that clips the mark
  // looks exactly like one that fits, and a pick four pixels out is the
  // difference between finding every copy and finding two.
  await page.waitForSelector('#cropbox:not([hidden])', { timeout: 30000 });
  const crop = await page.evaluate(() => {
    const view = document.getElementById('cropview');
    return {
      shown: !document.getElementById('cropbox').hidden,
      drawn: view.width > 0 && view.height > 0,
      // Bigger than the pick, because the surroundings are shown too and the
      // whole thing is scaled up.
      wide: view.getBoundingClientRect().width,
      size: document.getElementById('cropsize').textContent,
      // Not blank: the page really is painted into it.
      inked: (() => {
        const d = view.getContext('2d').getImageData(0, 0, view.width, view.height).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) return true;
        }
        return false;
      })(),
    };
  });
  check('a pick is shown back before it is used', crop.shown === true, JSON.stringify(crop));
  check('with the page actually painted into it, not an empty box',
    crop.inked === true, JSON.stringify(crop));
  check('and it says how big the pick is',
    /\d+ by \d+ pixels/.test(crop.size), crop.size);
  check('no template is made until it is confirmed',
    await page.evaluate(() => window.Blinded.state.templates.length) === 0);

  // The corners are the point of showing it: a pick four pixels out is the
  // difference between finding every copy and finding two.
  const dragged = await page.evaluate(async () => {
    const view = document.getElementById('cropview');
    const r = view.getBoundingClientRect();
    const read = () => document.getElementById('cropsize').textContent;
    const before = read();
    const send = (type, cx, cy) => view.dispatchEvent(new PointerEvent(type, {
      clientX: cx, clientY: cy, bubbles: true, pointerId: 77,
    }));
    // Take hold of the top-left handle and pull it outwards.
    send('pointerdown', r.left + 1, r.top + 1);
    await new Promise(done => setTimeout(done, 10));
    send('pointermove', r.left + 1, r.top + 1);
    send('pointerup', r.left + 1, r.top + 1);
    return { before, after: read() };
  });
  check('dragging a corner changes the box', dragged.before !== dragged.after,
    JSON.stringify(dragged));

  // The corners are painted on the canvas rather than being elements, so
  // nothing carries a cursor of its own: over the picture a crosshair says
  // "draw a box", and over a corner that is wrong — the corner is for picking
  // up. Without this the handles were draggable and looked exactly like the
  // rest of the canvas, which is the whole reason they were missed.
  const cursors = await page.evaluate(async () => {
    const view = document.getElementById('cropview');
    const r = view.getBoundingClientRect();
    const send = (type, cx, cy) => view.dispatchEvent(new PointerEvent(type, {
      clientX: cx, clientY: cy, bubbles: true, pointerId: 78,
    }));
    send('pointermove', r.left + r.width / 2, r.top + r.height / 2);
    const overPicture = view.style.cursor;
    send('pointermove', r.left + 1, r.top + 1);
    const overCorner = view.style.cursor;
    send('pointerdown', r.left + 1, r.top + 1);
    const whileHeld = view.style.cursor;
    send('pointermove', r.left + 6, r.top + 6);
    const whileDragging = view.style.cursor;
    send('pointerup', r.left + 6, r.top + 6);
    await new Promise(done => setTimeout(done, 10));
    send('pointermove', r.left + r.width / 2, r.top + r.height / 2);
    const afterwards = view.style.cursor;
    return { overPicture, overCorner, whileHeld, whileDragging, afterwards };
  });
  check('over the picture the cursor draws a box',
    cursors.overPicture === 'crosshair', JSON.stringify(cursors));
  check('over a corner it offers to pick it up',
    cursors.overCorner === 'grab', JSON.stringify(cursors));
  check('and while the corner is held it is holding it',
    cursors.whileHeld === 'grabbing' && cursors.whileDragging === 'grabbing',
    JSON.stringify(cursors));
  check('then goes back to drawing once the corner is let go',
    cursors.afterwards === 'crosshair', JSON.stringify(cursors));

  // Cancelling leaves nothing behind, which is what makes the dialog safe to
  // open: a look at the pick costs nothing.
  await page.click('#cropcancel');
  await page.waitForTimeout(200);
  check('cancelling a pick makes no template',
    await page.evaluate(() => window.Blinded.state.templates.length) === 0);
  check('and puts the dialog away',
    await page.evaluate(() => document.getElementById('cropbox').hidden) === true);

  // Whatever shape the pick is, and however narrow the window.
  //
  // The sizing fitted the width only and forced the zoom to at least 1, so a
  // wide pick was laid out wider than the stage: max-width then shrank the
  // width and left the height alone. The mark came out squashed, and every
  // corner ended up somewhere other than where it was drawn — which is why
  // they could not be grabbed at all. A tall pick had the opposite problem and
  // pushed the buttons off the bottom of a phone.
  {
    const shapes = await page.evaluate(async () => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      const out = [];
      for (const pick of [
        { x: 40, y: 40, w: 300, h: 60 },     // wide and short
        { x: 40, y: 40, w: 60, h: 300 },     // tall and narrow
        { x: 40, y: 40, w: 160, h: 160 },    // square
      ]) {
        const promise = B.confirmCrop(p, pick);
        await new Promise(r => setTimeout(r, 60));
        const view = document.getElementById('cropview');
        const r = view.getBoundingClientRect();
        const use = document.getElementById('cropuse').getBoundingClientRect();

        // What the canvas is painting: the pick plus its margin, clamped to
        // the page. Its shape is what the box on screen must have.
        const pad = { x: pick.w * 0.6, y: pick.h * 0.6 };
        const ax = Math.max(0, pick.x - pad.x), ay = Math.max(0, pick.y - pad.y);
        const aw = Math.min(p.source.width - ax, pick.w + pad.x * 2);
        const ah = Math.min(p.source.height - ay, pick.h + pad.y * 2);

        // And the corner really is where the pointer has to go for it.
        const before = document.getElementById('cropsize').textContent;
        const send = (type, cx, cy) => view.dispatchEvent(new PointerEvent(type, {
          clientX: cx, clientY: cy, bubbles: true, pointerId: 61,
        }));
        send('pointerdown', r.left + 3, r.top + 3);
        send('pointermove', r.left + 28, r.top + 22);
        send('pointerup', r.left + 28, r.top + 22);
        const after = document.getElementById('cropsize').textContent;

        document.getElementById('cropcancel').click();
        await promise;
        out.push({
          pick: pick.w + 'x' + pick.h,
          shown: +(r.width / r.height).toFixed(3),
          want: +(aw / ah).toFixed(3),
          onScreen: use.bottom <= window.innerHeight && use.top >= 0,
          fits: r.width <= window.innerWidth,
          grabbed: before !== after,
        });
      }
      return out;
    });
    for (const s of shapes) {
      check('a ' + s.pick + ' pick keeps its shape on screen',
        Math.abs(s.shown - s.want) < 0.02, JSON.stringify(s));
      check('and its corners are where the pointer has to go for them',
        s.grabbed === true, JSON.stringify(s));
      check('and the button that accepts it can be reached',
        s.onScreen === true && s.fits === true, JSON.stringify(s));
    }
  }
  check('and it still reports a size', /\d+ by \d+ pixels/.test(dragged.after),
    dragged.after);


  // Draw it again, and take it this time.
  await page.evaluate(({ x, y, size }) => {
    window.Blinded.setTool('mark');
    const p = window.Blinded.state.pages[0];
    const S = 2, PAD = 3;
    const cx = x * S - PAD;
    const cy = (792 - y - size) * S - PAD;
    const rect = p.canvas.getBoundingClientRect();
    const sx = rect.width / p.source.width;
    const sy = rect.height / p.source.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 10,
    }));
    send('pointerdown', cx, cy);
    send('pointermove', cx + size * S + PAD * 2, cy + size * S + PAD * 2);
    send('pointerup', cx + size * S + PAD * 2, cy + size * S + PAD * 2);
  }, first);
  await page.waitForSelector('#cropbox:not([hidden])', { timeout: 30000 });
  await page.click('#cropuse');
  await page.waitForFunction(() => window.Blinded.state.templates.length === 1, undefined, { timeout: 60000 });
  check('confirming makes the template', true);
  check('picking a logo does not search on its own',
    await page.evaluate(() => window.Blinded.state.templates[0].searched) === false);
  // A red question mark, not a dash and not a zero: nothing has looked yet,
  // and that is a different thing from having looked and found nothing.
  check('and the panel says so with a question mark',
    (await page.textContent('#templates .n')).trim() === '?',
    await page.textContent('#templates'));
  check('marked as unanswered rather than as a count',
    await page.evaluate(() =>
      !!document.querySelector('#templates .n.unknown')));
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
  // The thumbnail is 42 pixels wide — enough to tell two picks apart, not
  // enough to check that the right thing was picked.
  const bigger = await page.evaluate(() => {
    const B = window.Blinded;
    const template = B.state.templates[0];
    const thumb = document.querySelector('#templates canvas');
    const closed = document.getElementById('imagebox').hidden;
    thumb.click();
    const shot = document.getElementById('imagefull');
    const out = {
      closed,
      open: !document.getElementById('imagebox').hidden,
      // Bigger than the thumbnail, and drawn rather than left blank.
      thumbWidth: thumb.width,
      shownWidth: shot.width,
      note: document.getElementById('imagenote').textContent,
      // Which page it came from, which a template did not used to record —
      // so a draft could say where a logo was but not what it was cut out of.
      pageIndex: template.pageIndex,
      inked: (() => {
        const data = shot.getContext('2d').getImageData(0, 0, shot.width, shot.height).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) return true;
        }
        return false;
      })(),
    };
    document.getElementById('imageclose').click();
    out.closedAgain = document.getElementById('imagebox').hidden;
    return out;
  });
  check('the picked image is not shown full size until it is asked for',
    bigger.closed === true, JSON.stringify(bigger));
  check('clicking the thumbnail shows it', bigger.open === true, JSON.stringify(bigger));
  check('and larger than the thumbnail was',
    bigger.shownWidth > bigger.thumbWidth, JSON.stringify(bigger));
  check('with the image actually drawn in it, not an empty box',
    bigger.inked === true, JSON.stringify(bigger));
  check('it says which page the image came from',
    /from page \d+/.test(bigger.note), bigger.note);
  check('which means a template records the page it was cut from',
    typeof bigger.pageIndex === 'number', JSON.stringify(bigger));
  check('and it closes again', bigger.closedAgain === true, JSON.stringify(bigger));

  // A search that found things used to say nothing at all, so the slider was
  // a dial with no reading: move it, re-run, count the boxes, guess again.
  // Then it said far too much — a paragraph about where the scores fell, read
  // past rather than read. What a reviewer needs is the two or three places
  // this bar could stand and what each would find.
  const wheel = await page.evaluate(() => {
    const pips = [...document.querySelectorAll('#templates .barpip')];
    return pips.map(pip => ({
      tag: pip.tagName,
      now: pip.classList.contains('now'),
      best: pip.classList.contains('best'),
      bar: (pip.querySelector('b') || {}).textContent,
      count: (pip.querySelector('i') || {}).textContent,
    }));
  });
  check('a finished image search offers the settings its scores allow',
    wheel.length >= 1 && wheel.length <= 3, JSON.stringify(wheel));
  check('each one reading as a bar and what it would find',
    wheel.every(pip => /^\d\.\d\d$/.test(pip.bar || '')
      && /^\d+ match(es)?$/.test(pip.count || '')), JSON.stringify(wheel));
  // Where it stands now is a readout, not an offer: a control that does
  // nothing is a control the reviewer stops trusting.
  check('exactly one of them is the setting in use, and it cannot be pressed',
    wheel.filter(pip => pip.now).length === 1
    && wheel.every(pip => (pip.now ? pip.tag === 'SPAN' : pip.tag === 'BUTTON')),
    JSON.stringify(wheel));
  // Left to right by how strict they are, the way the slider runs. A row whose
  // order changed with the answer would be a row nobody could learn.
  check('and they run from the loosest setting to the strictest',
    wheel.every((pip, i) => i === 0 || Number(pip.bar) > Number(wheel[i - 1].bar)),
    JSON.stringify(wheel));
  check('and at most one of them is singled out as the recommendation',
    wheel.filter(pip => pip.best).length <= 1, JSON.stringify(wheel));
  // Ordinarily the same circle: the search puts the bar where the scores say,
  // so the setting in use is the recommended one unless the reviewer has
  // moved it.
  check('which after a search is the setting the search chose',
    wheel.filter(pip => pip.best).every(pip => pip.now), JSON.stringify(wheel));
  check('and they are actually on screen',
    await page.isVisible('#templates .barwheel'));
  // On the row of the image it is about: with three picked images the reviewer
  // has to be able to tell which settings belong to which picture, and a
  // sentence underneath was one indent away from belonging to the row below.
  check('in the row of the image it belongs to', await page.evaluate(() => {
    const wheel = document.querySelector('#templates .barwheel');
    const row = wheel && wheel.closest('li');
    // The thumbnail is a canvas cut from the page, not an <img>.
    return Boolean(row && (row.querySelector('canvas') || row.querySelector('img')));
  }));


  // Opened while picking, which is when a reviewer most wants it: they are
  // about to draw a second box and want to see what the first one caught.
  // Picking dims the whole page except the document and the Images section,
  // and the full-size view was being drawn behind that dimming — visible as a
  // darkened, unreadable copy of the thing it was opened to show.
  {
    const above = await page.evaluate(() => {
      const B = window.Blinded;
      B.setMode('pick');
      document.querySelector('#templates canvas').click();
      const box = document.getElementById('imagebox');
      const shot = document.getElementById('imagefull');
      const r = shot.getBoundingClientRect();
      const at = document.elementFromPoint(
        Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      const layer = node => {
        for (let n = node; n && n !== document.body; n = n.parentElement) {
          const z = getComputedStyle(n).zIndex;
          if (z !== 'auto') return Number(z);
        }
        return 0;
      };
      const out = {
        open: !box.hidden,
        // The dimming is drawn by body.picking::before. What has to be true is
        // simpler than reading that rule: the thing under the pointer at the
        // middle of the image is the image.
        hitsTheImage: at === shot || shot.contains(at),
        boxLayer: layer(box),
        sectionLayer: layer(document.getElementById('imagesect')),
      };
      document.getElementById('imageclose').click();
      B.setMode('box');
      return out;
    });
    check('the full-size view opens while picking', above.open === true,
      JSON.stringify(above));
    check('and nothing is drawn over it', above.hitsTheImage === true,
      JSON.stringify(above));
    check('because it sits above the dimming, not under it',
      above.boxLayer > above.sectionLayer, JSON.stringify(above));
  }

  // The number is the answer; "found 4 times" beside a 4 said it twice.
  check('the picked logo is listed with its count',
    (await page.textContent('#templates .n')).trim() === '4',
    await page.textContent('#templates'));
  const imageWhere = await page.evaluate(() => {
    const B = window.Blinded;
    const before = document.querySelectorAll('#templates .tallyspot').length;
    document.querySelector('#templates button.n').click();
    const rows = [...document.querySelectorAll('#templates .tallyspot')];
    const shown = rows.map(r => r.textContent.trim());
    document.querySelector('#templates button.n').click();
    const after = document.querySelectorAll('#templates .tallyspot').length;
    return { before, open: rows.length, shown, after,
             listed: B.placesFor(B.state.templates[0].id).length };
  });
  check('a picked image lists where it was found, like a word does',
    imageWhere.before === 0 && imageWhere.open === imageWhere.listed
      && imageWhere.open > 0, JSON.stringify(imageWhere));
  check('each one names its page',
    imageWhere.shown.every(s => /^Page \d+/.test(s)), JSON.stringify(imageWhere.shown));
  // Not "as a picture": every row in this list was found as a picture, so it
  // said nothing. What it scored is the number the slider has to be set
  // against, and the weakest row on the list is where to set it.
  check('and says what each one scored',
    imageWhere.shown.every(s => /^Page \d+\d\.\d\d$/.test(s)),
    JSON.stringify(imageWhere.shown));
  check('pressing it again closes the list', imageWhere.after === 0,
    JSON.stringify(imageWhere));

  check('and does not repeat it in words',
    !/found \d+ times/.test(await page.textContent('#templates')),
    await page.textContent('#templates'));

  // The listing is not the deliverable — the pixels are. Preview and export
  // share activeBoxes(), so a black centre here is a black centre in the file.
  const logoPainted = await page.evaluate(() => {
    const p = window.Blinded.state.pages[1];
    const m = p.imageHits[0];
    const k = p.canvas.width / p.source.width;
    const d = p.canvas.getContext('2d').getImageData(
      Math.round((m.rect.x + m.rect.w / 2) * k),
      Math.round((m.rect.y + m.rect.h / 2) * k), 1, 1).data;
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
    const x = rect.left + (m.rect.x + m.rect.w / 2) * (rect.width / p.source.width);
    const y = rect.top + (m.rect.y + m.rect.h / 2) * (rect.height / p.source.height);
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
      clientX: rect.left + px * (rect.width / p.source.width),
      clientY: rect.top + py * (rect.height / p.source.height),
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
    const sx = rect.width / p.source.width;
    const sy = rect.height / p.source.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 41,
    }));
    // Empty margin near the foot of the page.
    send('pointerdown', 200, 1400);
    send('pointermove', 400, 1500);
    send('pointerup', 400, 1500);
  });
  await page.waitForSelector('#cropbox:not([hidden])', { timeout: 30000 });
  await page.click('#cropuse');
  await page.waitForFunction(() => window.Blinded.state.templates.length > 0,
    undefined, { timeout: 30000 });
  await redact(page);
  // The report belongs to the image it is about, so it is on that image's
  // row. It used to be one line under the pick button that every picked
  // image shared, which meant the third search overwrote the second.
  await page.waitForFunction(
    () => document.querySelector('#templates .imgnote.warnhint') !== null,
    { timeout: 120000 });
  const hint = await page.textContent('#templates .imgnote.warnhint');
  check('picking blank page reports that nothing was found',
    hint.includes('Nothing resembling'), hint);
  check('and the empty pick adds no matches',
    await page.evaluate(() => window.Blinded.state.pages
      .reduce((n, p) => n + p.imageHits.filter(m => m.templateId === 'tpl2').length, 0)) === 0);

  // Clear that one away so the counts below describe the real logo only.
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#templates li button');
    rows[rows.length - 1].click();
  });

  // Removing the template withdraws its matches entirely.
  await page.click('#templates .templatedrop');
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
  // The detectors are off until asked for, and this block is about what they
  // contribute to the legend.
  await useDetectors(page);
  await page.waitForTimeout(400);

  check('the legend is hidden until labelling is on', await page.isHidden('#legendbox'));

  // A placeholder stands for something a search has actually found. Nothing
  // is labelled before one has run — a legend built out of unsearched guesses
  // would be naming things nobody has looked for yet.
  await page.click('#search');
  await page.waitForFunction(() => window.Blinded.state.searched === true,
    undefined, { timeout: 240000 });
  await page.waitForFunction(settled(),
    undefined, { timeout: 240000 });
  await dismissSweepOffer(page);
  await reveal(page, 'labelling');
  await page.check('#labelling');
  check('turning labelling on reveals the legend', await page.isVisible('#legendbox'));

  const legendRows = await page.evaluate(() =>
    window.Blinded.state.labels.entries.map(e => [e.label, e.count]));
  check('the legend suggests a placeholder for every distinct thing',
    legendRows.length >= 4, JSON.stringify(legendRows));
  check('the typed name is suggested as a person',
    legendRows.some(([label]) => label === 'P1'), JSON.stringify(legendRows));
  // PC1 was here, for a postal code. That detector is gone: a five-digit
  // number needed a country or a state beside it before it was safe to
  // propose, which is a detector asking the document to introduce it.
  //
  // PH1 was here too, for the fixture's "(415) 555-0132". The phone detector
  // now proposes only +country-code numbers, because OCR of chart labels and
  // currency blobs invented the local forms constantly. The fixture still
  // carries that line; nothing marks it.
  check('the detectors get their own kinds',
    ['E1', 'U1', 'A1'].every(want =>
      legendRows.some(([label]) => label === want)), JSON.stringify(legendRows));
  check('every suggested placeholder is short enough for a narrow bar',
    legendRows.every(([label]) => label.length <= 4), JSON.stringify(legendRows));

  // A label is painted into the bar, in white on the black.
  const labelPainted = await page.evaluate(() => {
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => h.finding.kind === 'email');
    const r = hit.rects[0];
    const ctx = p.canvas.getContext('2d');
    const k = p.canvas.width / p.source.width;
    const strip = ctx.getImageData(Math.round(r.x * k), Math.round((r.y + r.h / 2) * k),
      Math.max(1, Math.round(r.w * k)), 1).data;
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
  // No legend page. It was a ticked checkbox nobody untucked, and it wrote a
  // page describing the redaction into the redacted file — the key, which is
  // downloaded separately and warns about itself, is the place for that.
  check('the export is the document and nothing appended to it',
    labelledDoc.numPages === 1, labelledDoc.numPages + ' pages');

  let extracted = '';
  for (let n = 1; n <= labelledDoc.numPages; n++) {
    const p2 = await labelledDoc.getPage(n);
    extracted += (await p2.getTextContent()).items.map(i => i.str).join(' ') + ' ';
  }
  check('the placeholders are extractable as real text',
    extracted.includes('[CLAIMANT]') && extracted.includes('[E1]'), extracted.slice(0, 200));
  check('and carries no legend describing itself',
    !extracted.includes('Redaction legend'), extracted.slice(-300));
  // The placeholders are still machine-readable, which was the other
  // checkbox: it was ticked, and turning it off made the labels a picture of
  // themselves. That is not a trade anyone was choosing on purpose.
  check('placeholders are still written as real text, without being asked',
    extracted.includes('[CLAIMANT]'), extracted.slice(0, 200));

  // The whole safety argument, checked against the finished bytes rather than
  // against intentions: everything the labels replaced must be absent.
  const labelledRaw = Buffer.from(labelledBytes).toString('latin1');
  for (const secret of ['Jane Doe', 'jane.doe@example.com', 'key=abc123',
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
      // What the word's own tally says, which is where the count lives now.
      tally: (document.querySelector('#termcounts .dot-green') || {}).textContent,
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
  // ---------- one mark per place, however often the page says it ----------
  //
  // A deck exported to PDF can carry the same text run many times over,
  // stacked at identical coordinates. Measured on one page of a real one: the
  // word was there six times to a reader and thirty-two times in the text
  // layer, one spot carrying eleven copies of itself. Every copy is a true
  // find, so none is wrong — but they are one occurrence, and the reviewer got
  // one box drawn eleven times and eleven identical page numbers to check.
  await part("one mark per place, however often the page says it", async () => {
    const place = await page.evaluate(() => {
      const B = window.Blinded;
      const box = (x, y, w, h) => ({ x, y, w, h });
      const hit = (id, rect) => ({ finding: { id, kind: 'term' }, rects: rect ? [rect] : [] });
      const same = box(100, 100, 50, 20);

      return {
        // The measured case: one spot, many copies.
        stacked: B.onePerPlace([
          hit('a', same), hit('b', { ...same }), hit('c', { ...same }),
        ]).length,
        // A pixel or two apart is still the same word in the same place.
        nudged: B.onePerPlace([
          hit('a', same), hit('b', box(101, 100, 50, 20)),
        ]).length,
        // Two real occurrences on the same line are two marks.
        apart: B.onePerPlace([
          hit('a', same), hit('b', box(200, 100, 50, 20)),
        ]).length,
        // A word inside a bigger box at the same corner is not the same word:
        // this is why it asks both ways round rather than once.
        nested: B.onePerPlace([
          hit('a', same), hit('b', box(100, 100, 160, 40)),
        ]).length,
        // A finding with no box on the page still counts, and the tally says
        // where it is — dropping it would lose a redaction.
        boxless: B.onePerPlace([hit('a', null), hit('b', null)]).length,
      };
    });
    check('the same word stacked on itself is marked once',
      place.stacked === 1, JSON.stringify(place));
    check('and a pixel of drift does not make it two',
      place.nudged === 1, JSON.stringify(place));
    check('while two real occurrences stay two',
      place.apart === 2, JSON.stringify(place));
    check('and a word inside a larger box is not swallowed by it',
      place.nested === 2, JSON.stringify(place));
    check('and a finding with no box on the page is never dropped',
      place.boxless === 2, JSON.stringify(place));
  });

  // ---------- but a bigger mark is not a duplicate of a smaller one ----------
  //
  // Reported on a deck carrying a company lockup: the word "VinaCapital" and
  // the VinaCapital logo were both redacted, and the logo was not covered on
  // any page. The word's mark sat inside the logo's, and "already covered" was
  // being asked as a fraction of whichever box was smaller — so a perfect
  // overlap, so all four logo matches were dropped as duplicates of the word.
  // The panel said "4 matches" and the tally said 0, and on the page the
  // wordmark was covered while the red triangle beside it stayed showing.
  await part("but a bigger mark is not a duplicate of a smaller one", async () => {
    const both = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      const kept = p.imageHits.slice();
      const word = p.hits.find(h => h.rects && h.rects.length);
      if (!word) return { skip: true };
      const inner = word.rects[0];
      // A mark around the word and a good deal more, which is what a logo
      // containing a wordmark looks like.
      const around = { x: inner.x - inner.w * 0.4, y: inner.y - inner.h * 0.3,
                       w: inner.w * 1.9, h: inner.h * 1.7 };
      // And one drawn all but on top of the word, which really is the same find.
      const onTop = { x: inner.x + 1, y: inner.y, w: inner.w, h: inner.h };
      p.imageHits = [
        { id: 'lockup', templateId: 'tplX', rect: around, score: 1 },
        { id: 'same', templateId: 'tplX', rect: onTop, score: 1 },
      ];
      B.markDuplicates();
      const out = {
        lockup: p.imageHits.find(m => m.id === 'lockup').superseded,
        same: p.imageHits.find(m => m.id === 'same').superseded,
      };
      p.imageHits = kept;
      B.markDuplicates();
      return out;
    });
    if (!both.skip) {
      check('a mark that covers more than the word inside it survives',
        both.lockup === false, JSON.stringify(both));
      check('while one drawn on top of that word is still the same find',
        both.same === true, JSON.stringify(both));
    }
  });

  // The tally beside the word is the count now, and a duplicate suppressed on
  // the page must not reappear as a number in the panel.
  check('so the panel counts the word once, not twice',
    Number(doubled.tally) === doubled.text,
    JSON.stringify({ tally: doubled.tally, text: doubled.text,
                     pictures: doubled.pictures }));

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
  // Only after a search: before one the word wears a question mark, because
  // "not found" is an answer and nothing has looked.
  check('the term carries a question mark until something looks',
    (await page.textContent('#termcounts')).includes('?'),
    await page.textContent('#termcounts'));
  await redact(page);
  // Once something has looked, the tally is an answer either way — a number
  // or "not found", never blank and never still a question mark. Here the
  // reading finds the word the text layer could not, which is the whole point
  // of this fixture.
  check('which the term list reports rather than leaving blank',
    /^(not found|\d+)$/.test(
      (await page.textContent('#termcounts .n')).trim()),
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
    // One mark from the shape check, so both circles are represented.
    p.imageHits.push({ id: 'sweep:x', term, rect: { x: 80, y: 900, w: 90, h: 24 },
      score: 1, bySweep: true });
    B.renderTermCounts();

    const closed = document.querySelectorAll('#termcounts .tallyspot').length;
    const green = document.querySelector('#termcounts .dot-green');
    const amber = document.querySelector('#termcounts .dot-shape');
    const counts = { green: green && green.textContent.trim(),
                     amber: amber && amber.textContent.trim() };

    green.click();
    const greenRows = [...document.querySelectorAll('#termcounts .tallyspot')];
    const colourOf = row => getComputedStyle(row.querySelector('.dot')).backgroundColor;
    const fromReading = { rows: greenRows.length,
      shapes: greenRows.filter(r => r.classList.contains('shape')).length,
      shown: greenRows.map(r => r.textContent.trim()),
      colours: [...new Set(greenRows.map(colourOf))] };
    green.click();

    amber.click();
    const amberRows = [...document.querySelectorAll('#termcounts .tallyspot')];
    const fromShape = { rows: amberRows.length,
      shapes: amberRows.filter(r => r.classList.contains('shape')).length,
      shown: amberRows.map(r => r.textContent.trim()),
      colours: [...new Set(amberRows.map(colourOf))] };
    amber.click();
    const afterSecond = document.querySelectorAll('#termcounts .tallyspot').length;

    const listed = B.occurrencesFor(term);
    p.imageHits = p.imageHits.filter(m => m.id !== 'sweep:x');
    B.state.openTally = null;
    B.renderTermCounts();
    return { closed, counts, fromReading, fromShape, afterSecond,
             reading: listed.filter(s => s.kind !== 'shape').length,
             shape: listed.filter(s => s.kind === 'shape').length };
  });
  check('the list is not there until a circle is pressed',
    where.closed === 0, JSON.stringify(where));
  // Two circles: green for what the reading found, amber for what the
  // second check added. Adding them together asked the reviewer to
  // hold a distinction the page is at pains to make.
  check('the green circle counts what the reading found',
    Number(where.counts.green) === where.reading, JSON.stringify(where));
  check('and the amber one counts the check separately',
    Number(where.counts.amber) === where.shape && where.shape > 0,
    JSON.stringify(where));
  // The circles count two things and open one list. Each opened half the
  // answer, so a reviewer wanting to know where a word is pressed twice and
  // held the halves apart in their head: "where is this word" has one answer,
  // and the rows already say which pass found which.
  check('either circle opens the whole list, both colours in it',
    where.fromReading.rows === where.reading + where.shape
      && where.fromReading.shapes === where.shape, JSON.stringify(where.fromReading));
  check('and the other circle opens the same list',
    where.fromShape.rows === where.fromReading.rows
      && where.fromShape.shapes === where.fromReading.shapes,
    JSON.stringify(where.fromShape));
  check('each one names its page',
    where.fromReading.shown.every(s => /^Page \d+/.test(s))
      && where.fromShape.shown.every(s => /^Page \d+/.test(s)),
    JSON.stringify(where));
  // Which is what makes one list workable: the row for a mark the reading
  // found and the row for one the check guessed at are not the same colour,
  // because they do not deserve equal trust.
  check('with each row wearing the colour of the pass that found it',
    where.fromReading.colours.length === 2, JSON.stringify(where.fromReading.colours));
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
  await part("drafts", async () => {
    // Started from a known file, so that reopening is the same document and
    // the mismatch guard is exercised deliberately below rather than by
    // accident here.
    await newFile();
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Jane']);

    // Searched before saving, because that is the state a reviewer saves in:
    // words typed, search run, marks on the page. A draft that forgets the
    // search comes back looking empty until the reviewer presses Search again,
    // which is the thing this block guards against below.
    await page.click('#search');
    await page.waitForFunction(() => window.Blinded.state.searched === true,
      undefined, { timeout: 240000 });
    await page.waitForFunction(settled(),
      undefined, { timeout: 240000 });
    await dismissSweepOffer(page);

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
    // Asked properly rather than shouted in red: nothing has gone wrong, the
    // tool just has half of a pair.
    check('it asks for the file the draft belongs to',
      (await page.isVisible('#draftbox')) === true);
    const asks = await page.textContent('#draftbody');
    check('and names the file it wants',
      /choose that file/i.test(asks || '') && /\.pdf/.test(asks || ''), asks);
    check('and says what a draft does and does not hold',
      /not the document/i.test(await page.textContent('#drafthint')));
    check('the front page mentions drafts, quietly',
      /saved draft/i.test(await page.textContent('.drop-faint')),
      await page.textContent('.drop-faint'));

    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await page.waitForTimeout(600);
    const restored = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      return { terms: B.state.terms.slice(),
               manual: p.manual.length,
               sweep: p.imageHits.filter(m => m.bySweep).length,
               searched: B.state.searched,
               counted: B.state.countedTerms.slice(),
               hits: (p.hits || []).length,
               listed: [...document.querySelectorAll('#termcounts .t')]
                 .map(n => n.textContent.trim()) };
    });
    check('the words come back', restored.terms.join() === planted.terms.join(),
      JSON.stringify(restored));
    check('and so does the box the reviewer drew', restored.manual === 1,
      JSON.stringify(restored));
    check('and the marks the shape check had found',
      restored.sweep === 1, JSON.stringify(restored));
    check('and the prompt is gone once the document is open',
      (await page.isVisible('#draftbox')) === false);
    check('and the list of words is back in the panel, not just in the state',
      restored.listed.join() === planted.terms.join(), JSON.stringify(restored));

    // The work comes back done, not ready to be done again. A restored draft
    // that had been searched is searched: the words it had answered are still
    // answered and their marks are on the page, without a second press of
    // Search that the reviewer has no reason to expect.
    check('a restored draft comes back searched',
      restored.searched === true, JSON.stringify(restored));
    check('and remembers which words the search had answered',
      restored.counted.includes(planted.terms[0]), JSON.stringify(restored));
    check('and its text marks are on the page already',
      restored.hits > 0, JSON.stringify(restored));

    // A picked image has to come back too. It never did: a template did not
    // record which page it was cut from, so restoring one skipped every
    // picked image and the Images section came back empty.
    {
      await newFile();
      await page.setInputFiles('#file', logoPath);
      await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
      await page.evaluate(({ x, y, size }) => {
        const B = window.Blinded;
        B.addTemplate(B.state.pages[0],
          { x: x * 2 - 3, y: y * 2 - 3, w: size * 2 + 6, h: size * 2 + 6 });
      }, LOGO_PLACEMENTS[0]);
      await page.waitForFunction(() => window.Blinded.state.templates.length === 1,
        undefined, { timeout: 30000 });

      const [withLogo] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.click('#savedraft'),
      ]);
      const logoDraft = join(tmpdir(), 'blinded-logo.blinded.json');
      await withLogo.saveAs(logoDraft);
      const saved = JSON.parse(readFileSync(logoDraft, 'utf8'));
      check('a draft records which page each picked image came from',
        saved.templates.length === 1
          && typeof saved.templates[0].pageIndex === 'number',
        JSON.stringify(saved.templates));

      await newFile();
      await page.setInputFiles('#file', logoDraft);
      await page.waitForTimeout(300);
      await page.setInputFiles('#file', logoPath);
      await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
      await page.waitForTimeout(600);
      const back = await page.evaluate(() => ({
        templates: window.Blinded.state.templates.length,
        rows: document.querySelectorAll('#templates li').length,
        hasCut: window.Blinded.state.templates.every(t => !!t.cut),
        hasThumb: !!document.querySelector('#templates canvas'),
      }));
      check('and the picked image comes back with the draft',
        back.templates === 1 && back.rows >= 1, JSON.stringify(back));
      check('with its thumbnail, so the Images section is not empty',
        back.hasThumb === true, JSON.stringify(back));
      check('and re-cut from the page, so it can be searched for again',
        back.hasCut === true, JSON.stringify(back));
    }

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
    await page.click('#confirmx');
    const declined = await page.evaluate(() => ({
      manual: window.Blinded.state.pages[0].manual.length,
      terms: window.Blinded.state.terms.length,
    }));
    check('and declining leaves that document untouched',
      declined.manual === 0 && declined.terms === 0, JSON.stringify(declined));
  });

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
    // Found, and found convincingly. Not to a hundredth: the exact figure
    // moves whenever the matcher is tuned, and a test that pins it reports a
    // tuning change as a failure to find the word.
    check('the word is found in ' + row.name,
      row.found && row.score > 0.9,
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
    const sx = rect.width / p.source.width;
    const sy = rect.height / p.source.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 51,
    }));
    send('pointerdown', cx, cy);
    send('pointermove', cx + box.w * S + PAD * 2, cy + box.h * S + PAD * 2);
    send('pointerup', cx + box.w * S + PAD * 2, cy + box.h * S + PAD * 2);
  }, { place: SMALL_LOGO_PLACEMENTS, box: WORDMARK_BOX });

  await page.waitForSelector('#cropbox:not([hidden])', { timeout: 30000 });
  await page.click('#cropuse');
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
    (await page.textContent('#templates .n')).trim() === '3',
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
    const sx = rect.width / p.source.width;
    const sy = rect.height / p.source.height;
    const send = (type, px, py) => p.canvas.dispatchEvent(new PointerEvent(type, {
      clientX: rect.left + px * sx, clientY: rect.top + py * sy, bubbles: true, pointerId: 31,
    }));
    send('pointerdown', cx, cy);
    send('pointermove', cx + cw, cy + ch);
    send('pointerup', cx + cw, cy + ch);
  }, { place: WORDMARK_PLACEMENTS, aspect: WORDMARK_ASPECT });

  await page.waitForSelector('#cropbox:not([hidden])', { timeout: 30000 });
  await page.click('#cropuse');
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
    const sx = rect.width / p.source.width;
    const sy = rect.height / p.source.height;
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
  //
  // A search first: a mark can only be clicked off once something has
  // proposed it, and an unsearched detector proposes nothing — it is not on
  // the page to be clicked.
  await useDetectors(page);
  await page.click('#search');
  await page.waitForFunction(() => window.Blinded.state.searched === true,
    undefined, { timeout: 240000 });
  await page.waitForFunction(settled(),
    undefined, { timeout: 240000 });
  await dismissSweepOffer(page);
  await page.evaluate(() => {
    // Driving the pointer at a page is about marking, so it asks for the
    // tool that marks: dragging moves the pages until told otherwise.
    window.Blinded.setTool('mark');
    const p = window.Blinded.state.pages[0];
    const hit = p.hits.find(h => h.finding.kind === 'email');
    const r = hit.rects[0];
    const rect = p.canvas.getBoundingClientRect();
    const x = rect.left + (r.x + r.w / 2) * (rect.width / p.source.width);
    const y = rect.top + (r.y + r.h / 2) * (rect.height / p.source.height);
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
  // Nothing is marked before a search, here as everywhere: a detector that
  // has not been asked for proposes nothing, and a text file is searched in
  // the same two steps as a document.
  check('and marks nothing until it has been searched',
    await page.locator('#textview mark').count() === 0);

  await useDetectors(page);
  await page.click('#search');
  await page.waitForFunction(() => window.Blinded.state.searched === true,
    undefined, { timeout: 120000 });
  await dismissSweepOffer(page);
  const marks = await page.locator('#textview mark').count();
  // The phone number is no longer among them: the detector proposes only
  // +country-code forms now, and the fixture's "(415) 555-0132" is a local
  // one.
  check('the text view marks the email, the number and the address',
    marks === 3, String(marks));

  await setTerms(page, ["Jane Doe"]);
  await page.click('#search');
  await page.waitForFunction(() => window.Blinded.state.searched === true,
    undefined, { timeout: 120000 });
  await dismissSweepOffer(page);
  await page.waitForTimeout(200);
  check('a listed term adds a mark in the text view',
    await page.locator('#textview mark').count() === 4,
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
  check('the redacted text no longer holds the phone number',
    !redacted.includes('7946 0958'), redacted);
  // Said plainly, because it is a deliberate trade and the wrong way round
  // for a redaction tool to make quietly: a local number without a country
  // code is not proposed, and a reviewer who wants it covered types it into
  // the words.
  check('while a local number without a country code is left for the reviewer to type',
    redacted.includes('555-0132'), redacted);
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

  // ---------- each picked image keeps its own bar ----------
  //
  // One slider governed every picked image at once, and it was wrong twice
  // over: a clean wordmark that matches at 0.85 and a scanned signature that
  // needs 0.60 cannot both be set right by one number, and moving it to tune
  // the stubborn one threw away the finished results for all the others.
  //
  // The control is no longer a slider. It is the two or three settings the
  // scores themselves point at, drawn as circles in the row: a hundred values
  // of which only a few are measurable was a hundred ways to be wrong, and
  // asking somebody to pick a number before anything is known is asking them
  // to overrule a measurement that has not been taken.
  await part("each picked image keeps its own bar", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await page.evaluate(() => {
      const B = window.Blinded;
      B.state.termImages = false;        // picked images only, no reading
      B.addTemplate(B.state.pages[0], { x: 40, y: 40, w: 120, h: 120 });
      B.addTemplate(B.state.pages[0], { x: 200, y: 40, w: 120, h: 120 });
    });
    await page.waitForTimeout(200);

    // Before any search these rows show a red "?" and no settings at all:
    // there is nothing yet for a setting to be a setting about.
    const beforeSearch = await page.evaluate(() => ({
      pips: document.querySelectorAll('.templates .barpip').length,
      heading: !document.getElementById('senshead').hidden,
      asking: [...document.querySelectorAll('.templates .n')].every(n =>
        n.textContent.trim() === '?'),
    }));
    check('an image not yet searched for shows no setting to choose',
      beforeSearch.pips === 0 && beforeSearch.heading === false,
      JSON.stringify(beforeSearch));
    check('only the red question mark that says so',
      beforeSearch.asking === true, JSON.stringify(beforeSearch));
    await redact(page);

    const rows = await page.evaluate(() => ({
      wheels: document.querySelectorAll('.templates .barwheel').length,
      most: Math.max(...[...document.querySelectorAll('.templates .barwheel')]
        .map(w => w.querySelectorAll('.barpip').length)),
      heading: !document.getElementById('senshead').hidden,
      // Between the thumbnail on the left and the tally on the right, which
      // is where they were asked for.
      between: [...document.querySelectorAll('.templates li:not(.imgnote):not(.tally)')]
        .every(li => {
          const kids = [...li.children];
          const thumb = kids.findIndex(k => k.tagName === 'CANVAS');
          const bar = kids.findIndex(k => k.classList.contains('rowsens'));
          const tally = kids.findIndex(k => k.classList.contains('n'));
          const drop = kids.findIndex(k => k.classList.contains('templatedrop'));
          return thumb >= 0 && bar > thumb && tally > bar && drop > tally;
        }),
    }));
    check('every picked image carries settings of its own', rows.wheels === 2,
      JSON.stringify(rows));
    check('in the order thumbnail, settings, tally, remove',
      rows.between === true, JSON.stringify(rows));
    check('under a heading that says what they are', rows.heading === true,
      JSON.stringify(rows));
    // A few, not a hundred. Three is the most the panel will ever offer,
    // because each one has to be measured to be worth offering.
    check('and never more than three of them', rows.most <= 3, JSON.stringify(rows));

    const both = await page.evaluate(() =>
      window.Blinded.state.templates.map(t => t.searched));
    check('both are searched at their own bar', both.every(Boolean),
      JSON.stringify(both));

    // Press a setting on the first image. Only the first image's answer moves.
    const after = await page.evaluate(() => {
      const B = window.Blinded;
      const was = B.state.templates.map(t => B.sensFor(t));
      const wheel = document.querySelectorAll('.templates .barwheel')[0];
      const other = wheel.querySelector('.barpip:not(.now)');
      if (other) other.click();
      return {
        was,
        bars: B.state.templates.map(t => B.sensFor(t)),
        searched: B.state.templates.map(t => t.searched),
        pressed: Boolean(other),
      };
    });
    check('pressing another setting moves that image to it',
      after.pressed && Math.abs(after.bars[0] - after.was[0]) > 0.001,
      JSON.stringify(after));
    // The whole point. The old slider set every one of these back to false.
    check('and leaves every other picked image exactly as it was',
      Math.abs(after.bars[1] - after.was[1]) < 1e-9 && after.searched[1] === true,
      JSON.stringify(after));

    // ---------- a setting pressed by accident is undoable ----------
    //
    // The way back used to be remembering the old number and everything the
    // old number had found.
    const knocked = await page.evaluate(async () => {
      const B = window.Blinded;
      const t = B.state.templates[0];
      t.sens = 0.75;
      t.chosenBar = false;
      t.searched = false;
      await B.runSearch();
      const marks = () => B.state.pages.reduce((n, p) =>
        n + p.imageHits.filter(m => m.templateId === t.id).length, 0);
      const before = { sens: B.sensFor(t), marks: marks(), searched: t.searched };

      const depth = B.undoStack.length;
      const other = document.querySelector('.templates .barwheel .barpip:not(.now)');
      if (other) other.click();
      await new Promise(r => setTimeout(r, 200));
      const after = { sens: B.sensFor(t), marks: marks(),
                      offered: document.getElementById('undo').title,
                      pressable: !document.getElementById('undo').disabled,
                      added: B.undoStack.length - depth };

      B.undoLast();
      const shown = [...document.querySelectorAll('.templates .barwheel')[0]
        .querySelectorAll('.barpip.now b')].map(b => b.textContent)[0];
      const back = { sens: B.sensFor(t), marks: marks(), searched: t.searched, shown };
      return { before, after, back };
    });
    check('pressing a setting is offered as something to undo',
      /sensitivity/i.test(knocked.after.offered) && knocked.after.pressable,
      JSON.stringify(knocked));
    check('as one thing to undo, not one per press of the row',
      knocked.after.added === 1, JSON.stringify(knocked));
    check('it really did move the bar',
      Math.abs(knocked.after.sens - knocked.before.sens) > 0.001,
      JSON.stringify(knocked));
    check('undo puts the setting back',
      Math.abs(knocked.back.sens - knocked.before.sens) < 1e-9,
      JSON.stringify(knocked));
    // The number alone would be a poor undo: the reviewer would have the old
    // setting and an unsearched document.
    check('and what that setting had found',
      knocked.back.marks === knocked.before.marks
        && knocked.back.searched === true, JSON.stringify(knocked));
    check('with the row itself agreeing again',
      knocked.back.shown === knocked.back.sens.toFixed(2), JSON.stringify(knocked));

    // Put back what the later sections expect to find.
    await page.evaluate(() => { window.Blinded.state.termImages = true; });
  });

  // ---------- the two lists of page numbers are one list ----------
  //
  // A picked image's tally and a word's tally open the same thing: where it
  // is, page by page. They were not coming out the same. .templates li sets a
  // padding and a border and lands later in the stylesheet than li.tally, so
  // the image's list was taller with a rule between every line; and
  // `.templates button` was restyling every button under it to 15px, the
  // page numbers included.
  await part("the two lists of page numbers are one list", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    // The state a finished search leaves behind, planted rather than searched
    // for. What is measured below is the markup two renderers produce, and
    // running the reader here would warm it for the pause test further down,
    // which needs it cold enough to be interrupted.
    await page.evaluate(() => {
      const B = window.Blinded;
      const page0 = B.state.pages[0];
      B.state.terms = ['Jane'];
      B.state.countedTerms = ['Jane'];
      B.state.searched = true;
      page0.imageHits.push(
        { id: 'word:1', term: 'Jane', rect: { x: 60, y: 90, w: 80, h: 20 }, score: 1 },
        { id: 'logo:1', templateId: 'planted',
          rect: { x: 200, y: 300, w: 60, h: 60 }, score: 1 });
      B.state.templates.push({
        id: 'planted', cut: null, rect: { x: 40, y: 40, w: 120, h: 120 },
        pageIndex: 0, thumbnail: document.createElement('canvas'),
        sens: 0.75, matches: 1, rawMatches: 1, best: 1, searched: true,
      });
      B.renderTermCounts();
      B.renderTemplates();
    });

  // ---------- the two dropdowns are one dropdown ----------
  //
  // A picked image's list of page numbers came out taller than a word's,
  // with a rule between every line: .templates li sets a padding and a
  // border, lands later in the stylesheet than li.tally, and won. Same
  // markup, same job, two different looks.
  const lists = await page.evaluate(() => {
    const B = window.Blinded;
    const measure = () => {
      const spot = document.querySelector('.tally .tallyspot');
      if (!spot) return null;
      const row = spot.closest('li');
      const s = getComputedStyle(spot);
      const rs = getComputedStyle(row);
      return { size: s.fontSize, pad: s.padding, line: s.lineHeight,
               rowPad: rs.padding, rule: rs.borderBottomWidth,
               height: Math.round(spot.getBoundingClientRect().height) };
    };
    // A word's list...
    B.state.openTally = null;
    B.renderTermCounts();
    const word = (() => {
      const n = document.querySelector('.termcounts button.n:not(:disabled)');
      if (!n) return null;
      n.click();
      return measure();
    })();
    // ...and a picked image's.
    B.state.openTally = null;
    B.renderTermCounts();
    B.renderTemplates();
    const image = (() => {
      const n = document.querySelector('.templates button.n:not(:disabled)');
      if (!n) return null;
      n.click();
      return measure();
    })();
    B.state.openTally = null;
    B.renderTemplates();
    return { word, image };
  });
  check('both sections open a list of page numbers',
    lists.word !== null && lists.image !== null, JSON.stringify(lists));
  check('and the two are the same size, line for line',
    lists.word && lists.image
      && lists.word.size === lists.image.size
      && lists.word.pad === lists.image.pad
      && lists.word.rowPad === lists.image.rowPad
      && lists.word.height === lists.image.height,
    JSON.stringify(lists));
  check('neither puts a rule between the page numbers',
    lists.word && lists.image
      && parseFloat(lists.word.rule) === 0 && parseFloat(lists.image.rule) === 0,
    JSON.stringify(lists));
  // A reference to scan, not a paragraph to read.
  check('and a row is compact enough to run an eye down',
    lists.word && parseFloat(lists.word.size) <= 12
      && lists.word.height <= 22, JSON.stringify(lists));

  // A found count is a found count, whether it counts a word or a logo.
  const badges = await page.evaluate(() => {
    const pick = sel => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const s = getComputedStyle(n);
      return { ink: s.color, fill: s.backgroundColor,
               round: parseFloat(s.borderRadius) >= 12 };
    };
    return { word: pick('.termcounts .n.dot-green'),
             image: pick('.templates .n.dot-green') };
  });
  check('a picked image\'s tally is a green circle too',
    badges.word && badges.image
      && badges.image.ink === badges.word.ink
      && badges.image.fill === badges.word.fill
      && badges.image.round === true,
    JSON.stringify(badges));

  });

  // ---------- what stays usable while a box is being drawn ----------
  //
  // The toolbar was dimmed along with the rest of the panel, so a reviewer who
  // needed a closer look at a small logo had to leave picking, zoom, and start
  // again. Zooming is the one thing picking needs; the other four would each
  // take them somewhere else mid-pick.
  await part("what stays usable while a box is being drawn", async () => {
    const live = await page.evaluate(() => {
      const B = window.Blinded;
      const read = () => {
        const of = id => {
          const el = document.getElementById(id);
          const r = el.getBoundingClientRect();
          const mid = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          return { off: el.disabled, reachable: el === mid || el.contains(mid) };
        };
        return {
          zoomIn: of('zoom-in'), zoomOut: of('zoom-out'),
          pan: of('tool-pan'), mark: of('tool-mark'),
          undo: of('undo'), reset: of('reset-top'), save: of('savedraft'),
          // Shown, not merely un-hidden: on a wide screen the stylesheet keeps
          // it away, because the Cancel in the panel is right there.
          escape: getComputedStyle(document.getElementById('pickstop')).display !== 'none',
        };
      };
      const before = read();
      B.setMode('pick');
      const during = read();
      B.setMode('box');
      return { before, during, after: read() };
    });
    check('zooming stays live while a box is being drawn',
      live.during.zoomIn.off === false && live.during.zoomOut.off === false,
      JSON.stringify(live.during));
    check('and is not behind the dimming either',
      live.during.zoomIn.reachable === true && live.during.zoomOut.reachable === true,
      JSON.stringify(live.during));
    check('the four that would take you elsewhere go quiet',
      live.during.pan.off && live.during.mark.off && live.during.undo.off
        && live.during.reset.off && live.during.save.off,
      JSON.stringify(live.during));
    check('and come back when the pick ends',
      live.after.pan.off === false && live.after.mark.off === false
        && live.after.reset.off === false && live.after.save.off === false,
      JSON.stringify(live.after));
    // Undo is the exception: it goes back to being about whether there is
    // anything to undo, not about picking.
    check('undo goes back to answering its own question',
      live.after.undo.off === live.before.undo.off, JSON.stringify(live));
    // Not on a laptop. The Cancel in the panel is right there and never
    // covered, so a second cross floating over the document was one more thing
    // on screen to explain. The phone, where the panel is a strip down the
    // side while the box is drawn, gets one — checked in its own section.
    check('a laptop is not given a second way out on top of the document',
      live.before.escape === false && live.during.escape === false
        && live.after.escape === false, JSON.stringify(live));
  });

  // ---------- picking on a phone ----------
  //
  // The panel and the document take turns on a narrow screen, and the box has
  // to be drawn on the document. Tapping the button left the reviewer in the
  // panel with nothing they could reach: picking was impossible.
  await part("picking on a phone", async () => {
    const phone = await page.evaluate(() => {
      const B = window.Blinded;
      if (!B.onPhone()) return { narrow: false };
      const out = { narrow: true };
      B.setPane('edit');
      B.setMode('pick');
      out.went = document.body.dataset.pane;
      out.escape = !document.getElementById('pickstop').hidden;
      B.setMode('box');
      out.came = document.body.dataset.pane;
      return out;
    });
    if (phone.narrow) {
      check('picking brings the document forward on a phone',
        phone.went === 'doc', JSON.stringify(phone));
      check('with a way out that is not in the hidden panel',
        phone.escape === true, JSON.stringify(phone));
      check('and finishing brings the panel back',
        phone.came === 'edit', JSON.stringify(phone));
    }
  });

  // ---------- a bar high enough to tell one letter from another ----------
  //
  // Reported on a strategy deck whose footnotes are circular letter badges:
  // picking the F badge also marked every E, at the slider's highest setting.
  // Measured here on the same shape — the circle is most of the tile and only
  // the glyph differs, so the E scores very nearly what the F does. The whole
  // range that separates them was above the old ceiling of 0.95.
  await part("a bar high enough to tell one letter from another", async () => {
    const scores = await page.evaluate(async () => {
      const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
      const R = 18, GAP = 70;
      const c = document.createElement('canvas');
      c.width = GAP * LETTERS.length + 60; c.height = 120;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      const spots = {};
      LETTERS.forEach((ch, i) => {
        const cx = 50 + i * GAP, cy = 60;
        g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
        g.fillStyle = '#1f9ed9'; g.fill();
        g.fillStyle = '#fff';
        g.font = '600 22px Helvetica, Arial, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(ch, cx, cy + 1);
        spots[ch] = { x: cx - R - 3, y: cy - R - 3, w: (R + 3) * 2, h: (R + 3) * 2 };
      });
      const cut = window.BlindedImageSearch.templateFrom(c, spots.F);
      const found = (await window.BlindedImageSearch.searchAllParallel(
        [{ index: 0, source: c }],
        [{ key: 'F', template: cut, threshold: 0.1 }], {}, () => {})).get('F');
      const on = {};
      for (const m of found.matches) {
        for (const [ch, r] of Object.entries(spots)) {
          const ox = Math.max(0, Math.min(r.x + r.w, m.x + m.w) - Math.max(r.x, m.x));
          const oy = Math.max(0, Math.min(r.y + r.h, m.y + m.h) - Math.max(r.y, m.y));
          if ((ox * oy) / (r.w * r.h) > 0.5) on[ch] = Math.max(on[ch] || 0, m.score);
        }
      }
      return on;
    });
    check('the picked badge matches itself', scores.F > 0.99, JSON.stringify(scores));
    // The measurement that sets the ceiling. If this ever falls below 0.95 the
    // old maximum would have been enough and this whole change was unneeded;
    // if it rises above the new one, the ceiling has to go up again.
    check('and the badge beside it scores high enough to be proposed too',
      scores.E > 0.9 && scores.E < 0.99, JSON.stringify(scores));
    check('so no setting below 0.95 can separate them',
      scores.E > 0.93, JSON.stringify(scores));

    const reach = await page.evaluate(() => {
      const B = window.Blinded;
      // The highest bar the panel will ever stand on, found by asking for one
      // past the end: whatever comes back is the ceiling.
      const max = B.sensFor({ sens: 2 });
      return {
        max,
        // And the clamp lets that setting through rather than pulling it back.
        clamped: B.sensFor({ sens: 0.99 }),
        overshoot: B.sensFor({ sens: 2 }),
      };
    });
    check('the settings reach a bar above what the wrong badge scores',
      reach.max !== null && reach.max > scores.E, JSON.stringify({ reach, e: scores.E }));
    check('and that setting survives the clamp',
      Math.abs(reach.clamped - reach.max) < 1e-9, JSON.stringify(reach));
    check('while anything past the end is still held to it',
      Math.abs(reach.overshoot - reach.max) < 1e-9, JSON.stringify(reach));
  });

  // ---------- the bar comes down when it finds nothing ----------
  //
  // A reviewer has no way to know where to put the slider before the first
  // search — 0.75 is a starting point, not an answer — and being told "no
  // match" about a mark that is plainly on the page is the wrong end of the
  // exchange. Every candidate has already been verified at full resolution,
  // so lowering the bar costs nothing: the answer is in hand, on the wrong
  // side of a number.
  await part("the bar comes down when it finds nothing", async () => {
    // Where the bar wants to be, given a set of scores. Two clumps with a gap
    // between them is what a picked mark actually produces.
    const chosen = await page.evaluate(() => {
      const B = window.Blinded;
      return {
        gap: B.barFromScores([0.99, 0.98, 0.97, 0.71, 0.70]),
        single: B.barFromScores([0.88]),
        flat: B.barFromScores([0.91, 0.90, 0.895]),
        floor: B.barFromScores([0.40, 0.38]),
        empty: B.barFromScores([]),
        atFloor: B.AUTO_FLOOR,
      };
    });
    check('the bar lands in the widest gap, above the also-rans',
      chosen.gap > 0.71 && chosen.gap < 0.97, JSON.stringify(chosen));
    check('one candidate puts it just under that one',
      chosen.single < 0.88 && chosen.single > 0.85, JSON.stringify(chosen));
    check('a clump with no real gap keeps the whole clump',
      chosen.flat < 0.895 && chosen.flat > 0.86, JSON.stringify(chosen));
    // Correlation at 0.6 finds something resembling almost anything, and a
    // redaction tool that quietly covers whatever it likes is worse than one
    // that finds nothing and says so.
    check('and nothing drags it below the floor',
      chosen.floor === null && chosen.empty === null, JSON.stringify(chosen));

    // The promotion itself, on the shape a real search hands it. A template
    // cut from a page always matches itself at 1.00, so a document fixture
    // cannot produce the empty result this is about.
    const moved = await page.evaluate(() => {
      const B = window.Blinded;
      const hits = s => s.map((score, i) => ({ score, x: i * 10, y: 0, w: 8, h: 8 }));
      const empty = { matches: [], near: hits([0.94, 0.94, 0.93, 0.71]) };
      const bar = B.settleBar(empty, 0.99);
      const already = { matches: hits([0.96]), near: [] };
      const leftAlone = B.settleBar(already, 0.95);
      const noise = { matches: [], near: hits([0.40, 0.38]) };
      const refused = B.settleBar(noise, 0.75);
      // The other direction, measured on a real document: a 46x46 roundel at
      // 0.75 proposed fifty-six marks, of which two were the logo and the rest
      // were the letter o in body text. The scores say so plainly — two near
      // 1.00, then a plateau in the low 0.80s — and the bar belongs in the gap.
      const flood = { matches: hits([1, 0.99, 0.84, 0.836, 0.831, 0.828, 0.825, 0.822,
                                     0.82, 0.818, 0.815, 0.812]),
                      near: hits([0.74, 0.73]) };
      const raised = B.settleBar(flood, 0.75);
      // Four copies of a wordmark at four sizes score 1.00, 0.95, 0.88, 0.83:
      // spread out, and every one of them real. The bar goes to the gap here
      // too, which is the trade this makes — see below.
      const spread = { matches: hits([1, 0.95, 0.88, 0.83]), near: hits([0.5]) };
      const spared = B.settleBar(spread, 0.75);
      const steps = B.barSteps([1, 0.99, 0.84, 0.836, 0.831, 0.825, 0.82, 0.818, 0.74], 3);
      return {
        bar,
        promoted: empty.matches.length,
        stillTurnedAway: empty.near.length,
        overlap: empty.matches.filter(m => empty.near.includes(m)).length,
        leftAlone,
        leftAloneMatches: already.matches.length,
        refused,
        raised,
        keptAfterRaise: flood.matches.length,
        droppedByRaise: flood.near.length,
        spared,
        sparedKept: spread.matches.length,
        steps,
      };
    });
    check('a search that found nothing brings the bar down to what it saw',
      moved.bar !== null && moved.bar < 0.94 && moved.bar > 0.62,
      JSON.stringify(moved));
    check('and the candidates it had turned away become the matches',
      moved.promoted === 3, JSON.stringify(moved));
    // Counting them in both halves had the note saying "4 matches, and 4 more
    // were left out" about one set of four.
    check('they move rather than being copied',
      moved.stillTurnedAway === 1 && moved.overlap === 0, JSON.stringify(moved));
    // A clump of copies of one mark scores within a whisker of itself, and
    // there is nothing for the bar to settle into.
    check('a search whose scores hold no gap is left alone',
      moved.leftAlone === null && moved.leftAloneMatches === 1,
      JSON.stringify(moved));
    check('and nothing but noise is still nothing',
      moved.refused === null, JSON.stringify(moved));

    // And the half that Bench 1 asked for: a flood is not a result.
    check('a flood of look-alikes moves the bar up to the gap',
      moved.raised !== null && moved.raised > 0.9 && moved.raised < 0.99,
      JSON.stringify(moved));
    check('and what is left is the two that scored like the mark itself',
      moved.keptAfterRaise === 2 && moved.droppedByRaise === 12,
      JSON.stringify(moved));
    // And it goes there in the ordinary case too, not only against a flood.
    //
    // This was once conservative in one direction — down on its own, up only
    // against overwhelming evidence — on the reasoning that proposing one mark
    // too many costs a moment's reading while withdrawing one costs a
    // redaction. That asymmetry is real, and it is answered somewhere better:
    // the settings beside the slider always name a looser bar and what it
    // would find, including one that takes in everything this bar turned away.
    // A bar that goes back in one press does not lose anything. What the old
    // rule cost was a reviewer left reading fifty-six proposals, two of which
    // were the logo, and then aiming a slider at a number nobody had told them.
    check('and to the gap in the ordinary case as well, not only against a flood',
      moved.spared !== null && moved.spared > 0.75 && moved.sparedKept < 4,
      JSON.stringify(moved));
    // The runners-up, so the reviewer is choosing from a list rather than
    // aiming a slider at a number nobody has told them.
    check('the other places the bar could stand are named, with their counts',
      moved.steps.length >= 2 && moved.steps[0].count === 2
      && moved.steps.every(step => step.bar >= 0.62 && step.count > 0),
      JSON.stringify(moved.steps));
  });

  // ---------- pressing a setting does not search again ----------
  //
  // The circles are built from candidates the search already verified at full
  // resolution, above and below the bar alike. Moving the bar within that set
  // is a filter, not a search, and a reviewer comparing two settings should
  // not be made to wait twice for an answer the tool already has.
  await part("pressing a setting does not search again", async () => {
    const swapped = await page.evaluate(async () => {
      const B = window.Blinded;
      const template = B.state.templates[0];
      if (!template || !template.verified || !template.verified.length) return null;
      const scores = template.verified.map(hit => hit.score).sort((a, b) => b - a);
      const lower = Math.max(B.AUTO_FLOOR,
        Math.floor((scores[scores.length - 1] - 0.005) * 100) / 100);
      const before = { bar: B.sensFor(template), marks: template.matches,
        searched: template.searched };
      const began = Date.now();
      B.moveBarTo(template, lower);
      const took = Date.now() - began;
      const marks = B.state.pages.reduce((n, p) =>
        n + p.imageHits.filter(m => m.templateId === template.id).length, 0);
      // And back again, through undo, which has to put the marks back too.
      B.undoLast();
      const after = { bar: B.sensFor(template), marks: template.matches };
      return { before, took, lower, marks, searched: template.searched,
        canServe: B.answeredAlready(template, lower),
        cannotServeBelow: B.answeredAlready(template, 0.1), after };
    });
    // And what the panel does about it: the setting pressed becomes the one in
    // use, the one it came from stays on offer, and the number promised is the
    // number delivered.
    const pressed = await page.evaluate(async () => {
      const read = () => [...document.querySelectorAll('#templates .barwheel')]
        .flatMap(wheel => [...wheel.querySelectorAll('.barpip')].map(pip => ({
          bar: Number(pip.querySelector('b').textContent),
          count: parseInt(pip.querySelector('i').textContent, 10),
          now: pip.classList.contains('now'),
          canPress: pip.tagName === 'BUTTON',
        })));
      const before = read();
      const target = before.find(pip => !pip.now);
      if (!target) return null;
      const wasOn = before.find(pip => pip.now);
      const button = [...document.querySelectorAll('#templates .barpip')]
        .find(pip => Number(pip.querySelector('b').textContent) === target.bar
          && pip.tagName === 'BUTTON');
      button.click();
      await new Promise(r => setTimeout(r, 300));
      const after = read();
      return { target, wasOn, after,
        nowOn: after.find(pip => pip.now),
        oldStillThere: after.find(pip => Math.abs(pip.bar - wasOn.bar) < 0.005) };
    });
    if (pressed) {
      check('the setting pressed becomes the one in use',
        pressed.nowOn && Math.abs(pressed.nowOn.bar - pressed.target.bar) < 0.005,
        JSON.stringify(pressed));
      check('and it finds what it said it would',
        pressed.nowOn && pressed.nowOn.count === pressed.target.count,
        JSON.stringify(pressed));
      check('while the one it came from stays on offer, and can be pressed',
        Boolean(pressed.oldStillThere) && pressed.oldStillThere.canPress === true
        && pressed.oldStillThere.now === false, JSON.stringify(pressed));
      await page.evaluate(() => window.Blinded.undoLast());
    }

    if (swapped) {
      check('a setting within what was verified is served from it',
        swapped.canServe === true && swapped.cannotServeBelow === false,
        JSON.stringify(swapped));
      check('and pressing it leaves the document searched, not asking again',
        swapped.searched === true, JSON.stringify(swapped));
      check('the marks change at once rather than after a search',
        swapped.marks >= swapped.before.marks && swapped.took < 1500,
        JSON.stringify(swapped));
      check('and undo puts the bar and its marks back',
        Math.abs(swapped.after.bar - swapped.before.bar) < 0.005
        && swapped.after.marks === swapped.before.marks, JSON.stringify(swapped));
    }
  });

  // ---------- looking again where nothing was found ----------
  //
  // The nominating pass proposes a position only if it scores 0.4 on a
  // shrunken page, and only a few dozen positions per page are checked
  // properly. Both are right for an ordinary page and wrong for a hard one:
  // measured on a slide whose wordmark sits in white over a photograph, the
  // true position of "Tokenomics" scored under 0.4 and was never offered for
  // verification — a best of 0.000 for a word plainly on the page.
  //
  // The shortlist part of that has since been measured properly and moved to
  // the check's first pass, where it costs about four percent of the slowest
  // document. What stays here for a word with no mark anywhere is the gate
  // itself: dropping it to 0.22 is what roughly doubles the work, so it is
  // spent only where there is nothing to lose and something to find.
  await part("looking again where nothing was found", async () => {
    const deep = await page.evaluate(async () => {
      const B = window.Blinded;
      const was = B.state.terms.slice();
      B.state.terms = ['Jane', 'Qzzxwvunlikely'];
      await B.runSweep();
      const out = { deepened: (B.state.sweepDeepened || []).slice(),
        found: B.state.pages.reduce((n, p) =>
          n + (p.imageHits || []).filter(m => m.term === 'Jane').length, 0) };
      B.state.terms = was;
      return out;
    });
    check('a word the document holds no mark for is looked for again, harder',
      deep.deepened.includes('Qzzxwvunlikely'), JSON.stringify(deep));
    check('and a word that was found is left alone',
      !deep.deepened.includes('Jane') || deep.found === 0, JSON.stringify(deep));
  });

  // ---------- how long a shortlist each pass works from ----------
  //
  // A page of body text offers hundreds of places that correlate weakly with
  // any long word, so a true copy of a name can sit outside the default
  // shortlist and never be verified. The check works from a longer one. A
  // picked image does not: raising it there was tried on real documents and
  // made image matching worse, so the two must not drift back together.
  await part("how long a shortlist each pass works from", async () => {
    const budgets = await page.evaluate(async () => {
      const IS = window.BlindedImageSearch;
      const real = IS.searchAllParallel;
      const seen = [];
      IS.searchAllParallel = (pages, entries, opts, report) => {
        seen.push({ words: entries.every(e => !e.logo),
          maxCandidates: opts && opts.maxCandidates,
          perScale: opts && opts.perScale,
          verifyLimit: opts && opts.verifyLimit });
        return real(pages, entries, opts, report);
      };
      try {
        const was = window.Blinded.state.terms.slice();
        window.Blinded.state.terms = ['Jane'];
        await window.Blinded.runSweep();
        window.Blinded.state.terms = was;
        await window.Blinded.runSearch();
      } finally {
        IS.searchAllParallel = real;
      }
      return seen;
    });
    const check1 = budgets.find(b => b.words);
    const picked = budgets.find(b => !b.words);
    check('the check works from a longer shortlist than the default',
      Boolean(check1) && check1.maxCandidates === 400 && check1.perScale === 24
      && check1.verifyLimit === 64, JSON.stringify(budgets));
    check('and a picked image keeps the default one',
      !picked || (picked.maxCandidates === undefined
        && picked.perScale === undefined && picked.verifyLimit === undefined),
      JSON.stringify(budgets));
  });

  // ---------- the near miss, offered as a picture under its word ----------
  //
  // The check cannot tell a true copy its bar turned away from a lookalike
  // the bar was right about: measured, the true miss scored 0.600 and the
  // false one 0.628. A person can tell instantly, but only by looking, so the
  // closest the check came is cut out of the page and shown.
  // ---------- the places the page reader can point to ----------
  //
  // Nomination correlates a shrunken page and proposes where a shape might be.
  // What it cannot do is see into artwork, or past a neighbour the reader
  // misread. Measured on a photographed slide: "Middle East (88 stores)" is on
  // the page in plain lettering, the reader drew a box round "Middle" and read
  // the word after it as "China", so the phrase matched nothing in its text
  // and the shape pass never nominated the spot. The reader's box is right
  // even where its reading is wrong, and it hands over the scale as well as
  // the place.
  await part("the places the page reader can point to", async () => {
    const seeds = await page.evaluate(() => {
      const B = window.Blinded;
      const reading = str => ({ str, rect: { x: 100, y: 200, w: 60, h: 14 } });
      const page0 = { index: 0, ocrPlaced: [
        reading('Middle'),          // the word itself
        { str: 'Widdle', rect: { x: 300, y: 400, w: 60, h: 14 } },   // one edit
        { str: 'South', rect: { x: 500, y: 600, w: 60, h: 14 } },    // not it
        { str: 'ME', rect: { x: 700, y: 800, w: 20, h: 14 } },       // too short
      ] };
      const found = B.readerSeedsFor('Middle', [page0]);
      // The other half of a phrase, off the half just matched.
      const partner = B.partnerSeedsFrom(
        { x: 100, y: 200, w: 60, h: 14 }, 0, 'Middle', 'East');
      // A place the document already covers is not a place to look again.
      const covered = { index: 0, hits: [], manual: [],
        imageHits: [{ rect: { x: 95, y: 195, w: 70, h: 20 } }] };
      return {
        saw: found.map(seed => seed.x),
        partnerRight: partner[0],
        partnerUnder: partner[1],
        alreadyThere: B.markedAt(covered, { x: 100, y: 200, w: 60, h: 14 }),
        somewhereElse: B.markedAt(covered, { x: 900, y: 900, w: 60, h: 14 }),
      };
    });
    check('the reader points at the word and at a one-letter misreading of it',
      seeds.saw.length === 2 && seeds.saw[0] === 100 && seeds.saw[1] === 300,
      JSON.stringify(seeds));
    // "South" is the same length as "Middle" and shares nothing else. A rule
    // loose enough to take it would seed half the page.
    check('and not at a word that merely looks about the same size',
      !seeds.saw.includes(500) && !seeds.saw.includes(700),
      JSON.stringify(seeds));
    check('a phrase partner is sought after the word and under it',
      seeds.partnerRight.x > 160 && seeds.partnerRight.y === 200
      && seeds.partnerUnder.x === 100 && seeds.partnerUnder.y > 214,
      JSON.stringify(seeds));
    // Measured off the matched word rather than off a box the reader drew
    // round the wrong one: four letters against six, on the same line.
    check('and sized by how many letters it has',
      Math.abs(seeds.partnerRight.w - 40) < 1
      && seeds.partnerRight.h === 14, JSON.stringify(seeds));
    check('a place the document already covers is not looked at again',
      seeds.alreadyThere === true && seeds.somewhereElse === false,
      JSON.stringify(seeds));
  });

  // ---------- a whole heading does not vouch for one word in it ----------
  //
  // The reader can veto a shape hit: where it has read the spot as something
  // else, the shape matcher does not get to mark it. A host that agrees ends
  // the argument -- asked about "confidential" where the page says
  // CONFIDENTIAL, there is nothing to contradict.
  //
  // But the text layer hands over runs, not words. Measured on a teaser deck
  // looking for "Victory": the run "Victory's Monthly Performance in SEA
  // (Ex-Vietnam)" spans the line, and it was vouching for a shape hit sitting
  // on "(Ex-Vietnam)" at the far end of it, while the reader's own word box
  // there said "(Ex-Vietnam)" at confidence 71 and contradicted. "Vietnam"
  // scores 0.69 against "Victory", over its bar of 0.636, so nothing else was
  // going to stop it: the word was redacted on the page twice.
  await part("a whole heading does not vouch for one word in it", async () => {
    const veto = await page.evaluate(() => {
      const B = window.Blinded;
      const hit = { x: 452, y: 602, w: 55, h: 16 };
      const heading = "Victory\u2019s Monthly Performance in SEA (Ex-Vietnam)";
      const spread = {
        ocrText: '(Ex-Vietnam)',
        ocrPlaced: [{ str: '(Ex-Vietnam)', start: 0, end: 12, confidence: 71,
          rect: { x: 450, y: 600, w: 64, h: 18 } }],
        // One run for the whole line, which is what pdf.js hands over.
        items: [{ str: heading, x: 120, y: 618, w: 400, h: 16 }],
      };
      // The same run with no word-level reading under it: nothing contradicts,
      // so nothing is refused. A veto needs someone to say otherwise.
      const quiet = { ocrText: '', ocrPlaced: [], items: spread.items };
      // And the case the agreement rule exists for: a host the same size as
      // the hit, saying the word, with a longer line across the same spot.
      const agrees = { ocrText: '', ocrPlaced: [], items: [
        { str: 'CONFIDENTIAL', x: 100, y: 118, w: 120, h: 16 },
        { str: 'a longer line of type that crosses the very same place',
          x: 50, y: 118, w: 600, h: 16 },
      ] };
      return {
        spread: B.readerContradicts(spread, hit, 'Victory'),
        quiet: B.readerContradicts(quiet, hit, 'Victory'),
        agrees: B.readerContradicts(agrees,
          { x: 100, y: 102, w: 120, h: 16 }, 'confidential'),
      };
    });
    check('a word the reader read as something else is refused',
      veto.spread === true, JSON.stringify(veto));
    check('even though a run across the line contains the word elsewhere',
      veto.quiet === false, JSON.stringify(veto));
    check('while a host the size of the hit still vouches for it',
      veto.agrees === false, JSON.stringify(veto));
  });

  await part("the near miss, offered as a picture under its word", async () => {
    const offer = await page.evaluate(async () => {
      const B = window.Blinded;
      const wasTerms = B.state.terms.slice();
      const wasSwept = B.state.sweptTerms.slice();
      const wasBest = B.state.sweepBest;
      const wasHits = (B.state.pages[0].imageHits || []).slice();
      const near = { p: 0, x: 40, y: 60, w: 120, h: 20 };
      const only = n => (B.state.pages[0].imageHits || [])
        .filter(m => m.term === 'Ghostword').length;

      B.state.terms = ['Ghostword'];
      B.state.sweptTerms = ['Ghostword'];
      B.state.searched = true;
      B.state.offersDismissed = new Set();
      B.state.sweepBest = { Ghostword: { score: 0.61, verified: true,
        refined: 0.61, part: 'Ghostword', bar: 0.66, at: near } };
      B.renderTermCounts();

      const host = document.getElementById('termcounts');
      const card = host.querySelector('.offer');
      const out = {
        shown: Boolean(card),
        cards: host.querySelectorAll('.offer').length,
        // The word it is about is the row above it: the question and the
        // nought that raised it have to be next to each other.
        underWord: Boolean(card && card.closest('li').previousElementSibling
          && card.closest('li').previousElementSibling
            .querySelector('.t').textContent === 'Ghostword'),
        hasShot: Boolean(card && card.querySelector('canvas.offershot')),
        where: card ? card.querySelector('.offerwhere').textContent : '',
      };

      card.querySelector('.offeryes').click();
      out.marks = only();
      out.amber = (B.state.pages[0].imageHits || [])
        .filter(m => m.term === 'Ghostword').every(m => m.bySweep === true);
      out.goneAfterTake = !document.querySelector('#termcounts .offer');

      B.undoLast();
      out.marksAfterUndo = only();
      out.backAfterUndo = Boolean(document.querySelector('#termcounts .offer'));

      document.querySelector('#termcounts .offerno').click();
      out.goneAfterDrop = !document.querySelector('#termcounts .offer');

      // Nothing verified anywhere is a different answer from a near miss, and
      // has no picture to show.
      B.state.offersDismissed = new Set();
      B.state.sweepBest = { Ghostword: { score: 0, verified: false,
        refined: 0.2, part: 'Ghostword', bar: 0.66, at: null } };
      B.renderTermCounts();
      out.noneText = document.querySelector('#termcounts .offerlead').textContent;
      out.noneHasShot = Boolean(document.querySelector('#termcounts .offer canvas'));
      out.noneHasTake = Boolean(document.querySelector('#termcounts .offeryes'));

      B.state.terms = wasTerms;
      B.state.sweptTerms = wasSwept;
      B.state.sweepBest = wasBest;
      B.state.pages[0].imageHits = wasHits;
      B.state.offersDismissed = new Set();
      B.renderTermCounts();
      B.renderSweep();
      return out;
    });

    check('a word the check placed nowhere is offered as a cut-out',
      offer.shown && offer.cards === 1 && offer.hasShot, JSON.stringify(offer));
    // One row, not three: where it is, then yes and no. The page is the link
    // and the score is the only number a reviewer can act on.
    check('with the page it is on and what it scored',
      /^Page 1 · 0\.61$/.test(offer.where.trim()), JSON.stringify(offer));
    check('accepting it marks the page in amber',
      offer.marks === 1 && offer.amber === true, JSON.stringify(offer));
    check('and the offer goes once the word has a mark',
      offer.goneAfterTake === true, JSON.stringify(offer));
    check('undo takes the mark back off and asks again',
      offer.marksAfterUndo === 0 && offer.backAfterUndo === true,
      JSON.stringify(offer));
    check('turning it down puts the question away',
      offer.goneAfterDrop === true, JSON.stringify(offer));
    check('a word nothing resembled says so, with nothing to accept',
      /Nothing like it was found/.test(offer.noneText)
      && offer.noneHasShot === false && offer.noneHasTake === false,
      JSON.stringify(offer));
  });

  // ---------- what the check looks like while it runs ----------
  //
  // It reports itself in the foot of the page, with the same bars a search
  // draws there. Three things had to stop happening: the amber panel in the
  // panel column stayed up with nothing in it, because its button goes away
  // while the check runs and the run itself had moved to the foot; the line
  // the search left in the foot went on claiming the search was complete
  // while a second one worked; and the check drew a bar of its own with a
  // sentence beside it, which is a second kind of progress bar for the same
  // kind of waiting.
  await part("what the check looks like while it runs", async () => {
    const run = await page.evaluate(async () => {
      const B = window.Blinded;
      const was = B.state.terms.slice();
      // One word the document has and one it does not: the second is placed
      // nowhere, so the check runs its deeper "looking again" pass, which is
      // the phase whose progress line used to be left on screen after the run
      // had finished.
      B.state.terms = ['Jane', 'Zzyzx'];
      const seen = { samples: 0, boxEmpty: 0, legs: 0, stale: 0, sentence: 0,
        deep: 0, later: new Set() };
      const look = () => {
        seen.samples++;
        const box = document.getElementById('sweepbox');
        if (!box.hidden
          && !document.querySelector('.exportbar .checklink')
          && !document.getElementById('sweepnote').textContent.trim()
          ) seen.boxEmpty++;
        const rows = document.querySelectorAll('#sweeprun-legs .leg');
        if (rows.length) seen.legs++;
        if (rows.length > 1) seen.deep++;
        for (const row of rows) {
          const name = row.querySelector('.leg-label span').textContent;
          if (name !== 'Second check') seen.later.add(name);
        }
        const foot = document.getElementById('runfoot');
        const text = document.getElementById('runfoot-text').textContent;
        if (!foot.hidden && /Search complete/.test(text)) seen.stale++;
        if (/Checking page|carry on reviewing/.test(document.body.textContent)) {
          seen.sentence++;
        }
      };
      const running = B.runSweep();
      const poll = setInterval(look, 10);
      look();
      await running;
      clearInterval(poll);
      seen.after = document.getElementById('runfoot-text').textContent;
      seen.afterShown = !document.getElementById('runfoot').hidden;
      seen.runGone = document.getElementById('sweeprun').hidden;
      seen.oldBar = Boolean(document.getElementById('sweepprogress')
        || document.getElementById('sweepfill'));
      seen.deepened = (B.state.sweepDeepened || []).slice();
      // Nothing of the run is left anywhere on the page once it is over.
      seen.leftovers = document.querySelectorAll('#sweeprun-legs .leg').length;
      seen.stillSaysChecking = /Checking page|Looking again/
        .test(document.body.textContent);
      B.state.terms = was;
      // A Set does not survive the trip back out of the page.
      seen.later = [...seen.later];
      return seen;
    });

    check('the check draws the same bars a search does, in the foot',
      run.legs > 0 && run.oldBar === false, JSON.stringify(run));
    check('and no sentence beside them',
      run.sentence === 0, JSON.stringify(run));
    check('the amber panel is never left up empty while it runs',
      run.boxEmpty === 0 && run.samples > 0, JSON.stringify(run));
    check('the search stops claiming to be complete while the check works',
      run.stale === 0, JSON.stringify(run));
    check('and the foot says what the check itself did when it finishes',
      run.afterShown && run.runGone
      && /Second check (complete|stopped)/.test(run.after),
      JSON.stringify(run));
    // The later passes get a bar. One bar for the whole run sat full while
    // the check was plainly still working, which is the bar lying -- and the
    // run can be minutes, so "full but not finished" is a long time to look
    // at. What they do not get is a bar each, naming itself: "looking again
    // where nothing was found" is the tool explaining its own internals to
    // somebody waiting for an answer.
    check('the deeper pass has a bar of its own',
      run.deepened.includes('Zzyzx') && run.deep > 0, JSON.stringify(run));
    check('under one name, whichever later pass is running',
      run.later.length === 1 && run.later[0] === 'Running final checks',
      JSON.stringify(run));
    check('and nothing of it is left on the page once the check is over',
      run.leftovers === 0 && run.stillSaysChecking === false,
      JSON.stringify(run));
  });

  // ---------- what counts as already covered ----------
  //
  // Two questions that were being asked as one. The same word found twice in
  // the same place is a duplicate, and a modest overlap settles it. A
  // different word's mark nearby is not a duplicate — it is a different word —
  // and it only accounts for this one if it actually covers it.
  //
  // Measured: on a photographed slide, "Thailand" was found at 0.724 against a
  // bar of 0.63 and thrown away; on another, all four copies of "ThaiBev" at
  // 0.849 against 0.64. In both the mark that swallowed them belonged to the
  // same word, which is correct — but the rule that let it would equally have
  // let a large mark for one word bury a small candidate for another, because
  // it measured the overlap against whichever box was smaller.
  await part("what counts as already covered", async () => {
    const rules = await page.evaluate(() => {
      const B = window.Blinded;
      const page0 = B.state.pages[0];
      const hits = page0.imageHits;
      const manual = page0.manual;
      page0.imageHits = [{ id: 'x', term: 'Singapore',
        rect: { x: 0, y: 0, w: 200, h: 40 } }];
      page0.manual = [];
      const corner = { x: 180, y: 30, w: 60, h: 20 };
      const within = { x: 20, y: 5, w: 40, h: 20 };
      const out = {
        sameWordAgain: B.alreadyCovered(page0, within, 'Singapore'),
        otherWordClipped: B.alreadyCovered(page0, corner, 'Thailand'),
        otherWordInside: B.alreadyCovered(page0, within, 'Thailand'),
        // The same place by another name: a candidate a few pixels off an
        // existing mark is that mark again, whatever word it carries.
        sameSpot: B.alreadyCovered(page0, { x: 4, y: 2, w: 200, h: 40 }, 'Thailand'),
      };
      page0.imageHits = hits;
      page0.manual = manual;
      return out;
    });
    check('the same word in the same place is one find, not two',
      Boolean(rules.sameWordAgain), JSON.stringify(rules));
    check('another word merely clipped by that mark is not accounted for',
      rules.otherWordClipped === null, JSON.stringify(rules));
    check('but one sitting inside it is',
      Boolean(rules.otherWordInside), JSON.stringify(rules));
    check('and so is one in the very same place',
      Boolean(rules.sameSpot), JSON.stringify(rules));
    check('and what accounts for it is named, not just flagged',
      typeof rules.sameWordAgain === 'string'
      && rules.sameWordAgain.includes('Singapore'), JSON.stringify(rules));
  });

  // ---------- what the second check draws ----------
  //
  // The check looks for a word by drawing it and correlating the picture. What
  // it draws is therefore a real decision, and lower case is the wrong answer:
  // lower-case letterforms are mostly x-height blobs, so "rolex" resembles an
  // enormous amount of ordinary body text. Measured on a six-page deck, the
  // check proposed eight places for it and every one was the word "roles" in
  // "held senior roles with"; the same deck searched for the capitalised form
  // proposed none, and the deck contains no Rolex to miss.
  //
  // Nothing is lost by capitalising: the letters themselves are found by
  // reading the page, which does not care about case, and this check only runs
  // where the reading could not see.
  await part("what the second check draws", async () => {
    const drawn = await page.evaluate(() => {
      const B = window.Blinded;
      return {
        lower: B.sweepCaseOf('rolex'),
        already: B.sweepCaseOf('Rolex'),
        acronym: B.sweepCaseOf('TDTC'),
        mixed: B.sweepCaseOf('iPhone'),
        empty: B.sweepCaseOf(''),
      };
    });
    check('a word typed in lower case is drawn with a capital',
      drawn.lower === 'Rolex', JSON.stringify(drawn));
    check('one that already has a capital is drawn as typed',
      drawn.already === 'Rolex' && drawn.mixed === 'iPhone', JSON.stringify(drawn));
    check('and an acronym is left alone, having plenty of shape already',
      drawn.acronym === 'TDTC' && drawn.empty === '', JSON.stringify(drawn));
  });

  // ---------- the sample slide on the front page ----------
  //
  // Someone deciding whether to hand this a confidential document should be
  // able to see what it produces without handing one over first. At thumbnail
  // size the labels — which are the whole point — are not readable, so it
  // opens.
  await part("the sample slide on the front page", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });

    const shot = await page.evaluate(() => {
      const open = document.querySelector('.galshot');
      if (!open) return null;
      open.scrollIntoView({ block: 'center' });
      const img = open.querySelector('.galred');
      const r = img.getBoundingClientRect();
      return {
        onTheFrontPage: open.closest('#view-drop') !== null,
        drawn: r.width > 0 && r.height > 0,
        // Below the reasons to use it, which is where someone who is still
        // deciding has got to.
        belowTheFeatures: open.getBoundingClientRect().top
          > document.querySelector('.features').getBoundingClientRect().top,
        described: (img.getAttribute('alt') || '').length > 40,
        says: (document.querySelector('.sample-zoom') || {}).textContent,
      };
    });
    check('the front page shows a redacted slide', shot !== null && shot.drawn,
      JSON.stringify(shot));
    check('after the reasons to use it, not before',
      shot && shot.belowTheFeatures === true, JSON.stringify(shot));
    check('with a description for anyone who cannot see it',
      shot && shot.described === true, JSON.stringify(shot));
    check('and it says it can be opened',
      /enlarge|larger|bigger/i.test(shot && shot.says || ''), String(shot && shot.says));

    const big = await page.evaluate(async () => {
      const box = document.getElementById('samplebox');
      const shut = box.hidden;
      document.querySelector('.galshot').click();
      await new Promise(r => setTimeout(r, 150));
      const img = document.getElementById('samplebig').getBoundingClientRect();
      const thumb = document.querySelector('.galshot .galred').getBoundingClientRect();
      return {
        shut, open: !box.hidden,
        // Bigger than the thumbnail it was opened from, or there was no point.
        bigger: img.width > thumb.width,
        // The focus lands on the way out, so a keyboard is not left stranded.
        focused: document.activeElement && document.activeElement.id,
      };
    });
    check('the slide was not open to begin with', big.shut === true, JSON.stringify(big));
    check('clicking it opens it larger',
      big.open === true && big.bigger === true, JSON.stringify(big));
    check('and the focus goes to the way out',
      big.focused === 'sampleclose', JSON.stringify(big));

    // Three ways out, because a picture that traps you is worse than no
    // picture: the button, the key, and the dark around it.
    await page.click('#sampleclose');
    await page.waitForTimeout(120);
    check('the button closes it',
      await page.evaluate(() => document.getElementById('samplebox').hidden) === true);

    await page.click('.galshot');
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    check('Escape closes it',
      await page.evaluate(() => document.getElementById('samplebox').hidden) === true);

    const backdrop = await page.evaluate(async () => {
      const box = document.getElementById('samplebox');
      document.querySelector('.galshot').click();
      await new Promise(r => setTimeout(r, 120));
      box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      const shut = box.hidden;
      // And a click on the picture itself does not, or a drag to read it
      // would keep shutting it.
      document.querySelector('.galshot').click();
      await new Promise(r => setTimeout(r, 120));
      document.getElementById('samplebig').dispatchEvent(
        new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      const stillOpen = !box.hidden;
      box.hidden = true;
      return { shut, stillOpen };
    });
    check('a click on the dark around it closes it', backdrop.shut === true,
      JSON.stringify(backdrop));
    check('while a click on the slide itself leaves it open',
      backdrop.stillOpen === true, JSON.stringify(backdrop));

    // ---------- before and after, and the strip they sit on ----------
    //
    // The redacted half is what the tool did; the original is what it did it
    // to. Either on its own is an assertion — together they are evidence, so
    // the toggle has to actually swap them and the strip has to reach all six.
    const both = await page.evaluate(() => {
      const shot = document.querySelector('.galshot');
      const shown = el => el && getComputedStyle(el).display !== 'none';
      const before = { red: shown(shot.querySelector('.galred')),
                       orig: shown(shot.querySelector('.galorig')) };
      document.getElementById('gal-original').click();
      const after = { red: shown(shot.querySelector('.galred')),
                      orig: shown(shot.querySelector('.galorig')),
                      pressed: document.getElementById('gal-original').getAttribute('aria-pressed'),
                      other: document.getElementById('gal-redacted').getAttribute('aria-pressed') };
      document.getElementById('gal-redacted').click();
      const back = { red: shown(shot.querySelector('.galred')),
                     orig: shown(shot.querySelector('.galorig')) };
      return { before, after, back,
        slides: document.querySelectorAll('.galslide').length,
        pairs: document.querySelectorAll('.galslide .galorig').length };
    });
    check('the gallery holds six slides, each one twice',
      both.slides === 6 && both.pairs === 6, JSON.stringify(both));
    check('it opens on the redacted half, which is what the tool did',
      both.before.red === true && both.before.orig === false, JSON.stringify(both));
    check('Original swaps them, and says which one is showing',
      both.after.orig === true && both.after.red === false
      && both.after.pressed === 'true' && both.after.other === 'false',
      JSON.stringify(both));
    check('and Redacted swaps them back',
      both.back.red === true && both.back.orig === false, JSON.stringify(both));

    // Six slides on a strip is only useful if the other five can be reached.
    const walked = await page.evaluate(async () => {
      const strip = document.getElementById('galstrip');
      strip.scrollLeft = 0;
      await new Promise(r => setTimeout(r, 60));
      const said = () => document.getElementById('gal-count').textContent.trim();
      const start = { where: strip.scrollLeft, said: said(),
        back: document.getElementById('gal-prev').disabled };
      document.getElementById('gal-next').click();
      await new Promise(r => setTimeout(r, 450));
      const moved = { where: strip.scrollLeft, said: said(),
        back: document.getElementById('gal-prev').disabled };
      document.getElementById('gal-prev').click();
      await new Promise(r => setTimeout(r, 450));
      const home = { where: strip.scrollLeft, said: said() };
      // And the end of the strip is an end, not a wrap: jumping back to the
      // first slide from the last reads as having lost your place.
      // Jumped rather than animated: the strip scrolls smoothly, and a reading
      // taken while it is still travelling is a reading of where it was, not
      // where it was sent. 'auto' is not enough — it defers to the stylesheet,
      // which is the thing being worked around — so the behaviour is turned
      // off for the jump and put back afterwards.
      strip.style.scrollBehavior = 'auto';
      strip.scrollLeft = strip.scrollWidth;
      await new Promise(r => setTimeout(r, 150));
      const end = { said: said(), on: document.getElementById('gal-next').disabled };
      strip.scrollLeft = 0;
      await new Promise(r => setTimeout(r, 150));
      strip.style.scrollBehavior = '';
      return { start, moved, home, end };
    });
    check('the strip starts at the first slide and says so',
      walked.start.said === '1 of 6' && walked.start.back === true,
      JSON.stringify(walked));
    check('the right arrow moves it along',
      walked.moved.where > walked.start.where && walked.moved.said === '2 of 6'
      && walked.moved.back === false, JSON.stringify(walked));
    check('and the left arrow brings it back',
      walked.home.where < walked.moved.where && walked.home.said === '1 of 6',
      JSON.stringify(walked));
    check('the last slide is the end of the strip, not a wrap round to the first',
      walked.end.said === '6 of 6' && walked.end.on === true, JSON.stringify(walked));

    // The counter and the picture have to be the same slide. They were not:
    // positions were read as offsetLeft, which counts from the page rather
    // than from the strip, so every slide carried the strip's own left margin.
    // On a wide window that margin grew past half a slide and the arrows
    // stepped two at a time while the counter said one.
    const honest = await page.evaluate(async () => {
      const strip = document.getElementById('galstrip');
      const slides = [...strip.querySelectorAll('.galslide')];
      const centred = () => {
        const mine = strip.getBoundingClientRect();
        let best = -1;
        let near = Infinity;
        slides.forEach((slide, i) => {
          const box = slide.getBoundingClientRect();
          const gap = Math.abs((box.left + box.width / 2) - (mine.left + mine.width / 2));
          if (gap < near) { near = gap; best = i; }
        });
        return best + 1;
      };
      const steps = [];
      for (let i = 0; i < 3; i++) {
        document.getElementById('gal-next').click();
        await new Promise(r => setTimeout(r, 650));
        steps.push({ said: document.getElementById('gal-count').textContent.trim(),
                     really: centred() });
      }
      strip.style.scrollBehavior = 'auto';
      strip.scrollLeft = 0;
      await new Promise(r => setTimeout(r, 150));
      strip.style.scrollBehavior = '';
      return steps;
    });
    check('each press of the arrow moves exactly one slide',
      honest.every((step, i) => step.really === i + 2), JSON.stringify(honest));
    check('and the count says the slide that is actually showing',
      honest.every(step => step.said === step.really + ' of 6'), JSON.stringify(honest));

    // No bar along the bottom. The arrows are the control; a second one under
    // the pictures was a grey line across a section whose job is to be looked
    // at. Flicking and dragging still work.
    const noBar = await page.evaluate(() => {
      const strip = document.getElementById('galstrip');
      return { gutter: strip.offsetHeight - strip.clientHeight,
        scrolls: strip.scrollWidth > strip.clientWidth };
    });
    check('the strip carries no scrollbar of its own',
      noBar.gutter === 0 && noBar.scrolls === true, JSON.stringify(noBar));

    // Enlarged, the same two controls follow the picture: six slides compared
    // one at a time should not mean closing and reopening between each.
    const inside = await page.evaluate(async () => {
      document.querySelector('.galshot').click();
      await new Promise(r => setTimeout(r, 250));
      const big = () => document.getElementById('samplebig').getAttribute('src');
      const opened = big();
      const said = document.getElementById('big-count').textContent.trim();
      document.getElementById('big-next').click();
      await new Promise(r => setTimeout(r, 500));
      const stepped = big();
      const thenSaid = document.getElementById('big-count').textContent.trim();
      document.getElementById('big-original').click();
      await new Promise(r => setTimeout(r, 200));
      const flipped = big();
      // Pressing its own controls must not be read as pressing the dark
      // around the picture.
      const stillOpen = document.getElementById('samplebox').hidden === false;
      document.getElementById('big-redacted').click();
      document.getElementById('sampleclose').click();
      await new Promise(r => setTimeout(r, 150));
      const strip = document.getElementById('galstrip');
      strip.style.scrollBehavior = 'auto';
      strip.scrollLeft = 0;
      await new Promise(r => setTimeout(r, 150));
      strip.style.scrollBehavior = '';
      return { opened, said, stepped, thenSaid, flipped, stillOpen };
    });
    check('the enlarged slide can be stepped without closing it',
      /slide-1-redacted/.test(inside.opened) && /slide-2-redacted/.test(inside.stepped)
      && inside.said === '1 of 6' && inside.thenSaid === '2 of 6', JSON.stringify(inside));
    check('and swapped for its other half in place',
      /slide-2-original/.test(inside.flipped), JSON.stringify(inside));
    check('and pressing those controls does not close it',
      inside.stillOpen === true, JSON.stringify(inside));

    // Enlarging shows the half being looked at. Opening the redacted one over
    // a reviewer comparing the originals would be the tool arguing with them.
    const enlarged = await page.evaluate(async () => {
      document.getElementById('gal-original').click();
      document.querySelector('.galshot').click();
      await new Promise(r => setTimeout(r, 150));
      const wasOriginal = document.getElementById('samplebig').getAttribute('src');
      document.getElementById('samplebox').hidden = true;
      document.getElementById('gal-redacted').click();
      document.querySelector('.galshot').click();
      await new Promise(r => setTimeout(r, 150));
      const wasRedacted = document.getElementById('samplebig').getAttribute('src');
      document.getElementById('samplebox').hidden = true;
      return { wasOriginal, wasRedacted };
    });
    check('enlarging shows the half that is on screen',
      /original/.test(enlarged.wasOriginal) && /redacted/.test(enlarged.wasRedacted),
      JSON.stringify(enlarged));

    // On a phone the picture is the screen: no card, no mat, no page-width
    // minimum dragging it sideways before any of it can be read.
    {
      const small = await context.newPage();
      await small.setViewportSize({ width: 390, height: 844 });
      await small.goto(base);
      await small.waitForSelector('.galshot', { timeout: 15000 });
      const full = await small.evaluate(async () => {
        document.querySelector('.galshot').click();
        await new Promise(r => setTimeout(r, 200));
        const img = document.getElementById('samplebig').getBoundingClientRect();
        const stage = document.querySelector('.samplestage');
        const inner = document.querySelector('.sampleinner');
        const seen = getComputedStyle(stage);
        return {
          // As wide as the screen, give or take a rounded pixel.
          wide: Math.abs(img.width - window.innerWidth) <= 2,
          width: Math.round(img.width), screen: window.innerWidth,
          // And nothing drawn around it.
          border: seen.borderTopWidth, pad: seen.paddingTop,
          card: getComputedStyle(inner).borderTopWidth,
          // Two fingers are ours to read, not the browser's to scroll with.
          fingers: seen.touchAction,
        };
      });
      check('on a phone the enlarged slide fills the width',
        full.wide === true, JSON.stringify(full));
      check('with no frame or mat around it',
        full.border === '0px' && full.pad === '0px' && full.card === '0px',
        JSON.stringify(full));
      check('and two fingers belong to the picture',
        full.fingers === 'none', JSON.stringify(full));

      const zoomed = await small.evaluate(async () => {
        const stage = document.querySelector('.samplestage');
        const img = document.getElementById('samplebig');
        const before = img.getBoundingClientRect().width;
        const at = (type, id, x, y) => stage.dispatchEvent(new PointerEvent(type, {
          pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
          bubbles: true, isPrimary: id === 1,
        }));
        at('pointerdown', 1, 120, 400);
        at('pointerdown', 2, 260, 400);
        at('pointermove', 1, 40, 400);
        at('pointermove', 2, 340, 400);
        await new Promise(r => setTimeout(r, 60));
        const after = img.getBoundingClientRect().width;
        at('pointerup', 1, 40, 400);
        at('pointerup', 2, 340, 400);
        // Opening it again starts from the whole picture.
        document.querySelector('#sampleclose').click();
        await new Promise(r => setTimeout(r, 80));
        document.querySelector('.galshot').click();
        await new Promise(r => setTimeout(r, 150));
        return { before: Math.round(before), after: Math.round(after),
          reopened: Math.round(img.getBoundingClientRect().width) };
      });
      check('pinching it open makes it bigger',
        zoomed.after > zoomed.before, JSON.stringify(zoomed));
      check('and opening it again starts from the whole picture',
        Math.abs(zoomed.reopened - zoomed.before) <= 2, JSON.stringify(zoomed));

      // Where it zooms, which is the half of this that was wrong. Growing the
      // width pushes the picture out to the right, and a scroll position left
      // at zero keeps the left edge under the fingers: pinching the middle of
      // the slide enlarged it and then showed you its left margin.
      //
      // Measured as a fraction of the picture, so it does not depend on how
      // large anything happens to be: the point of the slide under the pinch
      // before must be the point under it after.
      const about = await small.evaluate(async () => {
        const stage = document.querySelector('.samplestage');
        const img = document.getElementById('samplebig');
        const at = (type, id, x, y) => stage.dispatchEvent(new PointerEvent(type, {
          pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
          bubbles: true, isPrimary: id === 1,
        }));
        // Well over to the right, where the old behaviour was most wrong.
        const focus = { x: Math.round(window.innerWidth * 0.8), y: 380 };
        const was = img.getBoundingClientRect();
        const under = {
          x: (focus.x - was.left) / was.width,
          y: (focus.y - was.top) / was.height,
        };
        at('pointerdown', 1, focus.x - 60, focus.y);
        at('pointerdown', 2, focus.x + 60, focus.y);
        at('pointermove', 1, focus.x - 150, focus.y);
        at('pointermove', 2, focus.x + 150, focus.y);
        await new Promise(r => setTimeout(r, 60));
        const now = img.getBoundingClientRect();
        const after = {
          x: (focus.x - now.left) / now.width,
          y: (focus.y - now.top) / now.height,
        };
        at('pointerup', 1, focus.x - 150, focus.y);
        at('pointerup', 2, focus.x + 150, focus.y);
        return { under, after, grew: now.width > was.width,
                 scrolled: stage.scrollLeft };
      });
      check('the pinch enlarges about the point between the fingers',
        about.grew === true && Math.abs(about.under.x - about.after.x) < 0.04,
        JSON.stringify(about));
      check('which means it has scrolled to keep that point in view',
        about.scrolled > 0, JSON.stringify(about));

      // One finger moves the picture about. It has to be ours: two fingers
      // being a zoom means the stage cannot also have the browser's own touch
      // scrolling, so without this a zoomed picture could not be read past
      // whatever part of it was on screen.
      const dragged = await small.evaluate(async () => {
        const stage = document.querySelector('.samplestage');
        const at = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, {
          pointerId: 9, pointerType: 'touch', clientX: x, clientY: y,
          bubbles: true, isPrimary: true,
        }));
        const was = stage.scrollLeft;
        at('pointerdown', 300, 400);
        at('pointermove', 200, 400);
        at('pointermove', 140, 400);
        await new Promise(r => setTimeout(r, 40));
        const now = stage.scrollLeft;
        at('pointerup', 140, 400);
        return { was, now };
      });
      check('and one finger drags it about',
        dragged.now > dragged.was, JSON.stringify(dragged));

      // Two taps in the same place, which is how everyone zooms a photograph.
      const tapped = await small.evaluate(async () => {
        const stage = document.querySelector('.samplestage');
        const img = document.getElementById('samplebig');
        const tap = async (x, y) => {
          for (const type of ['pointerdown', 'pointerup']) {
            stage.dispatchEvent(new PointerEvent(type, { pointerId: 11,
              pointerType: 'touch', clientX: x, clientY: y, bubbles: true,
              isPrimary: true }));
          }
        };
        document.querySelector('#sampleclose').click();
        await new Promise(r => setTimeout(r, 80));
        document.querySelector('.galshot').click();
        await new Promise(r => setTimeout(r, 150));
        const fit = img.getBoundingClientRect();
        const focus = { x: Math.round(window.innerWidth * 0.75), y: 360 };
        const under = (box) => (focus.x - box.left) / box.width;
        await tap(focus.x, focus.y);
        await tap(focus.x, focus.y);
        await new Promise(r => setTimeout(r, 60));
        const big = img.getBoundingClientRect();
        // And again to come back out.
        await tap(focus.x, focus.y);
        await tap(focus.x, focus.y);
        await new Promise(r => setTimeout(r, 60));
        const back = img.getBoundingClientRect();
        return { fit: Math.round(fit.width), big: Math.round(big.width),
                 back: Math.round(back.width),
                 heldPoint: Math.abs(under(fit) - under(big)) };
      });
      check('a double tap zooms in', tapped.big > tapped.fit * 1.5,
        JSON.stringify(tapped));
      check('about the point tapped', tapped.heldPoint < 0.04,
        JSON.stringify(tapped));
      check('and a double tap again shows the whole slide',
        Math.abs(tapped.back - tapped.fit) <= 2, JSON.stringify(tapped));

      // One slow tap after another is two taps, not a double one: a reviewer
      // reading a zoomed slide taps it to no effect, and if that counted it
      // would jump about under them.
      const slow = await small.evaluate(async () => {
        const stage = document.querySelector('.samplestage');
        const img = document.getElementById('samplebig');
        const was = img.getBoundingClientRect().width;
        const tap = () => {
          for (const type of ['pointerdown', 'pointerup']) {
            stage.dispatchEvent(new PointerEvent(type, { pointerId: 12,
              pointerType: 'touch', clientX: 200, clientY: 300, bubbles: true,
              isPrimary: true }));
          }
        };
        tap();
        await new Promise(r => setTimeout(r, 450));
        tap();
        await new Promise(r => setTimeout(r, 60));
        return { was: Math.round(was),
                 now: Math.round(img.getBoundingClientRect().width) };
      });
      check('two unhurried taps are not a double tap',
        slow.now === slow.was, JSON.stringify(slow));
      await small.close();
    }

    // The dialog is the picture. A heading naming it and a button saying
    // Close were two rows of chrome around the one thing being looked at.
    const bare = await page.evaluate(async () => {
      const box = document.getElementById('samplebox');
      document.querySelector('.galshot').click();
      await new Promise(r => setTimeout(r, 120));
      const inner = box.querySelector('.busy-inner');
      const out = {
        heading: Boolean(box.querySelector('h2')),
        words: (box.querySelector('#sampleclose').textContent || '').trim(),
        cross: Boolean(box.querySelector('#sampleclose svg')),
        // Top right of the picture, over it rather than under it.
        corner: (() => {
          const x = box.querySelector('#sampleclose').getBoundingClientRect();
          const frame = inner.getBoundingClientRect();
          return x.top - frame.top < 60 && frame.right - x.right < 60;
        })(),
      };
      // The frame around the picture is outside the picture, and a click
      // there that did nothing would read as a dialog gone deaf.
      inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      out.frameCloses = box.hidden;
      box.hidden = true;
      return out;
    });
    check('the enlarged slide carries no heading and no worded button',
      bare.heading === false && bare.words === '', JSON.stringify(bare));
    check('just a cross, in the top right corner',
      bare.cross === true && bare.corner === true, JSON.stringify(bare));
    check('and a click on the frame around it closes it too',
      bare.frameCloses === true, JSON.stringify(bare));
  });

  // ---------- pinching the document, and only the document ----------
  //
  // The browser's own pinch zoomed the whole app: panel, toolbar and header
  // swelling together, with the page no more readable than before. It is off
  // in the viewport tag now, and two fingers on the document drive the
  // document's own zoom instead — the same ladder the buttons use, so a pinch
  // and a button press leave it in the same state.
  await part("pinching the document, and only the document", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const pinch = await page.evaluate(async (where) => {
      const B = window.Blinded;
      const target = where === 'doc'
        ? (document.querySelector('.page canvas') || document.querySelector('.stage'))
        : document.querySelector('.panel');
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + Math.min(160, r.height / 2);
      const send = (type, id, x, y) => target.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
        bubbles: true, cancelable: true,
      }));
      B.setZoom(1);
      const spread = (from, to, step) => {
        for (let d = from; step > 0 ? d <= to : d >= to; d += step) {
          send('pointermove', 1, cx - d, cy);
          send('pointermove', 2, cx + d, cy);
        }
      };
      const before = B.state.zoom;
      send('pointerdown', 1, cx - 20, cy);
      send('pointerdown', 2, cx + 20, cy);
      spread(25, 70, 5);
      const out = B.state.zoom;
      spread(70, 15, -5);
      const back = B.state.zoom;
      send('pointerup', 1, cx - 15, cy);
      send('pointerup', 2, cx + 15, cy);
      return { before, out, back, held: B.pinching(),
               marks: B.state.pages.reduce((n, p) => n + p.manual.length, 0),
               ladder: B.ZOOM_STEPS.includes(B.state.zoom) };
    }, 'doc');

    check('spreading two fingers on the document zooms it in',
      pinch.out > pinch.before, JSON.stringify(pinch));
    check('and bringing them together zooms it out again',
      pinch.back < pinch.out, JSON.stringify(pinch));
    check('it lands on the same sizes the buttons use',
      pinch.ladder === true, JSON.stringify(pinch));
    // The first finger of a pinch starts what looks like a drag, and a drag on
    // the document draws a box or dismisses a mark.
    check('and leaves no box behind for the finger that started it',
      pinch.marks === 0, JSON.stringify(pinch));
    check('and nothing is left mid-pinch once the fingers lift',
      pinch.held === false, JSON.stringify(pinch));

    const elsewhere = await page.evaluate(async () => {
      const B = window.Blinded;
      const target = document.querySelector('.panel');
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + 120;
      const send = (type, id, x, y) => target.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
        bubbles: true, cancelable: true,
      }));
      B.setZoom(1);
      const before = B.state.zoom;
      send('pointerdown', 5, cx - 20, cy);
      send('pointerdown', 6, cx + 20, cy);
      for (let d = 25; d <= 70; d += 5) {
        send('pointermove', 5, cx - d, cy);
        send('pointermove', 6, cx + d, cy);
      }
      send('pointerup', 5, cx - 70, cy);
      send('pointerup', 6, cx + 70, cy);
      return { before, after: B.state.zoom };
    });
    check('a pinch anywhere else does nothing at all',
      elsewhere.after === elsewhere.before, JSON.stringify(elsewhere));

    // Two fingers moving together is a scroll, which is the only way to move
    // the document while a box is being drawn: the one finger that would
    // ordinarily drag it is busy drawing, so a reviewer on a phone could mark
    // the part of the page they could already see and nothing else.
    const twoFinger = await page.evaluate(async () => {
      const B = window.Blinded;
      B.setZoom(2);
      B.setMode('pick');
      await new Promise(r => setTimeout(r, 150));
      const c = document.querySelector('.page canvas');
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + Math.min(260, r.height / 2);
      const scroller = B.scrollerFor(c);
      const room = scroller === window
        ? document.body.scrollHeight - window.innerHeight
        : scroller.scrollHeight - scroller.clientHeight;
      const top = () => (scroller === window ? window.scrollY : scroller.scrollTop);
      const send = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
        bubbles: true, cancelable: true,
      }));
      const before = top();
      send('pointerdown', 21, cx - 25, cy);
      send('pointerdown', 22, cx + 25, cy);
      for (let d = 10; d <= 150; d += 10) {
        send('pointermove', 21, cx - 25, cy - d);
        send('pointermove', 22, cx + 25, cy - d);
      }
      const after = top();
      const zoomed = B.state.zoom;
      send('pointerup', 21, cx - 25, cy - 150);
      send('pointerup', 22, cx + 25, cy - 150);
      B.setMode('box');
      B.setZoom(1);
      return { room, before, after, zoomed,
               marks: B.state.pages.reduce((n, p) => n + p.manual.length, 0) };
    });
    // Without somewhere to scroll to, the rest would pass vacuously.
    check('there is somewhere for the document to scroll to',
      twoFinger.room > 0, JSON.stringify(twoFinger));
    check('two fingers moving together scroll the document while picking',
      twoFinger.after > twoFinger.before, JSON.stringify(twoFinger));
    // Moving together is not moving apart, so the size must not change under
    // a reviewer who only meant to look further down.
    check('and do not zoom it on the way',
      twoFinger.zoomed === 2, JSON.stringify(twoFinger));
    check('and leave no box behind',
      twoFinger.marks === 0, JSON.stringify(twoFinger));

    // And the browser is told not to zoom the app itself, which is what a
    // pinch used to do.
    const viewport = await page.evaluate(() =>
      (document.querySelector('meta[name="viewport"]') || {}).content || '');
    check('the page forbids the browser its own pinch',
      /user-scalable\s*=\s*no/.test(viewport) && /maximum-scale\s*=\s*1/.test(viewport),
      viewport);
    await page.evaluate(() => window.Blinded.setZoom(1));
  });

  // ---------- what the bar turned away ----------
  //
  // Reported on a deck of near-identical letter badges: at the highest setting
  // two of seven were marked, and nothing on screen said the other five were
  // one nudge of the slider away. The panel could only describe what it found,
  // which is the half that does not help — so the reviewer guessed the bar
  // downwards and re-ran until something appeared.
  await part("what the bar turned away", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const told = await page.evaluate(async () => {
      const B = window.Blinded;
      B.state.termImages = false;          // picked images only, no reading
      await B.addTemplate(B.state.pages[0], { x: 40, y: 40, w: 120, h: 120 });
      const template = B.state.templates[0];
      // Learn what this fixture's copies actually score, then set the bar just
      // above the second one. Guessing a number here would be guessing about
      // the fixture rather than testing the note: on a document whose copies
      // are all far apart, a high bar leaves no near misses at all and the
      // note would be right to stay quiet.
      template.sens = 0.45;
      template.searched = false;
      await B.runSearch();
      const scores = B.state.pages
        .flatMap(p => p.imageHits.filter(m => m.templateId === template.id))
        .map(m => m.score).sort((a, b) => b - a);
      // Set by hand, and said so: a bar the reviewer chose is one the search
      // leaves where it is, and this note is about what such a bar turned
      // away. Without that flag the search would settle the bar back down on
      // to the matches and there would be nothing to report.
      template.sens = Math.min(0.99, scores[1] + 0.01);
      template.chosenBar = true;
      template.searched = false;
      for (const p of B.state.pages) {
        p.imageHits = p.imageHits.filter(m => m.templateId !== template.id);
      }
      await B.runSearch();
      const pips = [...document.querySelectorAll('#templates .barpip')]
        .map(pip => ({ now: pip.classList.contains('now'),
                       bar: Number((pip.querySelector('b') || {}).textContent),
                       count: parseInt((pip.querySelector('i') || {}).textContent, 10) }));
      const out = { scores: scores.map(s => +s.toFixed(3)),
                    pips,
                    bar: B.sensFor(template),
                    marks: B.state.pages.reduce((n, p) =>
                      n + p.imageHits.filter(m => m.templateId === template.id).length, 0) };
      B.state.termImages = true;
      return out;
    });
    // A bar set by hand that turned candidates away is exactly the case the
    // settings are for: one of them is lower than where the bar stands and
    // finds more, which is "lower it past this to include them" without the
    // paragraph that used to say so.
    const here = told.pips.find(pip => pip.now);
    const lower = told.pips.filter(pip => !pip.now && pip.bar < told.bar);
    check('the settings say where the bar stands and what it found',
      Boolean(here) && here.bar === Number(told.bar.toFixed(2))
      && here.count === told.marks, JSON.stringify(told));
    check('and a bar that turned matches away offers a lower one that keeps them',
      lower.length >= 1 && lower.every(pip => pip.count > here.count),
      JSON.stringify(told));
    check('with each setting a bar the slider can actually stand on',
      told.pips.every(pip => Number.isFinite(pip.bar) && pip.bar >= 0.45 && pip.bar <= 0.99),
      JSON.stringify(told.pips));

    // And a bar with nothing near it offers nothing below: the space between
    // the bar and the weakest match is empty, and a setting that found the
    // same things at a different number would be noise.
    const quiet = await page.evaluate(async () => {
      const B = window.Blinded;
      const template = B.state.templates[0];
      // Well below everything, so nothing is anywhere near being turned away.
      template.sens = B.AUTO_FLOOR;
      template.chosenBar = true;
      // Put there rather than arrived at: this is about what the scores offer,
      // and a "back to where you were" setting is about the journey.
      template.barWas = null;
      template.searched = false;
      for (const p of B.state.pages) {
        p.imageHits = p.imageHits.filter(m => m.templateId !== template.id);
      }
      await B.runSearch();
      // Counted the way the pill beside the slider counts, which is the
      // number the circle has to agree with: two proposals in one place are
      // one mark, and a dismissed one is none.
      const marks = B.state.pages.reduce((n, p) =>
        n + B.liveImageHits(p).filter(m => m.templateId === template.id).length, 0);
      const pips = [...document.querySelectorAll('#templates .barpip')]
        .map(pip => ({ now: pip.classList.contains('now'),
                       bar: Number((pip.querySelector('b') || {}).textContent),
                       count: parseInt((pip.querySelector('i') || {}).textContent, 10) }));
      return { pips, marks, bar: B.sensFor(template) };
    });
    const standing = quiet.pips.find(pip => pip.now);
    check('a bar under everything still says where it stands, and counts as the pill does',
      Boolean(standing) && standing.count === quiet.marks, JSON.stringify(quiet));
    check('and offers nothing below it, because there is nothing down there',
      quiet.pips.every(pip => pip.now || pip.bar > quiet.bar), JSON.stringify(quiet));
  });

  // ---------- a searchable redacted file ----------
  //
  // The export is a picture of every page, which is what makes the redaction
  // real and also what makes the finished file impossible to search. Reading
  // the pages back gives it a text layer.
  //
  // The reader is pointed at the flattened canvas, never at the original: a
  // word under a bar is not in those pixels, so it cannot come back as text.
  // That is the whole safety argument for the feature, and it is what these
  // checks are about.
  await part("a searchable redacted file", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Amphitheatre']);
    await redact(page);

    const pdfjs3 = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const textOf = async download => {
      const out = join(tmpdir(), 'blinded-searchable-' + Math.random().toString(36).slice(2) + '.pdf');
      await download.saveAs(out);
      const doc = await pdfjs3.getDocument({ data: new Uint8Array(readFileSync(out)) }).promise;
      let all = '';
      for (let n = 1; n <= doc.numPages; n++) {
        const pg = await doc.getPage(n);
        all += (await pg.getTextContent()).items.map(i => i.str).join(' ') + ' ';
      }
      return all;
    };

    // Off by default: it costs a second reading of every page, and a reviewer
    // who has not asked for it should not pay for it.
    check('the option is offered on the way out, and is off to begin with',
      await page.evaluate(() => {
        const box = document.getElementById('searchable');
        return box && box.checked === false;
      }));

    const withText = await (async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 300000 }),
        (async () => {
          await page.click('#export');
          await page.waitForSelector('#namebox:not([hidden])', { timeout: 15000 });
          await page.check('#searchable');
          await page.click('#namesave');
        })(),
      ]);
      return textOf(download);
    })();

    check('a searchable export carries the words of the page as real text',
      /Parkway|Mailing|address/i.test(withText), withText.slice(0, 200));
    // The one that matters. "Amphitheatre" was covered, so it is not in the
    // pixels the reader was given, so it cannot be in the layer it produced.
    check('and not the word that was covered',
      !/Amphitheatre/i.test(withText), withText.slice(0, 300));
    check('nor anything else behind a bar',
      !/jane\.doe@example\.com/i.test(withText), withText.slice(0, 300));

    // And the checkbox is what decides it, not something always on.
    await page.uncheck('#searchable').catch(() => {});
    const plain = await (async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120000 }),
        (async () => {
          await page.click('#export');
          await page.waitForSelector('#namebox:not([hidden])', { timeout: 15000 });
          await page.uncheck('#searchable');
          await page.click('#namesave');
        })(),
      ]);
      return textOf(download);
    })();
    check('and without the option the file has no text layer of its own',
      !/Parkway/i.test(plain), plain.slice(0, 200));
  });

  // ---------- organising the pages ----------
  //
  // The sheet is a second view of state.pages, and every operation on it is a
  // new order for that one array. What these check is that the array and the
  // document agree afterwards — a sheet that reorders itself while the pages
  // underneath stay put is the failure that would ship silently, because the
  // thumbnails would look right either way.
  await part("organising the pages", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', manyPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 60000 });
    await page.evaluate(() => { document.getElementById('organisesect').open = true; });

    const started = await page.evaluate(() => ({
      tiles: document.querySelectorAll('#sheet .sheetpage').length,
      pages: window.Blinded.state.pages.length,
      // The page count that used to sit beside the heading is gone: the
      // thumbnails are the count, and a number beside them said it twice.
      note: Boolean(document.getElementById('organise-note')),
      numbers: [...document.querySelectorAll('.sheetnum')].map(n => n.textContent).slice(0, 3),
    }));
    check('the sheet shows a thumbnail for every page',
      started.tiles === 14 && started.pages === 14, JSON.stringify(started));
    check('and does not also count them in words', started.note === false,
      JSON.stringify(started));
    check('numbered from one', started.numbers.join(',') === '1,2,3', JSON.stringify(started));

    const picked = await page.evaluate(() => {
      const B = window.Blinded;
      const face = i => document.querySelectorAll('.sheetface')[i];
      face(2).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const one = B.pickedInOrder().map(p => p.index);
      face(6).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      const run = B.pickedInOrder().map(p => p.index);
      face(10).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      const plus = B.pickedInOrder().map(p => p.index);
      return { one, run, plus };
    });
    check('clicking a page selects it', picked.one.join(',') === '2', JSON.stringify(picked));
    check('shift-clicking takes the whole run, both ends included',
      picked.run.join(',') === '2,3,4,5,6', JSON.stringify(picked));
    check('and ctrl-clicking adds one on its own',
      picked.plus.join(',') === '2,3,4,5,6,10', JSON.stringify(picked));

    // Opening the sheet makes room for it. A grid of thumbnails opened under
    // four other sections lands below the fold.
    const alone = await page.evaluate(async () => {
      const sheet = document.getElementById('organisesect');
      const others = [...document.querySelectorAll('details.sect')].filter(d => d !== sheet);
      // The toggle event is asynchronous, and the sections now answer each
      // other through it. Opening five of them in one go queues five events
      // and the answer depends on which lands last, which is a race the
      // reviewer never runs: they open one section, then another. Waited out
      // between the two so this tests the behaviour and not the scheduler.
      sheet.open = false;
      for (const sect of others) sect.open = true;
      await new Promise(r => setTimeout(r, 50));
      const before = others.filter(d => d.open).length;
      sheet.open = true;
      await new Promise(r => setTimeout(r, 50));
      return { before, sheet: sheet.open,
        othersOpen: others.filter(d => d.open).length, others: others.length };
    });
    check('the other sections start open', alone.before === alone.others,
      JSON.stringify(alone));
    check('opening the sheet closes every other section',
      alone.sheet === true && alone.othersOpen === 0 && alone.others >= 3,
      JSON.stringify(alone));

    const yielded = await page.evaluate(async () => {
      const sheet = document.getElementById('organisesect');
      sheet.open = true;
      await new Promise(r => setTimeout(r, 50));
      const other = [...document.querySelectorAll('details.sect')].find(d => d !== sheet);
      other.open = true;
      await new Promise(r => setTimeout(r, 50));
      return { sheet: sheet.open, other: other.open };
    });
    check('and opening another section closes the sheet again',
      yielded.sheet === false && yielded.other === true, JSON.stringify(yielded));

    // A real pointer drag, grip to target, so the ghost and the drop are under
    // test rather than only the array maths underneath them.
    const dragged = await page.evaluate(async () => {
      const B = window.Blinded;
      const tiles = () => [...document.querySelectorAll('#sheet .sheetpage')];
      const carried = tiles()[0];
      const onto = tiles()[3];
      const uid = B.state.pages[0].uid;
      const grip = carried.querySelector('.grip');
      const from = grip.getBoundingClientRect();
      const to = onto.getBoundingClientRect();
      const at = (type, x, y) => grip.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, pointerId: 7, isPrimary: true,
      }));

      at('pointerdown', from.left + 5, from.top + 5);
      const lifted = {
        ghost: document.querySelectorAll('.sheetghost').length,
        held: document.body.classList.contains('dragging-page'),
        faded: carried.classList.contains('dragging'),
      };
      at('pointermove', to.left + to.width / 2, to.top + to.height / 2);
      const midway = {
        ghost: document.querySelectorAll('.sheetghost').length,
        moved: (document.querySelector('.sheetghost') || {}).style
          ? document.querySelector('.sheetghost').style.transform : '',
        line: document.querySelectorAll('.dropline').length,
        // The line must stand in the gutter beside the tile the pointer is
        // over, not on top of it: a marker drawn across a page says "this
        // one", and the whole reason for a line is to say "between these".
        beside: (() => {
          const mark = document.querySelector('.dropline');
          if (!mark) return null;
          const bar = mark.getBoundingClientRect();
          const over = tiles()[3].getBoundingClientRect();
          return { gap: Math.round(bar.left - over.right),
            tall: bar.height >= over.height };
        })(),
      };
      at('pointerup', to.left + to.width / 2, to.top + to.height / 2);
      await new Promise(r => setTimeout(r, 300));
      return {
        lifted, midway,
        landed: B.state.pages.findIndex(p => p.uid === uid),
        gone: document.querySelectorAll('.sheetghost').length,
        noLine: document.querySelectorAll('.dropline').length,
        released: document.body.classList.contains('dragging-page'),
      };
    });
    check('pressing the grip lifts a copy of the page',
      dragged.lifted.ghost === 1, JSON.stringify(dragged.lifted));
    check('and marks the page as being carried',
      dragged.lifted.held === true && dragged.lifted.faded === true,
      JSON.stringify(dragged.lifted));
    check('the copy follows the pointer',
      /translate\(/.test(dragged.midway.moved), JSON.stringify(dragged.midway));
    check('a line shows the gap it will land in',
      dragged.midway.line === 1, JSON.stringify(dragged.midway));
    check('and the line stands between two pages, not across one',
      dragged.midway.beside && Math.abs(dragged.midway.beside.gap) <= 8
        && dragged.midway.beside.tall === true, JSON.stringify(dragged.midway));
    check('letting go drops the page there',
      dragged.landed === 3, JSON.stringify(dragged));
    check('and the copy and the line are cleared away afterwards',
      dragged.gone === 0 && dragged.noLine === 0 && dragged.released === false,
      JSON.stringify(dragged));

    // A cancelled gesture is not a drop. The system taking the pointer away
    // must not move a page on the strength of where the finger happened to be.
    const cancelled = await page.evaluate(async () => {
      const B = window.Blinded;
      const tiles = [...document.querySelectorAll('#sheet .sheetpage')];
      const uid = B.state.pages[0].uid;
      const grip = tiles[0].querySelector('.grip');
      const from = grip.getBoundingClientRect();
      const to = tiles[5].getBoundingClientRect();
      const at = (type, x, y) => grip.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, pointerId: 8, isPrimary: true,
      }));
      at('pointerdown', from.left + 5, from.top + 5);
      at('pointermove', to.left + to.width / 2, to.top + to.height / 2);
      at('pointercancel', to.left + to.width / 2, to.top + to.height / 2);
      await new Promise(r => setTimeout(r, 300));
      return { still: B.state.pages[0].uid === uid,
        ghost: document.querySelectorAll('.sheetghost').length };
    });
    check('a cancelled drag leaves the page where it was',
      cancelled.still === true, JSON.stringify(cancelled));
    check('and takes its copy with it',
      cancelled.ghost === 0, JSON.stringify(cancelled));

    // An earlier check opened another section, which closes the sheet — so it
    // is opened again here rather than assumed still open.
    await page.evaluate(async () => {
      document.getElementById('organisesect').open = true;
      await new Promise(r => setTimeout(r, 80));
    });

    // The five actions are a joined icon bar at the top now, not three rows of
    // words below the thumbnails.
    const bar = await page.evaluate(() => {
      const tools = document.querySelector('#organisesect .sheettools');
      const body = document.querySelector('#organisesect > .s-body');
      const sheet = document.getElementById('sheet');
      return {
        icons: tools ? tools.querySelectorAll('button').length : 0,
        // Above the thumbnails, which is the point of shrinking them.
        first: body.firstElementChild === tools,
        aboveSheet: tools && sheet
          ? tools.getBoundingClientRect().top < sheet.getBoundingClientRect().top : false,
        // Still says what it is, for a pointer and for a screen reader.
        titled: tools ? [...tools.querySelectorAll('button')].every(b => b.title) : false,
        named: tools ? [...tools.querySelectorAll('button')].every(b =>
          b.querySelector('.sr-only')) : false,
      };
    });
    check('the five actions are one icon bar', bar.icons === 5, JSON.stringify(bar));
    check('sitting above the thumbnails',
      bar.first === true && bar.aboveSheet === true, JSON.stringify(bar));
    check('and every icon still says what it does',
      bar.titled === true && bar.named === true, JSON.stringify(bar));

    // A joined bar has to look joined. This is measured rather than eyeballed
    // because of how it broke: #page-add kept a `margin-top: 8px` from when it
    // was a wide button on a row of its own, and as the last cell of the bar
    // that dropped it eight pixels below the other four. The id still existed,
    // so the guard that catches a rule pointing at nothing had nothing to say,
    // and every computed style read correctly on its own.
    const joined = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('#organisesect .sheettools .tool')]
        .map(el => el.getBoundingClientRect());
      return {
        tops: cells.map(c => Math.round(c.top)),
        heights: cells.map(c => Math.round(c.height)),
        // Each cell starts where the one before it ended, give or take a
        // rounded pixel: no gaps, no overlaps.
        seams: cells.slice(1).map((c, i) => Math.round(c.left - cells[i].right)),
      };
    });
    check('every cell of the bar sits on the same line',
      new Set(joined.tops).size === 1, JSON.stringify(joined));
    check('and is the same height as the rest',
      new Set(joined.heights).size === 1, JSON.stringify(joined));
    check('and butts against its neighbour',
      joined.seams.every(gap => Math.abs(gap) <= 1), JSON.stringify(joined));

    // One scrollbar, not two. A 320-pixel column with a scrolling panel around
    // a scrolling sheet is a maze: the reviewer scrolls the outer one looking
    // for pages and arrives at the foot of the panel.
    const scrolling = await page.evaluate(async () => {
      await new Promise(r => setTimeout(r, 80));
      const panel = document.querySelector('.panel');
      const sheet = document.getElementById('sheet');
      const wide = window.innerWidth > 900;
      return {
        wide,
        organising: document.body.classList.contains('organising'),
        panelScrolls: panel.scrollHeight > panel.clientHeight + 2,
        sheetScrolls: sheet.scrollHeight > sheet.clientHeight + 2,
        pages: window.Blinded.state.pages.length,
      };
    });
    // And the four sections it is not are one line, which is four rows of the
    // panel handed to the thumbnails. It says what it stands for, so nothing
    // has gone missing: it is a door back, named after what is behind it.
    const rolled = await page.evaluate(() => {
      const roll = document.getElementById('sectroll');
      const others = [...document.querySelectorAll('details.sect')]
        .filter(d => d.id !== 'organisesect');
      return {
        shown: roll.hidden === false,
        says: roll.textContent,
        hidden: others.filter(d => d.hidden).length,
        of: others.length,
      };
    });
    check('the other sections roll into one line', rolled.shown === true
      && rolled.hidden === rolled.of, JSON.stringify(rolled));
    check('and that line names every one of them',
      ['Text', 'Images', 'Detectors', 'Placeholders']
        .every(name => rolled.says.includes(name)), JSON.stringify(rolled));

    const unrolled = await page.evaluate(async () => {
      // Every one of them open before the sheet took them, so that what comes
      // back is a decision this makes rather than the state it was handed.
      for (const sect of document.querySelectorAll('details.sect')) sect.open = true;
      document.getElementById('sectroll').click();
      await new Promise(r => setTimeout(r, 80));
      const others = [...document.querySelectorAll('details.sect')]
        .filter(d => d.id !== 'organisesect');
      return {
        roll: document.getElementById('sectroll').hidden,
        back: others.filter(d => !d.hidden).length,
        of: others.length,
        open: others.map(d => d.open),
        sheet: document.getElementById('organisesect').open,
        sheetShown: document.getElementById('organisesect').hidden === false,
      };
    });
    check('clicking it brings all five sections back',
      unrolled.back === unrolled.of && unrolled.sheetShown === true,
      JSON.stringify(unrolled));
    check('with the sheet shut again and the line gone',
      unrolled.sheet === false && unrolled.roll === true, JSON.stringify(unrolled));
    // Open as the panel opens, not as they happened to be left.
    check('all four come back open, the shape the panel opens in',
      unrolled.open.every(open => open === true), JSON.stringify(unrolled.open));

    await page.evaluate(async () => {
      document.getElementById('organisesect').open = true;
      await new Promise(r => setTimeout(r, 80));
    });

    if (scrolling.wide) {
      check('opening the sheet marks the panel as holding still',
        scrolling.organising === true, JSON.stringify(scrolling));
      check('the panel itself does not scroll',
        scrolling.panelScrolls === false, JSON.stringify(scrolling));
      check('and the thumbnails do, because there are more than fit',
        scrolling.sheetScrolls === true, JSON.stringify(scrolling));
    }

    // Selecting a page in the sheet takes the document to it. Two views of one
    // thing: pointing at a page in one should be looking at it in the other.
    const followed = await page.evaluate(async () => {
      const B = window.Blinded;
      const host = document.getElementById('pages');
      const sc = B.scrollerFor(host);
      const topPage = () => {
        const edge = sc === window ? 0 : sc.getBoundingClientRect().top;
        const kids = [...host.children];
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].getBoundingClientRect().bottom > edge + 1) return i + 1;
        }
        return kids.length;
      };
      B.goToPage(0);
      await new Promise(r => setTimeout(r, 900));
      const before = topPage();
      document.querySelectorAll('#sheet .sheetface')[8]
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1200));
      return { before, after: topPage() };
    });
    check('clicking a thumbnail takes the document to that page',
      followed.after === 9, JSON.stringify(followed));

    // Dragging towards a row that is scrolled out of sight brings it up,
    // rather than making the reviewer drop the page, scroll, and start again.
    const crept = await page.evaluate(async () => {
      const host = document.getElementById('sheet');
      host.scrollTop = 0;
      const tiles = [...host.querySelectorAll('.sheetpage')];
      const grip = tiles[0].querySelector('.grip');
      const from = grip.getBoundingClientRect();
      const box = host.getBoundingClientRect();
      const at = (type, x, y) => grip.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, pointerId: 21, isPrimary: true,
      }));
      const scrolls = host.scrollHeight > host.clientHeight + 4;
      at('pointerdown', from.left + 5, from.top + 5);
      // Held just inside the bottom edge, without moving again.
      at('pointermove', box.left + box.width / 2, box.bottom - 6);
      await new Promise(r => setTimeout(r, 400));
      const moved = host.scrollTop;
      at('pointercancel', box.left + box.width / 2, box.bottom - 6);
      await new Promise(r => setTimeout(r, 260));
      const stopped = host.scrollTop;
      await new Promise(r => setTimeout(r, 300));
      return { scrolls, moved, stopped, still: host.scrollTop };
    });
    check('the sheet is taller than its window, so there is somewhere to creep to',
      crept.scrolls === true, JSON.stringify(crept));
    check('holding a page at the bottom edge scrolls the sheet under it',
      crept.moved > 0, JSON.stringify(crept));
    check('and it stops the moment the drag ends',
      crept.still === crept.stopped, JSON.stringify(crept));

    // ---------- holding a page starts choosing several ----------
    //
    // Selecting more than one needed shift or ctrl, which a phone does not
    // have: the sheet could select exactly one page there, and Keep only
    // these and Remove these were controls for a job that could not be set up.
    const chosen = await page.evaluate(async () => {
      const B = window.Blinded;
      B.state.picked = new Set();
      B.state.choosing = false;
      B.renderSheet();
      const face = i => document.querySelectorAll('#sheet .sheetface')[i];
      const at = (el, type, extra) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 41, isPrimary: true, clientX: 10, clientY: 10, ...extra,
      }));

      at(face(1), 'pointerdown');
      const early = B.state.choosing;
      await new Promise(r => setTimeout(r, 700));
      const after = { choosing: B.state.choosing, picked: B.pickedInOrder().map(p => p.index) };
      at(face(1), 'pointerup');
      // The click that ends the hold is not a second instruction.
      face(1).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const kept = B.pickedInOrder().map(p => p.index);
      const ticks = document.querySelectorAll('#sheet .tick').length;

      // Past the window that swallows the hold's own click.
      await new Promise(r => setTimeout(r, 700));
      // Now a plain tap adds rather than replaces — no modifier needed.
      face(4).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      face(6).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const several = B.pickedInOrder().map(p => p.index);
      // And tapping a chosen one takes it out again.
      face(4).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const fewer = B.pickedInOrder().map(p => p.index);
      return { early, after, kept, ticks, several, fewer,
        tiles: document.querySelectorAll('#sheet .sheetpage').length };
    });
    check('a press alone does not start choosing', chosen.early === false,
      JSON.stringify(chosen));
    check('holding a page does, and takes that page with it',
      chosen.after.choosing === true && chosen.after.picked.join(',') === '1',
      JSON.stringify(chosen));
    check('and the click that ends the hold does not undo it',
      chosen.kept.join(',') === '1', JSON.stringify(chosen));
    check('every page shows a tick box while choosing',
      chosen.ticks === chosen.tiles, JSON.stringify(chosen));
    check('then a plain tap adds a page, with no modifier held',
      chosen.several.join(',') === '1,4,6', JSON.stringify(chosen));
    check('and tapping a chosen page takes it out again',
      chosen.fewer.join(',') === '1,6', JSON.stringify(chosen));

    const finished = await page.evaluate(() => {
      document.getElementById('choose-done').click();
      return {
        choosing: window.Blinded.state.choosing,
        picked: window.Blinded.pickedInOrder().length,
        ticks: document.querySelectorAll('#sheet .tick').length,
      };
    });
    check('Done leaves the mode and the ticks go with it',
      finished.choosing === false && finished.ticks === 0, JSON.stringify(finished));

    // The page objects are the identity, so this checks the document by what
    // is on each page rather than by where it sits.
    const moved = await page.evaluate(() => {
      const B = window.Blinded;
      const was = B.state.pages.map(p => p.uid);
      B.state.picked = new Set([B.state.pages[0]]);
      B.moveTo([B.state.pages[0]], 4);   // into the gap before the fifth page
      const now = B.state.pages.map(p => p.uid);
      return {
        nowAt: now.indexOf(was[0]),
        renumbered: B.state.pages.every((p, i) => p.index === i),
        inDom: document.getElementById('pages').children.length,
        label: (B.undoStack[B.undoStack.length - 1] || {}).label,
      };
    });
    check('a page dragged along lands where it was dropped',
      moved.nowAt === 3, JSON.stringify(moved));
    check('and every page is renumbered to its new position',
      moved.renumbered === true, JSON.stringify(moved));
    check('the document itself was rebuilt, not just the sheet',
      moved.inDom === 14, JSON.stringify(moved));
    check('moving a page is undoable', moved.label === 'moving a page', JSON.stringify(moved));

    const undone = await page.evaluate(() => {
      const B = window.Blinded;
      const first = B.state.pages[3].uid;
      B.undoLast();
      return { back: B.state.pages[0].uid === first,
        renumbered: B.state.pages.every((p, i) => p.index === i) };
    });
    check('undo puts it back where it was', undone.back === true, JSON.stringify(undone));
    check('and renumbers on the way back', undone.renumbered === true, JSON.stringify(undone));

    const kept = await page.evaluate(() => {
      const B = window.Blinded;
      const face = i => document.querySelectorAll('.sheetface')[i];
      face(4).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      face(6).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      const wanted = B.pickedInOrder().map(p => p.uid);
      document.getElementById('page-keep').click();
      return {
        left: B.state.pages.length,
        same: B.state.pages.map(p => p.uid).join(',') === wanted.join(','),
        inDom: document.getElementById('pages').children.length,
        tiles: document.querySelectorAll('#sheet .sheetpage').length,
      };
    });
    check('keeping only the selection leaves only the selection',
      kept.left === 3 && kept.same === true, JSON.stringify(kept));
    check('and the document, the sheet and the array agree',
      kept.inDom === 3 && kept.tiles === 3, JSON.stringify(kept));

    const dropped = await page.evaluate(() => {
      const B = window.Blinded;
      const survivor = B.state.pages[2].uid;
      // Selected by clicking the thumbnail, not by writing to state: a button
      // left disabled by a stale render swallows the click in silence, and
      // poking state directly is exactly how that goes unnoticed.
      document.querySelectorAll('.sheetface')[0]
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const taker = B.state.pages[1].uid;
      document.getElementById('page-drop').click();
      return { left: B.state.pages.length, has: B.state.pages.some(p => p.uid === survivor),
        picked: B.state.picked.size, taker,
        onTaker: [...B.state.picked][0] && [...B.state.picked][0].uid === taker };
    });
    check('removing a page removes exactly that page',
      dropped.left === 2 && dropped.has === true, JSON.stringify(dropped));
    // Not cleared: the selection lands on whichever page took the removed
    // one's place, so a reviewer working down a document can delete, look,
    // delete again without reaching for the mouse between each one.
    check('and the selection moves to the page that took its place',
      dropped.picked === 1 && dropped.onTaker === true, JSON.stringify(dropped));

    // Neither button is offered when it would leave no document at all.
    const guarded = await page.evaluate(() => {
      const B = window.Blinded;
      B.state.picked = new Set(B.state.pages);
      B.renderSheet();
      return {
        keep: document.getElementById('page-keep').disabled,
        drop: document.getElementById('page-drop').disabled,
      };
    });
    check('selecting every page offers neither keep nor remove',
      guarded.keep === true && guarded.drop === true, JSON.stringify(guarded));

    const before = await page.evaluate(() => {
      window.Blinded.state.picked = new Set();
      window.Blinded.renderSheet();
      return window.Blinded.state.pages.length;
    });
    await page.setInputFiles('#addfile', fixturePath);
    await page.waitForFunction(n => window.Blinded.state.pages.length > n, before,
      { timeout: 60000 });
    const after = await page.evaluate(() => ({
      pages: window.Blinded.state.pages.length,
      inDom: document.getElementById('pages').children.length,
      tiles: document.querySelectorAll('#sheet .sheetpage').length,
      renumbered: window.Blinded.state.pages.every((p, i) => p.index === i),
      drawable: window.Blinded.state.pages.every(p => p.source && p.source.width > 0),
      unique: new Set(window.Blinded.state.pages.map(p => p.uid)).size,
    }));
    check('a second document adds its pages to the first',
      after.pages === before + 1, JSON.stringify(after));
    check('the added page is a real page, not a hole',
      after.drawable === true && after.renumbered === true, JSON.stringify(after));
    check('and carries an identity of its own',
      after.unique === after.pages, JSON.stringify(after));
    check('the document and the sheet both grew with it',
      after.inDom === after.pages && after.tiles === after.pages, JSON.stringify(after));
    const unknown = await page.evaluate(() => ({
      searched: window.Blinded.state.searched,
      swept: window.Blinded.state.sweptTerms.length,
      read: window.Blinded.state.ocrRead,
    }));
    check('and a page nothing has read un-reads the document',
      unknown.searched === false && unknown.swept === 0 && unknown.read === false,
      JSON.stringify(unknown));

    // What the search knows is a claim about a set of pages, and changing
    // which pages there are has to withdraw it. This is the quiet one: the
    // panel would go on saying the thorough check had been done, over pages it
    // had never seen, which does not look like a failure — it looks like an
    // answer.
    const knowledge = await page.evaluate(() => {
      const B = window.Blinded;
      B.state.searched = true;
      B.state.ocrRead = true;
      B.state.sweptTerms = ['whatever'];
      B.state.picked = new Set([B.state.pages[0]]);
      B.moveTo([B.state.pages[0]], 3);
      const afterMove = { searched: B.state.searched, swept: B.state.sweptTerms.length,
        read: B.state.ocrRead };
      B.state.picked = new Set([B.state.pages[0]]);
      B.dropPicked();
      const afterDrop = { searched: B.state.searched, swept: B.state.sweptTerms.length,
        read: B.state.ocrRead };
      B.undoLast();
      const afterUndo = { searched: B.state.searched, swept: B.state.sweptTerms.length,
        read: B.state.ocrRead };
      return { afterMove, afterDrop, afterUndo };
    });
    check('moving a page leaves what the search knows alone',
      knowledge.afterMove.searched === true && knowledge.afterMove.swept === 1,
      JSON.stringify(knowledge));
    check('but removing one withdraws the thorough check',
      knowledge.afterDrop.searched === false && knowledge.afterDrop.swept === 0,
      JSON.stringify(knowledge));
    check('and what is left is still read, because losing a page un-reads nothing',
      knowledge.afterDrop.read === true, JSON.stringify(knowledge));
    check('undo restores what the search knew as well as the pages',
      knowledge.afterUndo.searched === true && knowledge.afterUndo.swept === 1,
      JSON.stringify(knowledge));

    // A reorganised document is not the file it came from, and a draft saved
    // for that file must not silently reapply to these pages.
    const stamped = await page.evaluate(() => window.Blinded.state.sourceDigest);
    check('an organised document no longer answers to the original digest',
      typeof stamped === 'string' && stamped.includes('+p'), String(stamped));

    // Put the panel back. Opening the sheet shuts every other section, and a
    // test that leaves it that way hands the next three hundred checks a panel
    // they did not ask for.
    await page.evaluate(() => {
      document.getElementById('organisesect').open = false;
      for (const sect of document.querySelectorAll('details.sect')) sect.open = true;
      document.getElementById('organisesect').open = false;
    });
  });

  // ---------- not inside somebody else's page ----------
  //
  // frame-ancestors is sent as a header because a meta policy cannot carry
  // it, and a header is a promise about one deployment. This is the promise
  // about the program: a copy served from anywhere that forgets the header
  // still refuses to run framed. What framing would buy is not the document —
  // that never leaves the tab either way — it is the chrome around the one
  // decision this tool exists to make, which button the finger lands on and
  // what the screen says is happening.
  await part("not inside somebody else's page", async () => {
    // From a page of its own, because the app's own policy says frame-src
    // 'none' — it will not frame anything, this included, so the frame has to
    // be built somewhere that is not Blinded. Driven through Playwright's
    // frame handle rather than by reaching into contentWindow: the refusal is
    // about a frame owned by somebody else, and a test that could only look
    // inside a same-origin one would not be testing the case that matters.
    const outer = await context.newPage();
    await outer.setContent('<iframe id="frametest" style="width:600px;height:400px" src="'
      + base + 'index.html"></iframe>');
    const inside = outer.frameLocator('#frametest');
    await inside.locator('.framed').waitFor({ timeout: 20000 });
    const away = await inside.locator('.framed a').getAttribute('href');
    const child = outer.frames().find(f => f !== outer.mainFrame()
      && f.url().includes('index.html'));
    const wired = child ? await child.evaluate(() => ({
      blinded: typeof window.Blinded,
      drop: Boolean(document.querySelector('#view-drop')),
      said: (document.querySelector('.framed h1') || {}).textContent,
    })) : null;
    await outer.close();
    check('framed, the app refuses to run',
      Boolean(wired) && /does not run inside another page/.test(wired.said),
      JSON.stringify(wired));
    check('and is not wired up at all behind the refusal',
      wired.blinded === 'undefined' && wired.drop === false, JSON.stringify(wired));
    check('with a way out to the canonical copy',
      away === 'https://blinded.onrender.com/', String(away));
  });

  // ---------- one section from the next ----------
  //
  // Five sections divided by a hairline the same colour as the panel's own
  // edge read as one long list: the reviewer could not see where Text ended
  // and Images began. Two cues now, measured rather than eyeballed — the
  // heading sits on a tint, and the rule between sections is darker than the
  // one round the panel.
  await part("one section from the next", async () => {
    const bands = await page.evaluate(() => {
      const luminance = colour => {
        const [r, g, b] = colour.match(/\d+/g).map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const sect = document.querySelector('details.sect');
      return {
        head: getComputedStyle(sect.querySelector('summary')).backgroundColor,
        panel: getComputedStyle(document.querySelector('.panel')).backgroundColor,
        rule: luminance(getComputedStyle(sect).borderBottomColor),
        edge: luminance(getComputedStyle(document.querySelector('.panel')).borderBottomColor),
      };
    });
    check('a section heading sits on its own band, not on the panel',
      bands.head !== bands.panel && !/rgba\(0, 0, 0, 0\)/.test(bands.head),
      JSON.stringify(bands));
    check('and the rule between sections is darker than the panel’s own edge',
      bands.rule < bands.edge - 8, JSON.stringify(bands));
  });

  // ---------- a text layer that says it more than once ----------
  //
  // Reported from a real CIM: a word marked four times on the page, counted
  // twenty-three times in the panel. Nothing was wrong with the marks. The
  // deck had been converted to PDF by something that re-emits each line five
  // or six times at identical coordinates, so the text layer really did hold
  // twenty-one copies of the name — and the count was reading the file's
  // duplicates as places in the document.
  await part("a text layer that says it more than once", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', stackedPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['KAG']);
    await page.waitForTimeout(300);

    const stacked = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      return {
        // What the file says, which is what makes this fixture worth having:
        // without duplicates in the text layer the rest passes vacuously.
        inFile: window.BlindedDetect.findTerms(p.text, ['KAG']).length,
        marks: p.hits.filter(h => h.finding.term === 'KAG').length,
        counted: B.occurrencesFor('KAG').length,
        pages: B.occurrencesFor('KAG').map(spot => spot.pageIndex),
      };
    });
    check('the fixture really does say it several times over',
      stacked.inFile === 7, JSON.stringify(stacked));
    check('but the page is marked once per place, not once per copy',
      stacked.marks === 2, JSON.stringify(stacked));
    check('and the count now agrees with the marks',
      stacked.counted === stacked.marks, JSON.stringify(stacked));
    check('with every place on the page it was found on',
      stacked.pages.every(i => i === 0), JSON.stringify(stacked));

    // The list under the tally is the same answer in longer form, so it has
    // to hold the same number of rows. The circle is a question mark until
    // something has looked, so this searches first.
    await redact(page);
    const listed = await page.evaluate(() => {
      const dot = document.querySelector('#termcounts .dot-green');
      if (dot) dot.click();
      return { rows: document.querySelectorAll('#termcounts .tallywhere li').length,
        said: dot ? dot.textContent : null };
    });
    check('the tally says what the page shows', listed.said === '2',
      JSON.stringify(listed));
    check('and its list has a row for each', listed.rows === 2, JSON.stringify(listed));
  });

  // ---------- the reading is not only for typed words ----------
  //
  // Reported: pick a logo, type nothing, press Search, and the text is
  // ignored. It was. The reading pass was gated on there being a typed word,
  // so with none the pages were never read — and every detector was answered
  // from the text layer alone, which on a scan says nothing at all. The panel
  // then reported no email addresses on a page that plainly shows one.
  //
  // The reading is one job with two customers: a word to find inside the
  // pictures, and every detector, which can only read what the page says once
  // something has read it.
  await part("the reading is not only for typed words", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', readablePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const armed = await page.evaluate(() => ({
      terms: window.Blinded.state.terms.length,
      pending: window.Blinded.ocrPending(),
      red: document.getElementById('search').classList.contains('hunt'),
      unknown: window.Blinded.unknownKinds(),
    }));
    check('with nothing typed there is still reading to do',
      armed.terms === 0 && armed.pending === true, JSON.stringify(armed));
    check('and the button is red, because the detectors are all question marks',
      armed.red === true && armed.unknown > 0, JSON.stringify(armed));

    await redact(page);
    const read = await page.evaluate(() => ({
      ocrRead: window.Blinded.state.ocrRead,
      pages: window.Blinded.state.pages.length,
      readPages: window.Blinded.state.pages.filter(p => p.ocrItems).length,
      known: window.Blinded.kindsKnown(),
      unknown: window.Blinded.unknownKinds(),
      found: Object.values(window.Blinded.countsByKind()).reduce((n, v) => n + v, 0),
      red: document.getElementById('search').classList.contains('hunt'),
    }));
    check('a search with nothing typed reads the pages anyway',
      read.ocrRead === true && read.readPages === read.pages, JSON.stringify(read));
    check('so the detectors have an answer rather than a question mark',
      read.known === true && read.unknown === 0 && read.found > 0,
      JSON.stringify(read));
    check('and the button stops being red once nothing is outstanding',
      read.red === false, JSON.stringify(read));
  });

  // ---------- a tally row is the mark, not just its page number ----------
  //
  // "Page 34" says where to look and nothing about what to look at: a page
  // can carry a dozen marks and the row is about one of them. Hovering the
  // row fills that one on the page, and a cross on the row says no to it
  // without travelling there.
  await part("a tally row is the mark, not just its page number", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Jane']);
    await useDetectors(page);
    await redact(page);
    await page.evaluate(() => window.Blinded.state.applied && window.Blinded.uncoverMarks());

    const opened = await page.evaluate(async () => {
      const dot = document.querySelector('#termcounts .n.dot-green');
      if (dot) dot.click();
      await new Promise(r => setTimeout(r, 120));
      const rows = [...document.querySelectorAll('#termcounts .tallywhere li')];
      // Measured, not assumed: the cross belongs beside the row, and it spent
      // a while under it instead, because the more specific of the two rules
      // governing these list items still said display: block.
      const seams = rows.map(li => {
        const cross = li.querySelector('.tallydrop');
        const spot = li.querySelector('.tallyspot');
        if (!cross || !spot) return null;
        const a = cross.getBoundingClientRect();
        const b = spot.getBoundingClientRect();
        return { sameLine: Math.abs(a.top - b.top) <= a.height,
                 toTheRight: a.left >= b.right - 2 };
      });
      return {
        rows: rows.length,
        hasCross: rows.every(li => Boolean(li.querySelector('.tallydrop'))),
        beside: seams.every(seam => seam && seam.sameLine && seam.toTheRight),
        seams: seams.slice(0, 2),
      };
    });
    check('a tally row carries a way to say no to that mark',
      opened.rows > 0 && opened.hasCross === true, JSON.stringify(opened));
    check('and it sits beside the row, not under it',
      opened.beside === true, JSON.stringify(opened.seams));

    const lit = await page.evaluate(async () => {
      const B = window.Blinded;
      const row = document.querySelector('#termcounts .tallywhere .tallyspot');
      row.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      const on = B.state.spotlight && { ...B.state.spotlight };
      // And what it lights is a real box on that page, not an id nothing
      // draws.
      const page0 = B.state.pages[on ? on.pageIndex : 0];
      const rects = on ? B.rectsOfMark(page0, on.mark).length : 0;
      row.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      return { on, rects, off: B.state.spotlight };
    });
    check('hovering a row lights the mark it stands for',
      Boolean(lit.on) && lit.rects > 0, JSON.stringify(lit));
    check('and letting go puts it out again', lit.off === null, JSON.stringify(lit));

    const dropped = await page.evaluate(async () => {
      const B = window.Blinded;
      const before = B.occurrencesFor('Jane').length;
      const dismissedBefore = B.state.pages.reduce((n, p) => n + p.dismissed.size, 0);
      document.querySelector('#termcounts .tallywhere .tallydrop').click();
      await new Promise(r => setTimeout(r, 150));
      const after = B.occurrencesFor('Jane').length;
      const label = (B.undoStack[B.undoStack.length - 1] || {}).label;
      B.undoLast();
      await new Promise(r => setTimeout(r, 100));
      return { before, after, label,
               dismissedBefore,
               dismissedAfter: B.state.pages.reduce((n, p) => n + p.dismissed.size, 0),
               backAgain: B.occurrencesFor('Jane').length };
    });
    check('the cross drops that one mark and only that one',
      dropped.after === dropped.before - 1, JSON.stringify(dropped));
    check('which is a reviewer decision, so it is undoable',
      /keeping that match/.test(dropped.label || '')
      && dropped.backAgain === dropped.before, JSON.stringify(dropped));
    check('and it leaves the rest of the page alone',
      dropped.dismissedAfter === dropped.dismissedBefore, JSON.stringify(dropped));

    await page.evaluate(() => { window.Blinded.state.openTally = null; });
  });

  // ---------- the sheet under the arrow keys ----------
  //
  // A selected page and a keyboard is most of a file browser, and every file
  // browser moves with the arrows. And a page thrown away must not leave the
  // reviewer with nothing selected in the middle of a job: they are working
  // through a document, and an empty selection asks them to find their place
  // again before they can throw away the next one.
  await part("the sheet under the arrow keys", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', manyPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 60000 });
    await page.evaluate(() => { document.getElementById('organisesect').open = true; });
    await page.waitForTimeout(120);

    const walked = await page.evaluate(async () => {
      const B = window.Blinded;
      const press = key => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      };
      const picked = () => B.pickedInOrder().map(p => p.index);
      // Nothing selected: the arrows are not the sheet's yet.
      B.state.picked = new Set();
      B.renderSheet();
      press('ArrowRight');
      const withNothing = picked();

      document.querySelectorAll('.sheetface')[3]
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      const start = picked();
      press('ArrowRight');
      const right = picked();
      press('ArrowLeft');
      const back = picked();
      const columns = B.sheetColumns();
      press('ArrowDown');
      const down = picked();
      press('ArrowUp');
      const up = picked();
      return { withNothing, start, right, back, columns, down, up,
               pages: B.state.pages.length };
    });
    check('with no page selected the arrows are not the sheet’s',
      walked.withNothing.length === 0, JSON.stringify(walked));
    check('right and left walk the document a page at a time',
      JSON.stringify(walked.right) === JSON.stringify([walked.start[0] + 1])
      && JSON.stringify(walked.back) === JSON.stringify(walked.start),
      JSON.stringify(walked));
    // Measured off the thumbnails as laid out, not assumed: how many fit on a
    // row depends on the panel's width.
    check('down and up move by a row of thumbnails',
      walked.columns >= 1
      && JSON.stringify(walked.down) === JSON.stringify([walked.start[0] + walked.columns])
      && JSON.stringify(walked.up) === JSON.stringify(walked.start),
      JSON.stringify(walked));

    const held = await page.evaluate(async () => {
      const B = window.Blinded;
      const from = B.state.pages[2];
      B.state.picked = new Set([from]);
      B.renderSheet();
      window.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 60));
      return B.pickedInOrder().map(p => p.index);
    });
    check('shift extends the selection the way it does with the mouse',
      JSON.stringify(held) === JSON.stringify([2, 3]), JSON.stringify(held));

    const afterDrop = await page.evaluate(async () => {
      const B = window.Blinded;
      const before = B.state.pages.length;
      const goingUid = B.state.pages[4].uid;
      const nextUid = B.state.pages[5].uid;
      B.state.picked = new Set([B.state.pages[4]]);
      B.renderSheet();
      B.dropPicked();
      await new Promise(r => setTimeout(r, 80));
      return { before, after: B.state.pages.length,
               gone: !B.state.pages.some(p => p.uid === goingUid),
               picked: B.pickedInOrder().map(p => p.uid),
               wanted: nextUid };
    });
    check('removing a page removes it', afterDrop.after === afterDrop.before - 1
      && afterDrop.gone === true, JSON.stringify(afterDrop));
    check('and selects the page that took its place',
      JSON.stringify(afterDrop.picked) === JSON.stringify([afterDrop.wanted]),
      JSON.stringify(afterDrop));

    // The end of the document is the one case where there is no next page.
    const atEnd = await page.evaluate(async () => {
      const B = window.Blinded;
      const last = B.state.pages[B.state.pages.length - 1];
      const before = last.uid;
      B.state.picked = new Set([last]);
      B.renderSheet();
      B.dropPicked();
      await new Promise(r => setTimeout(r, 80));
      const now = B.pickedInOrder();
      return { picked: now.map(p => p.index),
               isLast: now.length === 1 && now[0].index === B.state.pages.length - 1,
               removed: !B.state.pages.some(p => p.uid === before) };
    });
    check('throwing away the last page selects the new last one',
      atEnd.removed === true && atEnd.isLast === true, JSON.stringify(atEnd));

    await page.evaluate(() => {
      window.Blinded.state.picked = new Set();
      window.Blinded.renderSheet();
      document.getElementById('organisesect').open = false;
    });
  });

  // ---------- turning a page ----------
  //
  // A scan fed the wrong way is not a cosmetic problem here: the reader
  // cannot read sideways lettering, so a sideways page is a page the search
  // is blind on. The turn has to be real — the pixels themselves — and
  // everything measured against those pixels has to move with them or be
  // withdrawn.
  await part("turning a page", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 60000 });
    await page.evaluate(() => { document.getElementById('organisesect').open = true; });
    await page.waitForTimeout(80);

    const turned = await page.evaluate(() => {
      const B = window.Blinded;
      const first = B.state.pages[0];
      const was = { w: first.source.width, h: first.source.height,
        widthPt: first.widthPt, heightPt: first.heightPt,
        items: first.items.length, text: first.text.length };
      // A hand-drawn box, to see whether what is measured against the page
      // travels with it.
      first.manual.push({ id: 'turn-test', x: 10, y: 20, w: 30, h: 40 });
      B.state.searched = true;
      B.state.sweptTerms = ['whatever'];
      B.state.ocrRead = true;
      first.ocrText = 'read already';
      B.state.picked = new Set([first]);
      B.renderSheet();
      const offered = !document.getElementById('page-turn').disabled;
      document.getElementById('page-turn').click();
      const box = first.manual.find(m => m.id === 'turn-test');
      const wrap = first.canvas.parentElement;
      return {
        offered, was,
        now: { w: first.source.width, h: first.source.height,
          widthPt: first.widthPt, heightPt: first.heightPt },
        turn: first.turn,
        box,
        // Turned clockwise, the old bottom-left corner becomes the top left.
        wanted: { x: was.h - (20 + 40), y: 10, w: 40, h: 30 },
        shape: wrap.style.aspectRatio,
        layer: first.items.length,
        readAgain: first.ocrText === null && B.state.ocrRead === false,
        searched: B.state.searched,
        swept: B.state.sweptTerms.length,
        label: (B.undoStack[B.undoStack.length - 1] || {}).label,
      };
    });
    check('turning is offered once a page is selected', turned.offered === true);
    check('a turned page is the other way round',
      turned.now.w === turned.was.h && turned.now.h === turned.was.w,
      JSON.stringify(turned.now));
    check('and keeps its size on paper, turned with it',
      turned.now.widthPt === turned.was.heightPt
      && turned.now.heightPt === turned.was.widthPt, JSON.stringify(turned.now));
    check('the wrapper takes the new shape, so the document does not stretch',
      turned.shape === turned.now.w + ' / ' + turned.now.h, String(turned.shape));
    check('a mark drawn by hand turns with the pixels it was drawn over',
      turned.box.x === turned.wanted.x && turned.box.y === turned.wanted.y
      && turned.box.w === turned.wanted.w && turned.box.h === turned.wanted.h,
      JSON.stringify([turned.box, turned.wanted]));
    // The honest cost, asserted rather than hoped for: the text layer's runs
    // advance along the page's x axis, and turned they would be drawn across
    // the words instead of along them. So it goes, and the page is read again
    // from its new pixels.
    check('the text layer, which cannot be turned, is dropped',
      turned.layer === 0 && turned.was.items > 0, JSON.stringify(turned));
    check('and so is what was read off the page',
      turned.readAgain === true, JSON.stringify(turned));
    check('a turn withdraws the search rather than leaving it standing',
      turned.searched === false && turned.swept === 0, JSON.stringify(turned));
    check('and is undoable', turned.label === 'turning a page', String(turned.label));

    const back = await page.evaluate(() => {
      const B = window.Blinded;
      const first = B.state.pages[0];
      B.undoLast();
      return { w: first.source.width, h: first.source.height, turn: first.turn,
        items: first.items.length, box: first.manual.find(m => m.id === 'turn-test'),
        searched: B.state.searched, read: B.state.ocrRead,
        shape: first.canvas.parentElement.style.aspectRatio };
    });
    check('undoing a turn puts the pixels back',
      back.w === turned.was.w && back.h === turned.was.h && back.turn === 0,
      JSON.stringify(back));
    check('and the text layer with them, which turning four times would not',
      back.items === turned.was.items, JSON.stringify(back));
    check('and the box, and what the search knew',
      back.box.x === 10 && back.box.y === 20 && back.searched === true
      && back.read === true, JSON.stringify(back));
    check('and the wrapper goes back to the old shape',
      back.shape === turned.was.w + ' / ' + turned.was.h, String(back.shape));

    await page.evaluate(() => {
      const B = window.Blinded;
      B.state.pages[0].manual = B.state.pages[0].manual.filter(m => m.id !== 'turn-test');
      B.state.picked = new Set();
      B.renderSheet();
    });
  });

  // ---------- notes written on the page ----------
  //
  // One button, and after that the note is its own control: nothing is on
  // screen unless a note is in hand. The checks below are as much about what
  // is absent as about what works.
  await part("notes written on the page", async () => {
    const armed = await page.evaluate(() => {
      document.getElementById('page-text').click();
      const tip = document.getElementById('tip');
      return { placing: window.Blinded.state.placingText,
        said: tip.hidden === false && /tap the page/i.test(tip.textContent),
        pressed: document.getElementById('page-text').getAttribute('aria-pressed') };
    });
    check('Add a note arms the next tap on the page',
      armed.placing === true && armed.pressed === 'true', JSON.stringify(armed));
    check('and says so, because nothing else in the tool waits for a tap',
      armed.said === true, JSON.stringify(armed));

    const placed = await page.evaluate(() => {
      const B = window.Blinded;
      const canvas = B.state.pages[0].canvas;
      const box = canvas.getBoundingClientRect();
      // Down and up. A dispatched press with no release leaves the pinch
      // watcher holding a finger that never lifted, and everything after it
      // in this file is then a two-finger gesture.
      for (const type of ['pointerdown', 'pointerup']) {
        canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 71,
          clientX: box.left + box.width * 0.25, clientY: box.top + box.height * 0.4 }));
      }
      const note = B.notesOf(B.state.pages[0])[0];
      return {
        notes: B.notesOf(B.state.pages[0]).length,
        placing: B.state.placingText,
        editing: B.state.textEdit === note.id,
        chips: document.querySelectorAll('.notechip').length,
        writing: document.querySelectorAll('.notewrite').length,
        focused: document.activeElement && document.activeElement.className,
        // Placed where it was tapped, in the page's own pixels.
        near: Math.abs(note.x - B.state.pages[0].source.width * 0.25)
          < B.state.pages[0].source.width * 0.02,
        label: (B.undoStack[B.undoStack.length - 1] || {}).label,
      };
    });
    check('tapping the page puts a note there',
      placed.notes === 1 && placed.near === true, JSON.stringify(placed));
    // It used to be one tap and out. It cannot be: a note is only movable,
    // rewritable and removable while its tool is in hand, so disarming after
    // the first one would put the note out of reach the moment it existed.
    check('the tool stays in hand, because that is what a note can be edited from',
      placed.placing === true, JSON.stringify(placed));
    check('and the caret is already in it, so typing is the next thing that happens',
      placed.editing === true && placed.writing === 1
      && placed.focused === 'notewrite', JSON.stringify(placed));
    check('adding a note is undoable', placed.label === 'the note you added',
      String(placed.label));

    const typed = await page.evaluate(async () => {
      const B = window.Blinded;
      const area = document.querySelector('.notewrite');
      area.value = 'Covered at the request of the board.';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      const note = B.notesOf(B.state.pages[0])[0];
      const whileWriting = B.notesToDraw(B.state.pages[0]).length;
      area.blur();
      await new Promise(r => setTimeout(r, 30));
      return { text: note.text, whileWriting,
        afterwards: B.notesToDraw(B.state.pages[0]).length,
        editing: B.state.textEdit, writing: document.querySelectorAll('.notewrite').length };
    });
    check('what is typed is the note', typed.text === 'Covered at the request of the board.',
      JSON.stringify(typed));
    // Otherwise the words are drawn twice, half a pixel apart, and the note
    // looks like a printing fault while it is being written.
    check('the canvas leaves the note being typed to its own textarea',
      typed.whileWriting === 0, JSON.stringify(typed));
    check('and takes it back when the caret leaves',
      typed.afterwards === 1 && typed.editing === null && typed.writing === 0,
      JSON.stringify(typed));

    // Still in hand after the caret leaves it, which is the useful place to
    // be: the colour and the size are the next thing anyone reaches for.
    const after = await page.evaluate(() => ({
      bars: document.querySelectorAll('.notebar').length,
      selected: window.Blinded.state.textSel !== null,
    }));
    check('a note just written is still in hand', after.bars === 1
      && after.selected === true, JSON.stringify(after));

    const bare = await page.evaluate(() => {
      document.querySelector('.panel').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 72 }));
      return {
        bars: document.querySelectorAll('.notebar').length,
        grabs: document.querySelectorAll('.notegrab').length,
        selected: window.Blinded.state.textSel,
        notes: window.Blinded.notesOf(window.Blinded.state.pages[0]).length,
      };
    });
    check('touching anything else puts it down, and nothing is left standing over the page',
      bare.bars === 0 && bare.grabs === 0 && bare.selected === null
      && bare.notes === 1, JSON.stringify(bare));

    const held = await page.evaluate(() => {
      const box = document.querySelector('.notechip').getBoundingClientRect();
      for (const type of ['pointerdown', 'pointerup']) {
        // Looked up again between the two: picking a note up rebuilds it, and
        // releasing on the element that has been replaced is a release the
        // page never hears — which on a real phone is a finger the pinch
        // watcher goes on holding.
        document.querySelector('.notechip').dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerId: 73,
            clientX: box.left + 4, clientY: box.top + 4 }));
      }
      const now = document.querySelector('.notechip');
      return {
        on: now.classList.contains('on'),
        dots: now.querySelectorAll('.notedot').length,
        steps: now.querySelectorAll('.notestep').length,
        grabs: now.querySelectorAll('.notegrab').length,
        selected: window.Blinded.state.textSel !== null,
        writing: document.querySelectorAll('.notewrite').length,
      };
    });
    check('touching a note puts it in hand, with its controls over it',
      held.on === true && held.selected === true && held.dots === 4
      && held.steps === 3 && held.grabs === 1, JSON.stringify(held));
    check('but does not put the caret in it, or every note touched would open',
      held.writing === 0, JSON.stringify(held));

    const restyled = await page.evaluate(() => {
      const B = window.Blinded;
      const note = B.notesOf(B.state.pages[0])[0];
      const was = { colour: note.colour, size: note.size };
      document.querySelectorAll('.notedot')[2].click();
      document.querySelectorAll('.notestep')[1].click();
      return { was, colour: note.colour, size: note.size,
        marked: document.querySelectorAll('.notedot.on').length,
        label: (B.undoStack[B.undoStack.length - 1] || {}).label };
    });
    check('the colour is a dot away', restyled.colour === '#c0392b'
      && restyled.was.colour !== restyled.colour, JSON.stringify(restyled));
    check('and the size a press away', restyled.size > restyled.was.size,
      JSON.stringify(restyled));
    check('with the colour it is written in marked as chosen',
      restyled.marked === 1, JSON.stringify(restyled));
    check('and both undoable', restyled.label === 'that size', String(restyled.label));

    // The note is painted by the function the export uses, which is the only
    // reason the preview can be trusted to be the file.
    const inked = await page.evaluate(() => {
      const R = window.BlindedRender;
      const blank = document.createElement('canvas');
      blank.width = 200; blank.height = 80;
      const ctx = blank.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 200, 80);
      const flat = R.flatten(blank, [], [{ x: 8, y: 8, w: 180, size: 18,
        colour: '#000000', text: 'Removed by request' }]);
      const data = flat.getContext('2d').getImageData(0, 0, 200, 80).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 120) dark++;
      const tall = R.textBox({ x: 0, y: 0, w: 80, size: 18, text: 'one two three four five six' });
      const short = R.textBox({ x: 0, y: 0, w: 80, size: 18, text: 'one' });
      return { dark, tall: tall.h, short: short.h };
    });
    check('a note is burned into the exported picture', inked.dark > 40,
      JSON.stringify(inked));
    check('and wraps inside the width it was given',
      inked.tall > inked.short * 2, JSON.stringify(inked));

    const gone = await page.evaluate(() => {
      const B = window.Blinded;
      document.querySelector('.notebin').click();
      const after = B.notesOf(B.state.pages[0]).length;
      B.undoLast();
      return { after, back: B.notesOf(B.state.pages[0]).length,
        bars: document.querySelectorAll('.notebar').length };
    });
    check('the bin removes the note it belongs to', gone.after === 0, JSON.stringify(gone));
    check('undo brings it back', gone.back === 1, JSON.stringify(gone));
    check('and takes its controls with it', gone.bars === 0, JSON.stringify(gone));

    // An empty note is nothing but an invisible thing to trip over later.
    const dropped = await page.evaluate(async () => {
      const B = window.Blinded;
      const page0 = B.state.pages[0];
      const before = B.notesOf(page0).length;
      B.addNoteAt(page0, 40, 40);
      const made = B.notesOf(page0).length;
      B.commitNote();
      return { before, made, after: B.notesOf(page0).length };
    });
    check('a note left empty is thrown away rather than kept',
      dropped.made === dropped.before + 1 && dropped.after === dropped.before,
      JSON.stringify(dropped));

    // A note belongs to its tool too. With the tool put away the note is part
    // of the page — drawn on it, carried into the export — and not something a
    // press meant for the document can pick up, retype or drag away.
    const inert = await page.evaluate(async () => {
      const B = window.Blinded;
      B.stopPlacingText();
      await new Promise(r => setTimeout(r, 60));
      const chip = document.querySelector('.notechip');
      const away = getComputedStyle(chip).pointerEvents;
      const letGo = B.state.textSel;
      B.startPlacingText();
      await new Promise(r => setTimeout(r, 60));
      const armed = getComputedStyle(document.querySelector('.notechip')).pointerEvents;
      B.stopPlacingText();
      return { away, armed, letGo };
    });
    check('a note cannot be taken hold of with its tool put away',
      inert.away === 'none', JSON.stringify(inert));
    check('and putting the tool away lets go of whatever was in hand',
      inert.letGo === null, JSON.stringify(inert));
    check('while with the tool in hand it can', inert.armed === 'auto',
      JSON.stringify(inert));

    // A note is the reviewer's, not the document's, so it belongs in a draft.
    const kept = await page.evaluate(() => {
      const B = window.Blinded;
      const saved = B.draftData();
      return { texts: saved.pages[0].texts.length,
        turn: saved.pages[0].turn,
        said: saved.pages[0].texts[0] && saved.pages[0].texts[0].text };
    });
    check('a draft carries the notes and the turn',
      kept.texts === 1 && kept.turn === 0
      && kept.said === 'Covered at the request of the board.', JSON.stringify(kept));

    await page.evaluate(() => {
      const B = window.Blinded;
      B.state.pages[0].texts = [];
      B.selectNote(null);
      B.renderNotes(B.state.pages[0]);
      document.getElementById('organisesect').open = false;
      for (const sect of document.querySelectorAll('details.sect')) sect.open = true;
      document.getElementById('organisesect').open = false;
    });
  });

  // ---------- drawing on the page by hand ----------
  //
  // The same bargain as a note: one button arms it, and the choices about how
  // the thing looks appear beside the thing once it exists. Nothing is offered
  // before the first stroke, because before the first stroke there is nothing
  // to offer it about.
  await part("drawing on the page by hand", async () => {
    const armed = await page.evaluate(() => {
      document.getElementById('page-draw').click();
      const tip = document.getElementById('tip');
      return { inking: window.Blinded.state.inking,
        said: tip.hidden === false && /draw on the page/i.test(tip.textContent),
        pressed: document.getElementById('page-draw').getAttribute('aria-pressed') };
    });
    check('the pen arms the next press on the page',
      armed.inking === true && armed.pressed === 'true', JSON.stringify(armed));
    check('and says how to put it away again', armed.said === true, JSON.stringify(armed));

    // The first press is not a line. It puts the colours and the thickness on
    // the page and leaves the page alone, so the choosing happens before the
    // drawing rather than being corrected after it.
    const first = await page.evaluate(async () => {
      const B = window.Blinded;
      const canvas = B.state.pages[0].canvas;
      const box = canvas.getBoundingClientRect();
      const at = (fx, fy) => ({ clientX: box.left + box.width * fx,
                                clientY: box.top + box.height * fy });
      for (const type of ['pointerdown', 'pointerup']) {
        canvas.dispatchEvent(new PointerEvent(type,
          { bubbles: true, pointerId: 80, ...at(0.6, 0.62) }));
      }
      await new Promise(r => setTimeout(r, 60));
      return { inks: B.inksOf(B.state.pages[0]).length,
        bars: document.querySelectorAll('.inkfresh .notebar').length,
        dots: document.querySelectorAll('.inkfresh .notedot').length,
        nib: document.querySelectorAll('.inkfresh .inknib').length };
    });
    check('the first press leaves no mark on the page',
      first.inks === 0, JSON.stringify(first));
    check('it brings up the colours and the thickness instead',
      first.bars === 1 && first.dots === 4, JSON.stringify(first));
    check('with a sample of the line it is about to draw',
      first.nib === 1, JSON.stringify(first));

    // And those controls work, which is the whole reason they are there
    // before the first line rather than after it.
    const chose = await page.evaluate(async () => {
      const B = window.Blinded;
      document.querySelectorAll('.inkfresh .notedot')[2].click();
      const thicker = [...document.querySelectorAll('.inkfresh .notestep')]
        .find(b => b.title === 'Thicker');
      thicker.click();
      await new Promise(r => setTimeout(r, 60));
      const canvas = B.state.pages[0].canvas;
      const box = canvas.getBoundingClientRect();
      const at = (fx, fy) => ({ clientX: box.left + box.width * fx,
                                clientY: box.top + box.height * fy });
      canvas.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, pointerId: 82, ...at(0.6, 0.72) }));
      for (let i = 1; i <= 6; i++) {
        canvas.dispatchEvent(new PointerEvent('pointermove',
          { bubbles: true, pointerId: 82, ...at(0.6 + 0.02 * i, 0.72) }));
      }
      canvas.dispatchEvent(new PointerEvent('pointerup',
        { bubbles: true, pointerId: 82, ...at(0.72, 0.72) }));
      await new Promise(r => setTimeout(r, 60));
      const ink = B.inksOf(B.state.pages[0])[0];
      const wide = B.state.pages[0].source.width;
      return { colour: ink && ink.colour, width: ink && ink.width, wide,
        fresh: document.querySelectorAll('.inkfresh').length };
    });
    check('what is chosen there is what the next line is drawn in',
      chose.colour === '#1a56db' && chose.width > chose.wide / 280,
      JSON.stringify(chose));
    check('and the controls give up their place to the line',
      chose.fresh === 0, JSON.stringify(chose));

    await page.evaluate(() => {
      const B = window.Blinded;
      B.state.pages[0].inks = [];
      B.selectInk(null);
      B.renderNotes(B.state.pages[0]);
    });

    // Down, along, up. Released for the same reason the note test releases:
    // a press left holding makes every gesture after it a pinch.
    const drawn = await page.evaluate(() => {
      const B = window.Blinded;
      const canvas = B.state.pages[0].canvas;
      const box = canvas.getBoundingClientRect();
      const at = (fx, fy) => ({ clientX: box.left + box.width * fx,
                                clientY: box.top + box.height * fy });
      canvas.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, pointerId: 81, ...at(0.2, 0.3) }));
      for (let i = 1; i <= 10; i++) {
        canvas.dispatchEvent(new PointerEvent('pointermove',
          { bubbles: true, pointerId: 81, ...at(0.2 + 0.03 * i, 0.3 + 0.02 * i) }));
      }
      canvas.dispatchEvent(new PointerEvent('pointerup',
        { bubbles: true, pointerId: 81, ...at(0.5, 0.5) }));
      const inks = B.inksOf(B.state.pages[0]);
      return { count: inks.length,
        points: inks[0] ? inks[0].points.length : 0,
        chosen: B.state.inkSel === (inks[0] && inks[0].id),
        chips: document.querySelectorAll('.inkchip').length,
        bars: document.querySelectorAll('.inkchip .notebar').length,
        stillArmed: B.state.inking,
        label: (B.undoStack[B.undoStack.length - 1] || {}).label };
    });
    check('a drag across the page leaves a line', drawn.count === 1 && drawn.points > 2,
      JSON.stringify(drawn));
    check('the colours and the thickness arrive with the first stroke, not before',
      drawn.chosen === true && drawn.chips === 1 && drawn.bars === 1,
      JSON.stringify(drawn));
    check('and the pen stays in hand for the next one',
      drawn.stillArmed === true, JSON.stringify(drawn));
    check('drawing a line is undoable', drawn.label === 'the line you drew',
      String(drawn.label));

    const styled = await page.evaluate(() => {
      const B = window.Blinded;
      const ink = B.inksOf(B.state.pages[0])[0];
      const was = { colour: ink.colour, width: ink.width };
      document.querySelectorAll('.inkchip .notedot')[3].click();
      const thicker = [...document.querySelectorAll('.inkchip .notestep')]
        .find(b => b.title === 'Thicker');
      thicker.click();
      const now = B.inksOf(B.state.pages[0])[0];
      return { was, colour: now.colour, width: now.width };
    });
    check('a colour can be chosen for the line that was drawn',
      styled.colour !== styled.was.colour, JSON.stringify(styled));
    check('and a thickness', styled.width > styled.was.width, JSON.stringify(styled));

    const away = await page.evaluate(() => {
      const B = window.Blinded;
      window.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Escape', bubbles: true, cancelable: true }));
      return { inking: B.state.inking,
        pressed: document.getElementById('page-draw').getAttribute('aria-pressed') };
    });
    check('Escape puts the pen away', away.inking === false && away.pressed === 'false',
      JSON.stringify(away));

    // The point of all of it: what is drawn on screen is drawn into the file,
    // by the same function, so it cannot be one shape in the preview and
    // another in the export.
    const burned = await page.evaluate(() => {
      const R = window.BlindedRender;
      const blank = document.createElement('canvas');
      blank.width = 200; blank.height = 80;
      const ctx = blank.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 200, 80);
      const flat = R.flatten(blank, [], [], [{ colour: '#c0392b', width: 6,
        points: [{ x: 10, y: 10 }, { x: 90, y: 40 }, { x: 180, y: 20 }] }]);
      const data = flat.getContext('2d').getImageData(0, 0, 200, 80).data;
      let red = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 120 && data[i + 1] < 110 && data[i + 2] < 110) red++;
      }
      const dot = R.flatten(blank, [], [], [{ colour: '#111111', width: 10,
        points: [{ x: 100, y: 40 }] }]);
      const dots = dot.getContext('2d').getImageData(90, 30, 20, 20).data;
      let dark = 0;
      for (let i = 0; i < dots.length; i += 4) if (dots[i] < 90) dark++;
      const box = R.inkBox({ width: 4, points: [{ x: 10, y: 20 }, { x: 50, y: 60 }] });
      return { red, dark, box };
    });
    check('a line is burned into the exported picture', burned.red > 100,
      JSON.stringify(burned));
    check('and a press with no drag leaves a dot rather than nothing',
      burned.dark > 20, JSON.stringify(burned));
    check('a line knows the box it occupies, controls included',
      burned.box.x === 8 && burned.box.w === 44, JSON.stringify(burned));

    // The line is the reviewer's, not the document's, so it belongs in a
    // draft — and a draft is still a few kilobytes, which is why the samples
    // are thinned as the hand moves.
    const kept = await page.evaluate(() => {
      const B = window.Blinded;
      const saved = B.draftData();
      return { inks: saved.pages[0].inks.length,
        points: saved.pages[0].inks[0] ? saved.pages[0].inks[0].points.length : 0 };
    });
    check('a draft carries the lines that were drawn',
      kept.inks === 1 && kept.points > 2, JSON.stringify(kept));

    const gone = await page.evaluate(() => {
      const B = window.Blinded;
      document.querySelector('.inkchip .notebin').click();
      const after = B.inksOf(B.state.pages[0]).length;
      B.undoLast();
      return { after, back: B.inksOf(B.state.pages[0]).length,
        bars: document.querySelectorAll('.inkchip .notebar').length };
    });
    check('the cross removes the line it belongs to', gone.after === 0, JSON.stringify(gone));
    check('undo brings the line back', gone.back === 1, JSON.stringify(gone));
    check('and the controls go with the line', gone.bars === 0, JSON.stringify(gone));

    // A line belongs to the pen, the way a note belongs to the note tool: with
    // the pen in hand a press chooses one, and with the pen away a press on
    // the page is the document's again and the line is part of the picture.
    const chosen = await page.evaluate(async () => {
      const B = window.Blinded;
      B.selectInk(null);
      B.startInking();
      const page0 = B.state.pages[0];
      const ink = B.inksOf(page0)[0];
      const spot = ink.points[Math.floor(ink.points.length / 2)];
      const canvas = page0.canvas;
      const box = canvas.getBoundingClientRect();
      const press = { clientX: box.left + (spot.x / page0.source.width) * box.width,
                      clientY: box.top + (spot.y / page0.source.height) * box.height };
      for (const type of ['pointerdown', 'pointerup']) {
        canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 84, ...press }));
      }
      await new Promise(r => setTimeout(r, 80));
      const onIt = B.state.inkSel === ink.id;
      const bars = document.querySelectorAll('.inkchip .notebar').length;
      const takeable = getComputedStyle(document.querySelector('.inkchip.on')).cursor;
      // Moved by the chip round it, which is the handle a chosen line gets.
      const chip = document.querySelector('.inkchip.on');
      const from = { ...ink.points[0] };
      chip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 86,
        clientX: press.clientX, clientY: press.clientY }));
      chip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 86,
        clientX: press.clientX + 60, clientY: press.clientY + 30 }));
      chip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 86,
        clientX: press.clientX + 60, clientY: press.clientY + 30 }));
      await new Promise(r => setTimeout(r, 80));
      const now = B.inksOf(page0)[0].points[0];
      const shifted = Math.round(now.x - from.x) > 10 && Math.round(now.y - from.y) > 5;
      const moveLabel = (B.undoStack[B.undoStack.length - 1] || {}).label;
      B.undoLast();
      const putBack = Math.abs(B.inksOf(page0)[0].points[0].x - from.x) < 1;
      // The pen away, and the line is part of the picture again: a press on it
      // is the document's, and nothing is chosen.
      B.stopInking();
      for (const type of ['pointerdown', 'pointerup']) {
        canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 85, ...press }));
      }
      await new Promise(r => setTimeout(r, 80));
      return { onIt, bars, takeable, shifted, moveLabel, putBack,
        afterwards: B.state.inkSel };
    });
    check('with the pen in hand a press on a line chooses it',
      chosen.onIt === true && chosen.bars === 1, JSON.stringify(chosen));
    check('and the chosen line says it can be picked up',
      chosen.takeable === 'move', JSON.stringify(chosen));
    check('dragging it moves the whole line', chosen.shifted === true,
      JSON.stringify(chosen));
    check('and moving it is undoable',
      chosen.moveLabel === 'moving that line' && chosen.putBack === true,
      JSON.stringify(chosen));
    check('with the pen put away a line cannot be chosen at all',
      chosen.afterwards === null, JSON.stringify(chosen));

    // Both page tools belong to the sheet. Going back to the words puts them
    // down, or the next press on the document does something the reviewer
    // stopped asking for several clicks ago.
    const putDown = await page.evaluate(async () => {
      const B = window.Blinded;
      const sheet = document.getElementById('organisesect');
      sheet.open = true;
      await new Promise(r => setTimeout(r, 60));
      document.getElementById('page-draw').click();
      document.getElementById('page-text').click();
      const armed = { ink: B.state.inking, note: B.state.placingText };
      // Whichever was armed last; both are put away by the same move.
      document.getElementById('page-draw').click();
      const bothOn = { ink: B.state.inking, note: B.state.placingText };
      sheet.open = false;
      await new Promise(r => setTimeout(r, 80));
      const shut = { ink: B.state.inking, note: B.state.placingText };
      return { armed, bothOn, shut };
    });
    check('arming the pen puts the note down, and the other way round',
      putDown.armed.note === true && putDown.armed.ink === false,
      JSON.stringify(putDown));
    check('closing Organise puts both page tools down',
      putDown.shut.ink === false && putDown.shut.note === false,
      JSON.stringify(putDown));

    await page.evaluate(() => {
      const B = window.Blinded;
      B.state.pages[0].inks = [];
      B.selectInk(null);
      B.renderNotes(B.state.pages[0]);
    });
  });

  // ---------- zooming keeps you where you were ----------
  //
  // Every page changes height when the zoom does, so a scroll position measured
  // in pixels means something different afterwards. Reported from a real
  // document: on page nine, zoom in, and you are looking at page seven —
  // leaning in to see something closer takes you somewhere else entirely.
  await part("zooming keeps you where you were", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', manyPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 60000 });

    const held = await page.evaluate(async () => {
      const B = window.Blinded;
      const host = document.getElementById('pages');
      const sc = B.scrollerFor(host);
      const topPage = () => {
        const edge = sc === window ? 0 : sc.getBoundingClientRect().top;
        const kids = [...host.children];
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].getBoundingClientRect().bottom > edge + 1) return i + 1;
        }
        return kids.length;
      };
      B.setZoom(1);
      await new Promise(r => setTimeout(r, 150));
      B.goToPage(8);                                  // page 9
      await new Promise(r => setTimeout(r, 1200));    // the scroll is smooth
      const before = topPage();
      B.stepZoom(1);
      await new Promise(r => setTimeout(r, 200));
      const zoomedIn = topPage();
      B.stepZoom(-1);
      await new Promise(r => setTimeout(r, 200));
      const zoomedOut = topPage();
      B.setZoom(1);
      return { pages: host.children.length, before, zoomedIn, zoomedOut };
    });
    // Without somewhere to get lost, the rest would pass vacuously.
    check('the document is long enough to lose your place in',
      held.pages >= 10, JSON.stringify(held));
    check('and deep enough into it to notice',
      held.before >= 8, JSON.stringify(held));
    check('zooming in leaves you on the page you were reading',
      held.zoomedIn === held.before, JSON.stringify(held));
    check('and zooming out too', held.zoomedOut === held.before, JSON.stringify(held));
  });

  // ---------- a page at a time ----------
  //
  // Scrolling lands somewhere in a page; these land on one, which is what is
  // wanted when the job is "check the next one".
  await part("a page at a time", async () => {
    const paging = await page.evaluate(async () => {
      const B = window.Blinded;
      const host = document.getElementById('pages');
      const sc = B.scrollerFor(host);
      const topPage = () => {
        const edge = sc === window ? 0 : sc.getBoundingClientRect().top;
        const kids = [...host.children];
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].getBoundingClientRect().bottom > edge + 1) return i + 1;
        }
        return kids.length;
      };
      const settle = () => new Promise(r => setTimeout(r, 900));
      B.goToPage(0);
      await settle();
      const start = topPage();
      document.getElementById('page-next').click();
      await settle();
      const next = topPage();
      document.getElementById('page-next').click();
      await settle();
      const twice = topPage();
      document.getElementById('page-prev').click();
      await settle();
      const back = topPage();
      // And it stops at the ends rather than running off them.
      B.goToPage(0);
      await settle();
      document.getElementById('page-prev').click();
      await settle();
      const atTheTop = topPage();
      return { start, next, twice, back, atTheTop };
    });
    check('the down arrow goes to the next page',
      paging.next === paging.start + 1, JSON.stringify(paging));
    check('and again', paging.twice === paging.start + 2, JSON.stringify(paging));
    check('the up arrow comes back', paging.back === paging.twice - 1,
      JSON.stringify(paging));
    check('and the first page is as far back as it goes',
      paging.atTheTop === 1, JSON.stringify(paging));

    // Two buttons in one icon's worth of room, to the right of the crosshair.
    const shape = await page.evaluate(() => {
      const up = document.getElementById('page-prev').getBoundingClientRect();
      const down = document.getElementById('page-next').getBoundingClientRect();
      const mark = document.getElementById('tool-mark').getBoundingClientRect();
      const zoom = document.getElementById('zoom-out').getBoundingClientRect();
      const cell = document.querySelector('.toolstack').getBoundingClientRect();
      return {
        stacked: down.top >= up.bottom - 1,
        sameWidth: Math.abs((up.width + down.width) / 2 - mark.width) < 3,
        // The cell they share is one icon, the same as every other in the row.
        together: Math.abs(cell.height - mark.height) < 1
          && Math.abs(cell.width - mark.width) < 1,
        afterTheCrosshair: up.left >= mark.right - 1 && up.left < zoom.left,
        gone: document.getElementById('restart') === null,
      };
    });
    check('the arrows are stacked, up above down',
      shape.stacked === true, JSON.stringify(shape));
    check('in one icon\'s worth of room',
      shape.sameWidth === true && shape.together === true, JSON.stringify(shape));
    check('to the right of the crosshair',
      shape.afterTheCrosshair === true, JSON.stringify(shape));
    check('and the new-file icon has left the toolbar',
      shape.gone === true, JSON.stringify(shape));

    // It is a div holding two buttons, so it misses the rounding every other
    // icon gets from being a button — which left one square-cornered cell in a
    // row of rounded ones.
    const dressed = await page.evaluate(() => {
      const cell = getComputedStyle(document.querySelector('.toolstack'));
      const other = getComputedStyle(document.getElementById('zoom-out'));
      return { radius: cell.borderTopLeftRadius, otherRadius: other.borderTopLeftRadius,
               border: cell.borderTopColor, otherBorder: other.borderTopColor,
               clipped: cell.overflow };
    });
    check('the cell is rounded and bordered like every other icon',
      dressed.radius === dressed.otherRadius && dressed.border === dressed.otherBorder,
      JSON.stringify(dressed));

    // Hovering one arrow answers that arrow. The wrapper carries the .tool
    // class for its border and size, and the whole-cell hover was firing on it
    // — greying both halves for a pointer that was over one.
    const hovered = await page.evaluate(async () => {
      const read = () => {
        const up = getComputedStyle(document.getElementById('page-prev')).backgroundColor;
        const down = getComputedStyle(document.getElementById('page-next')).backgroundColor;
        const cell = getComputedStyle(document.querySelector('.toolstack')).backgroundColor;
        return { up, down, cell };
      };
      const rest = read();
      document.getElementById('page-prev').classList.add('probe-hover');
      return { rest };
    });
    await page.hover('#page-prev');
    await page.waitForTimeout(120);
    const onUp = await page.evaluate(() => ({
      up: getComputedStyle(document.getElementById('page-prev')).backgroundColor,
      down: getComputedStyle(document.getElementById('page-next')).backgroundColor,
    }));
    await page.hover('#page-next');
    await page.waitForTimeout(120);
    const onDown = await page.evaluate(() => ({
      up: getComputedStyle(document.getElementById('page-prev')).backgroundColor,
      down: getComputedStyle(document.getElementById('page-next')).backgroundColor,
    }));
    await page.mouse.move(5, 600);
    check('hovering the up arrow greys the top half',
      onUp.up !== hovered.rest.up, JSON.stringify({ rest: hovered.rest, onUp }));
    check('and leaves the bottom half alone',
      onUp.down === hovered.rest.down, JSON.stringify({ rest: hovered.rest, onUp }));
    check('hovering the down arrow greys the bottom half',
      onDown.down !== hovered.rest.down, JSON.stringify({ rest: hovered.rest, onDown }));
    check('and leaves the top half alone',
      onDown.up === hovered.rest.up, JSON.stringify({ rest: hovered.rest, onDown }));
  });

  // ---------- starting over, from the header ----------
  await part("starting over, from the header", async () => {
    const reset = await page.evaluate(() => {
      const button = document.getElementById('reset-top');
      const faq = document.getElementById('faq-open');
      const r = button.getBoundingClientRect();
      const f = faq.getBoundingClientRect();
      return {
        shown: !button.hidden,
        leftOfTheQuestions: r.right <= f.left + 1,
        inTheHeader: button.closest('.top') !== null,
        says: button.textContent.trim(),
      };
    });
    check('a loaded document gets a Reset in the header',
      reset.shown === true && reset.inTheHeader === true, JSON.stringify(reset));
    check('on the left of the questions', reset.leftOfTheQuestions === true,
      JSON.stringify(reset));
    check('and it says Reset', reset.says === 'Reset', reset.says);
  });

  // ---------- a locked file ----------
  //
  // Really encrypted, not a mocked exception: RC4 with a standard security
  // handler, the thing an office suite produced a decade ago. A reviewer with
  // one of these used to be told the file could not be opened, and left to go
  // and strip the password somewhere else — which for a confidential document
  // means uploading it to a stranger, the one thing this tool exists to avoid.
  await part("a locked file", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', lockedPath);
    await page.waitForSelector('#passbox:not([hidden])', { timeout: 30000 });
    check('a locked PDF asks for its password instead of failing',
      await page.isVisible('#passbox'));
    check('and says nothing about the file being broken',
      (await page.isVisible('#drop-error')) === false,
      await page.textContent('#drop-error'));
    // A password box on a web page is exactly the thing people are right to be
    // wary of, so the box says where the password goes.
    check('the box says the password stays in this tab',
      /never sent anywhere|in this tab/i.test(await page.textContent('#passnote')),
      await page.textContent('#passnote'));
    check('and the field is a password field, not a text one',
      await page.getAttribute('#password', 'type') === 'password');

    // The wrong one. This used to come back as "ArrayBuffer is already
    // detached", because pdf.js transfers the buffer to its worker and the
    // retry had nothing left to send — so a mistyped password reported a
    // broken file.
    await page.fill('#password', 'nope');
    await page.click('#passgo');
    await page.waitForTimeout(1200);
    check('a wrong password asks again rather than giving up',
      await page.isVisible('#passbox'));
    check('and says so',
      /did not open/i.test(await page.textContent('#passnote')),
      await page.textContent('#passnote'));
    check('still without claiming the file is broken',
      (await page.isVisible('#drop-error')) === false,
      await page.textContent('#drop-error'));

    await page.fill('#password', 'letmein');
    await page.click('#passgo');
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 60000 });
    const opened = await page.evaluate(() => ({
      pages: window.Blinded.state.pages.length,
      text: (window.Blinded.state.pages[0].items || []).map(i => i.str).join(' '),
      field: document.getElementById('password').value,
      boxShut: document.getElementById('passbox').hidden,
    }));
    check('the right password opens it', opened.pages === 1, JSON.stringify(opened));
    check('with its text there to search',
      /locked document/i.test(opened.text), opened.text.slice(0, 80));
    check('and the box is put away', opened.boxShut === true);
    // Not left sitting in the DOM for the rest of the session.
    check('the password is not left in the field', opened.field === '');

    // Cancelling is a decision, not a failure: saying "that file could not be
    // opened" to someone who has just pressed Cancel tells them something they
    // know, in the voice of a fault.
    await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', lockedPath);
    await page.waitForSelector('#passbox:not([hidden])', { timeout: 30000 });
    await page.click('#passcancel');
    await page.waitForTimeout(600);
    check('cancelling goes back to the drop page',
      await page.isVisible('#view-drop'));
    check('without reporting a fault',
      (await page.isVisible('#drop-error')) === false,
      await page.textContent('#drop-error'));
  });

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
      // No section-wide image slider either: the bar moved onto each
      // picked image's own row.
      sharedImageControl: Boolean(document.getElementById('sens')),
      base: B.wordSensitivity(),
      shortBar: B.wordBarFor('KAG'),
      longBar: B.wordBarFor('proprietary'),
      phraseBar: B.wordBarFor('proprietary innovation'),
    };
  });
  check('the word sensitivity control is gone', bars.wordControl === false);
  check('and so is the one slider that governed every picked image at once',
    bars.sharedImageControl === false);
  // A three-letter acronym is held *above* the measured bar, not at it: KAS
  // correlates happily inside TEXAS, and the shape pass is the one that
  // cannot read what it is looking at. Length relief still applies to a long
  // word, which scores lower for honest reasons.
  check('the fallback holds a short acronym above the measured bar',
    bars.shortBar > bars.base, JSON.stringify(bars));
  check('and still lets a long word down, since it scores lower',
    bars.longBar < bars.base, JSON.stringify(bars));
  check('while a phrase gets no acronym surcharge',
    bars.phraseBar <= bars.base, JSON.stringify(bars));

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
  await part("reading a page, which is now the default", async () => {
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
  });

  // ---------- what a reviewer gets without touching anything ----------
  //
  // The markup and the state each used to assert a default of their own, which
  // is two places to disagree about the same thing.
  await part("what a reviewer gets without touching anything", async () => {
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
  });

  // ---------- the thorough sweep ----------
  //
  // What replaced the amber doubt boxes. Nothing is flagged on suspicion any
  // more; instead the whole document can be searched for the shape of each
  // word, and whatever that turns up beyond what the reading found is added as
  // a mark and drawn amber.
  await part("the thorough sweep", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', readablePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    // Nothing is offered before there is a redaction to be thorough about.
    const early = await page.evaluate(() => {
      const B = window.Blinded;
      B.state.terms = ['Amphitheatre'];
      B.state.applied = false;
      B.state.searched = false;
      B.state.sweptTerms = [];
      B.renderSweep();
      return !document.querySelector('.exportbar .checklink');
    });
    check('the thorough check is not offered before anything has been searched',
      early === true, String(early));

    // Nor once the reviewer has changed the question. The button says Search
    // again then, and there is nothing for this to be a second opinion about.
    const backToSearch = await page.evaluate(() => {
      const B = window.Blinded;
      // A search standing and no check run against it yet: the one state in
      // which the panel has something to say. Once the check has run it says
      // nothing — what it did is reported in the foot — and once the question
      // changes there is nothing to be a second opinion about.
      B.state.searched = true;
      B.state.sweptTerms = [];
      B.renderSweep();
      const offered = Boolean(document.querySelector('.exportbar .checklink'));
      B.state.searched = false;
      B.renderSweep();
      const out = { offered,
                    afterChange: Boolean(document.querySelector('.exportbar .checklink')),
                    label: document.getElementById('apply').textContent.trim() };
      // Put back what this borrowed: a sweep left recorded here would make
      // the next block think one had already run.
      B.state.sweptTerms = [];
      B.renderSweep();
      return out;
    });
    check('it is offered while a search stands', backToSearch.offered === true,
      JSON.stringify(backToSearch));
    check('and withdrawn once the button says Search again',
      backToSearch.afterChange === false, JSON.stringify(backToSearch));

    const offered = await page.evaluate(() => {
      const B = window.Blinded;
      // Offered on the back of a search, not of a finished redaction: it is a
      // second opinion on what the first pass found.
      B.state.searched = true;
      B.renderSweep();
      const go = document.querySelector('.exportbar .checklink');
      return {
        hidden: document.getElementById('sweepbox').hidden,
        button: go ? go.closest('.ranline').textContent : '',
        link: go ? go.textContent.trim() : '',
        inFoot: Boolean(go),
        note: document.getElementById('sweepnote').textContent.trim(),
      };
    });
    check('and is offered as soon as a search has run',
      offered.inFoot === true, JSON.stringify(offered));
    check('without waiting for the redaction to be applied',
      (await page.evaluate(() => window.Blinded.state.applied)) === false);
    // The offer is the button in the foot, beside the bars it will raise and
    // the report it will leave. It used to be a button in the panel with a
    // note under it saying the same thing in amber, three sections away from
    // anything to do with running.
    check('the offer is a line in the foot, not a note in the panel',
      offered.inFoot === true && offered.note === '', JSON.stringify(offered));
    check('the line says what is being offered and why',
      /appear as images and a second check is recommended/i.test(offered.button),
      offered.button);
    // The question is the control: an outlined button among Search, Redact
    // and Export read as a fourth thing to press in a row that already says
    // what to press next.
    check('and ends in the question that starts the check',
      offered.link === 'Proceed?', JSON.stringify(offered));
    // Pressing it runs the check, rather than opening the dialog to ask the
    // same question a second time. The reviewer has read the line and pressed
    // the question in it; handing them the question back costs a press and
    // says nothing they have not just been told.
    const pressed = await page.evaluate(async () => {
      const B = window.Blinded;
      const was = B.runSweep;
      let started = false;
      B.runSweepCalled = () => {};
      // Not the real check, which takes minutes: what is being tested is
      // which of the two things the press does.
      const box = document.getElementById('sweepoffer');
      document.querySelector('.exportbar .checklink').click();
      await new Promise(r => setTimeout(r, 150));
      started = B.state.sweepRunning;
      B.state.sweepStopped = true;
      await new Promise(r => setTimeout(r, 400));
      return { started, dialog: !box.hidden };
    });
    check('and pressing it starts the check',
      pressed.started === true, JSON.stringify(pressed));
    check('without asking again in a dialog',
      pressed.dialog === false, JSON.stringify(pressed));
    await page.waitForFunction(() => !window.Blinded.state.sweepRunning,
      undefined, { timeout: 120000 });
    await page.evaluate(() => {
      const B = window.Blinded;
      // Put the offer back for the checks below: a stopped run leaves the
      // document un-swept, which is the state they were written against.
      B.state.sweepStopped = false;
      B.state.sweptTerms = [];
      B.state.sweepAdded = 0;
      B.state.footRan = null;
      B.renderSweep();
    });
    // The way out on the left and the thing being offered on the right, where
    // the eye finishes. They were stacked, so their order was set by number
    // rather than by markup, and the numbers stayed behind when the two went
    // side by side -- which put Proceed on the left, under the reader's eye
    // before they had read what they were proceeding with.
    const dialog = await page.evaluate(() => {
      const go = document.getElementById('sweepoffergo');
      const skip = document.getElementById('sweepofferskip');
      const box = go.getBoundingClientRect();
      const out = skip.getBoundingClientRect();
      document.getElementById('sweepoffer').hidden = false;
      const seen = go.getBoundingClientRect();
      const seenSkip = skip.getBoundingClientRect();
      const paint = getComputedStyle(go).backgroundColor;
      document.getElementById('sweepoffer').hidden = true;
      return { go: go.textContent.trim(), skip: skip.textContent.trim(),
               goLeft: seen.left, skipLeft: seenSkip.left, paint,
               hiddenBox: box.width + out.width };
    });
    check('the dialog offers two answers, named for what they do',
      dialog.go === 'Proceed' && dialog.skip === 'Skip', JSON.stringify(dialog));
    check('with the way out on the left and the offer on the right',
      dialog.skipLeft < dialog.goLeft, JSON.stringify(dialog));
    // Amber, because what the check finds is drawn amber: the button and its
    // marks are the same colour the whole way through.
    check('and the offer in the colour of what it will find',
      dialog.paint === 'rgb(217, 139, 31)', JSON.stringify(dialog));
    // Slow enough that springing it on someone would be a trap, so the wait
    // is stated before it starts -- and taken from the work in front of it,
    // not from "a couple of minutes" about any document at all.
    const cost = await page.evaluate(() => {
      window.Blinded.describeSweepOffer();
      return document.getElementById('sweepofferbody').textContent;
    });
    check('and the dialog it opens says how long it will take',
      /\(\d+ minutes?\)/i.test(cost), cost);

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
    // What accounts for it, not merely that something does: a reviewer looking
    // for a mark that is not there needs to know whether the same word was
    // already found here, a different one covers it, or they drew a box over
    // it themselves.
    check('a spot already marked is not proposed again',
      typeof dedupe.onTop === 'string' && dedupe.onTop.includes('KNW'),
      JSON.stringify(dedupe));
    check('but a spot nothing has touched is', dedupe.elsewhere === null,
      JSON.stringify(dedupe));

    // Amber has to reach the screen, or the distinction does not exist.
    // Checked as pixels for that reason.
    const drawn = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      const ctx = p.canvas.getContext('2d');
      const k = p.canvas.width / p.source.width;
      const at = () => [...ctx.getImageData(
        Math.round(100 * k), Math.round(75 * k), 1, 1).data].slice(0, 3);
      const rect = { x: 60, y: 60, w: 80, h: 30 };

      B.state.applied = false;
      // Planted marks, so the search that would normally have produced them
      // has to be declared: nothing found is drawn before one has run, and
      // nothing is drawn for a word nothing has looked for either. The word
      // these marks claim to be is typed and counted, exactly as a real
      // search would have left it.
      B.state.searched = true;
      if (!B.state.terms.includes('KNW')) B.state.terms.push('KNW');
      if (!B.state.countedTerms.includes('KNW')) B.state.countedTerms.push('KNW');
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
    // Amber against green: the ordinary mark leans green, the check's leans
    // red. Comparing the two against each other rather than against constants
    // means this fails if they are ever painted the same.
    check('and it is amber, not the green an ordinary mark gets',
      drawn.amber[0] > drawn.red[0] && drawn.red[1] > drawn.amber[1]
        && drawn.amber.join() !== drawn.red.join(),
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
        // Reported in the foot, with the bars that were filling a moment
        // ago, rather than a second time in the panel.
        note: document.getElementById('runfoot-text').textContent,
        buttonGone: !document.querySelector('.exportbar .checklink'),
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

    // Searching while the check is running.
    //
    // The two are passes over the same pages and cannot both own the document.
    // This used to put a dialog in the way offering to stop the check — a
    // question asked at the worst moment, about work the reviewer had not been
    // thinking about. The button is simply not pressable until the check ends.
    const raced = await page.evaluate(async () => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      B.state.terms = ['Parkway'];
      B.state.searched = true;
      p.imageHits = [];

      const sweeping = B.runSweep();
      await new Promise(r => setTimeout(r, 50));
      // Search is a button of its own now; this block is about Search.
      const button = document.getElementById('search');
      const during = {
        disabled: button.disabled,
        title: button.title,
        note: document.getElementById('exportnote').textContent,
        // Where the check now reports itself, and where its stop button is.
        foot: !document.getElementById('sweeprun').hidden,
        stop: Boolean(document.getElementById('sweepstop')
          && document.getElementById('sweepstop').closest('.exportbar')),
        // Pressing it anyway must do nothing at all.
        asked: !document.getElementById('confirmbox').hidden,
      };
      button.click();
      await new Promise(r => setTimeout(r, 50));
      const afterPress = { asked: !document.getElementById('confirmbox').hidden,
                           running: B.state.sweepRunning };

      await B.settleSweep();
      await sweeping;
      const after = { disabled: document.getElementById('search').disabled,
                      running: B.state.sweepRunning };
      p.imageHits = [];
      B.state.sweptTerms = [];
      B.state.terms = [];
      return { during, afterPress, after };
    });
    check('the search button is greyed out while the check runs',
      raced.during.disabled === true, JSON.stringify(raced));
    check('and says why', /second check is running/i.test(raced.during.title),
      raced.during.title);
    // It used to say so in the panel, beside a yellow box holding the bar and
    // the stop button. Both live at the foot of the page now, with the button
    // that would have started a search — so the sentence that pointed at the
    // panel would be pointing at nothing.
    check('the check reports itself at the foot of the page',
      raced.during.foot === true, JSON.stringify(raced.during));
    check('with its stop button there too',
      raced.during.stop === true, JSON.stringify(raced.during));
    check('and the line beside the buttons does not argue with it',
      raced.during.note === '', JSON.stringify(raced.during));
    check('no dialog is thrown in front of the reviewer',
      raced.during.asked === false && raced.afterPress.asked === false,
      JSON.stringify(raced));
    check('and pressing it does not stop the check',
      raced.afterPress.running === true, JSON.stringify(raced));
    check('once the check ends the button comes back',
      raced.after.disabled === false && raced.after.running === false,
      JSON.stringify(raced));

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

    // ---------- the reader gets to refuse the check's guesses ----------
    //
    // Measured on a fifteen-page report, looking for "jared": the search found
    // all fifteen occurrences, and the check then proposed fifty-four more —
    // every one wrong. "offered", "scared", "faced", "shared", "considered",
    // "separate", "hundred", "validated". A five-letter shape lives inside a
    // great many longer words, and correlation at 0.65 cannot tell them apart.
    // The reader had read every one of those words at confidence 91 to 96.
    {
      const veto = await page.evaluate(() => {
        const B = window.Blinded;
        const p = B.state.pages[0];
        const kept = { text: p.ocrText, placed: p.ocrPlaced };
        // Blank margin, chosen deliberately: the veto reads the text layer as
        // well as the reader now, and every other part of this page carries a
        // real text run that would answer for it. Here nothing is written, so
        // what is being tested is the reading and only the reading.
        const at = { x: 60, y: 1500, w: 60, h: 20 };
        const word = (str, confidence) => {
          p.ocrText = str;
          p.ocrPlaced = [{ rect: { ...at }, start: 0, end: str.length, confidence }];
          return B.readerContradicts(p, at, 'jared');
        };
        const out = {
          // What the report did, fifty-four times over.
          differentWord: word('offered', 96),
          // The same spot, read as the word being looked for: not a
          // contradiction, and the reading has already marked it anyway.
          theWordItself: word('Jared', 96),
          insideALongerWord: word("Jared's", 96),
          // A reading the reader is unsure of is exactly what the shape
          // matcher is for, so it does not get to veto.
          unsureReading: word('offered', 40),
          noConfidence: word('offered', undefined),
        };
        // Lettering inside a picture: the reader places no word there at all,
        // which is the case this whole feature exists for.
        p.ocrText = 'nothing near here';
        p.ocrPlaced = [{ rect: { x: 900, y: 900, w: 40, h: 12 },
                         start: 0, end: 7, confidence: 96 }];
        out.readerSawNothing = B.readerContradicts(p, at, 'jared');
        // And a page it never read.
        p.ocrText = '';
        p.ocrPlaced = [];
        out.pageNotRead = B.readerContradicts(p, at, 'jared');
        // The text layer answers too, and it is the half that was added: a
        // shape claiming one word where the file itself says another is the
        // KAS-inside-TEXAS case this was built for. No OCR at all here.
        out.textLayerSaysOtherwise =
          B.readerContradicts(p, { x: 100, y: 100, w: 60, h: 20 }, 'jared');
        out.textLayerSaysTheWord =
          B.readerContradicts(p, { x: 100, y: 100, w: 60, h: 20 }, 'confidential');
        p.ocrText = kept.text;
        p.ocrPlaced = kept.placed;
        return out;
      });
      check('a guess over a word the reader read as something else is refused',
        veto.differentWord === true, JSON.stringify(veto));
      check('but not one over the word actually being looked for',
        veto.theWordItself === false && veto.insideALongerWord === false,
        JSON.stringify(veto));
      check('and not on a reading the reader was unsure of',
        veto.unsureReading === false && veto.noConfidence === false,
        JSON.stringify(veto));
      // The two that would gut the feature if the veto were too eager.
      check('lettering the reader never saw is still proposed',
        veto.readerSawNothing === false, JSON.stringify(veto));
      check('and so is everything on a page it never read',
        veto.pageNotRead === false, JSON.stringify(veto));
      // The text layer is consulted as well, and says the same kind of thing:
      // a shape claiming a word where the file itself writes another is
      // refused, and one claiming the word the file writes is not.
      check('the file’s own text can refuse a shape that contradicts it',
        veto.textLayerSaysOtherwise === true, JSON.stringify(veto));
      check('and cannot refuse one that agrees with it',
        veto.textLayerSaysTheWord === false, JSON.stringify(veto));
    }

    check('the sweep finds a word that is really on the page',
      swept.added >= 1 && swept.marks === swept.added, JSON.stringify(swept));
    check('and every mark it adds is flagged as its own',
      swept.marks >= 1, JSON.stringify(swept));
    check('afterwards the foot says the check found something',
      /Second check complete\. Review marks outlined in amber/
        .test(swept.note), JSON.stringify(swept.note));

    // One report, two lines, one per run, each carrying the colour its marks
    // wear on the page.
    //
    // It used to end with how many places the check had stood down from
    // because the reader read them as something else. That is true, and it is
    // useful to whoever is working on the matcher, and to a reviewer it was a
    // number with nothing to do: it named no place and asked for nothing. It
    // is not reported any more, here or anywhere.
    const refused = await page.evaluate(() => {
      const B = window.Blinded;
      const was = B.state.sweepRefused;
      const swept = B.state.sweptTerms;
      const terms = B.state.terms;
      const ran = B.state.footRan;
      B.state.terms = ['Parkway'];
      B.state.sweptTerms = ['Parkway'];
      B.state.searched = true;
      B.state.sweepStopped = false;
      B.state.sweepAdded = 1;
      B.state.footRan = 'check';
      B.state.footAdded = 1;
      B.state.footStopped = false;
      B.state.sweepRefused = 2;
      B.state.sweepRefusedAt = [{ pageIndex: 1, at: 400 }, { pageIndex: 0, at: 120 }];
      B.refreshApply();
      const foot = document.getElementById('runfoot-text');
      const out = {
        lines: [...foot.querySelectorAll('.ranline')].map(row => row.textContent),
        dots: [...foot.querySelectorAll('.randot')].map(d => d.className),
        said: foot.textContent,
        panel: document.getElementById('sweepnote').textContent.trim(),
        panelShown: !document.getElementById('sweepbox').hidden,
      };
      B.state.sweepRefused = was;
      B.state.sweptTerms = swept;
      B.state.terms = terms;
      B.state.footRan = ran;
      B.refreshApply();
      return out;
    });
    check('both runs are reported, one line each',
      refused.lines.length === 2
      && /^Initial search \(text \+ images\) complete/.test(refused.lines[0])
      && /^Second check complete/.test(refused.lines[1]),
      JSON.stringify(refused));
    check('each line wearing the colour its marks wear on the page',
      /green/.test(refused.dots[0]) && /amber/.test(refused.dots[1]),
      JSON.stringify(refused));
    check('and no count of what the reader stood down from',
      !/skipped|stood down|left alone/.test(refused.said), refused.said);
    // The run's result is reported once. The panel is where the check is
    // offered, not where it is summed up afterwards.
    check('and the panel does not repeat it',
      refused.panel === '' && refused.panelShown === false,
      JSON.stringify(refused));
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
  });

  // ---------- every long pass reports the same way ----------
  //
  // Rendering the pages, reading them, searching them and flattening them for
  // export are four passes over the same document. Each used to announce
  // itself differently, and only one of them had a bar.
  await part("every long pass reports the same way", async () => {
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
  });

  // ---------- one bar for both passes ----------
  //
  // Reading the pages and searching them for a picked image are separate jobs,
  // but they are two passes over the same document, one after the other. Two
  // bars filling in sequence reads as the first one having lied, so the work
  // is counted once and both legs report into it.
  await part("one bar for both passes", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });

    const seen = await page.evaluate(async () => {
      const B = window.Blinded;
      const widths = [];
      const texts = [];
      // Watch the bar while a run goes on.
      // Sampled often, because the thing being watched is now quick: two pages
      // searched by two workers can finish between two slow samples, and a bar
      // that was never caught moving is not a bar that failed to move. The run
      // is timed so that case can be told apart from a bar that is stuck.
      const watch = setInterval(() => {
        const row = document.querySelector('[data-leg="search"], [data-leg="only"]');
        if (row) {
          widths.push(parseFloat(row.querySelector('[data-fill]').style.width) || 0);
          texts.push(row.querySelector('[data-count]').textContent);
        }
      }, 20);
      const began = Date.now();
      const wasOn = B.state.termImages;
      B.state.termImages = false;         // a picked image only, no reading
      await B.addTemplate(B.state.pages[0], { x: 40, y: 40, w: 120, h: 120 });
      await B.applyRedaction();
      clearInterval(watch);
      const out = { widths, texts: [...new Set(texts)].slice(0, 4),
                    took: Date.now() - began,
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
      new Set(seen.widths).size > 1 || new Set(seen.texts).size > 1 || seen.took < 300,
      JSON.stringify({ texts: seen.texts, took: seen.took,
        widths: [...new Set(seen.widths)] }));
    // "4 of 5" left the reviewer to work out what was being counted. Every
    // one of these legs counts pages, and the count names the page being
    // worked on rather than the number already behind it.
    check('and counts them the way every other leg does',
      seen.texts.every(t => /^Page \d+ of \d+$/.test(t)), JSON.stringify(seen.texts));
    check('the bar only ever moves forward',
      seen.widths.every((w, i) => i === 0 || w >= seen.widths[i - 1]),
      JSON.stringify(seen.widths));
  });

  // ---------- the Images hint belongs to the Images section ----------
  //
  // It sits under "Select an image to redact". A word search used to report
  // into it, so a reviewer who had picked no image at all was told "Found 2
  // times" underneath a button they had never pressed — a count of something
  // else entirely, in the one place it could only be read as being about an
  // image.
  await part("the Images hint belongs to the Images section", async () => {
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
  });

  // ---------- changing the terms after a run ----------
  //
  // Reading a page and matching terms against what was read are different jobs
  // with different costs, and only one depends on the settings. A term added
  // after a run — or during a pause — has to be matched against every page
  // already read, but those pages must not be read again: on a hundred-page
  // document that would turn a change of mind into another minute of waiting.
  await part("changing the terms after a run", async () => {
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
  });

  // ---------- pages that cannot hide anything ----------
  //
  // A page with no images and no filled paths has nowhere to put lettering the
  // text layer does not already report, so reading it can only find what is
  // already known. Worth saying what this is and is not worth: on a slide deck
  // it skips nothing, because every page has images, and the asking costs
  // about half a second. That is why the asking stops at the first page that
  // has to be read.
  await part("pages that cannot hide anything", async () => {
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
  });

  // ---------- progress, and stopping to look ----------
  //
  // A hundred pages is long enough that a reviewer will want to see what has
  // been found before it finishes, and having seen it may want to change the
  // terms rather than wait out a run looking for the wrong thing. Stopping is
  // between pages: what has been read is kept, and carrying on resumes rather
  // than starting again — re-reading would make pausing cost more than
  // waiting, which is no pause at all.
  await part("progress, and stopping to look", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])');
    // Eight pages, because stopping happens between them and the reader runs
    // several at once: on a two-page document both start together, there is
    // no "between" for the pause to land in, and whether it seemed to work
    // came down to how warm the reader's workers happened to be. That is a
    // test that passes by luck, and it did — until something else in the
    // suite warmed them up first.
    await page.setInputFiles('#file', pausePath);
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
    check('and how far through it is', reported.count === 'Page 30 of 100',
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
        rows: [...document.getElementById('busy-legs').querySelectorAll('[data-leg]')].map(r => r.dataset.leg),
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
      const rows = [...document.getElementById('busy-legs').querySelectorAll('[data-leg]')].map(r => ({
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
      both[0].count === 'Page 41 of 100' && both[1].count === 'Page 1 of 100',
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
      // Asked as soon as the progress bar says a page has come back, rather
      // than after a fixed delay: how long a page takes depends on whether
      // the reader's engines are already running, and a race the suite
      // happens to win is not a check on anything.
      //
      // Watched on the bar rather than on the pages, because a page only
      // receives its words once the whole reading pass resolves — which is
      // exactly the moment a pause is meant to come before.
      await new Promise(done => {
        const watch = setInterval(() => {
          const row = document.querySelector('[data-leg="read"] [data-count]');
          // "Page 3 of 100" names the page being worked on, so the first page
          // is back once it says page two.
          const said = row && /^Page (\d+) of/.exec(row.textContent.trim());
          if (!said || Number(said[1]) < 2) return;
          clearInterval(watch);
          B.requestPause();
          done();
        }, 10);
      });
      await run;
      return {
        applied: B.state.applied,
        ocrRead: B.state.ocrRead,
        read: B.state.pages.filter(p => p.ocrItems).length,
        total: B.state.pages.length,
        // Inside the page: nothing left running, and nothing covering it.
        overlay: document.getElementById('busy').hidden
          && !B.state.redacting && !B.state.sweepRunning,
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
  });

  // ---------- a second document is a second document ----------
  //
  // The reader is run once per document and the result kept, because a page's
  // words do not change when the terms list is edited. That flag was not being
  // cleared when a new document was opened, so the second document was never
  // read: the box was ticked, the work looked done, nothing ran, and the file
  // came back with the words still on it and no sign that anything was wrong.
  // It took a page refresh to clear, which is not something a reviewer would
  // think to do.
  await part("a second document is a second document", async () => {
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
  });

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
  // Six. The sensitivity bar and the placeholder switch, plus one on each of
  // the four section headings saying what that section is for. Those three
  // were standing paragraphs, which cost room every time the section was open
  // and said the same thing to someone reading it for the hundredth time.
  //
  // Two others went earlier: "find these words as pictures", which the tool
  // always does now, and "include lower-confidence matches", whose detectors
  // were tightened until they could stand without it.
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
    // Scrolled to, because a reviewer hovers a hint they can see. What is
    // asserted below is that the bubble lands on screen, and a button parked
    // below the fold is not the question being asked.
    b.scrollIntoView({ block: 'center' });
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

  // No hint sits inside a <label> any more, which is the only reason one could
  // ever toggle the checkbox it was explaining: a click that reached the label
  // would silently flip it. They live on the section headings instead, where
  // there is nothing to flip.
  const inLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.why')].filter(b => b.closest('label')).length);
  check('no hint is inside a control it would toggle', inLabels === 0,
    String(inLabels));
  // On a laptop the icon bar explains itself on hover. A phone has no hover,
  // so those six buttons were six unlabelled glyphs. Holding one answers.
  const holding = await page.evaluate(async () => {
    const button = document.getElementById('zoom-in');
    const before = window.Blinded.state.zoom;
    const at = type => button.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 31, pointerType: 'touch', isPrimary: true,
    }));
    at('pointerdown');
    await new Promise(r => setTimeout(r, 600));
    const bubble = document.querySelector('.tipbubble');
    const said = bubble && !bubble.hidden ? bubble.textContent : '';
    at('pointerup');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    return { said, before, after: window.Blinded.state.zoom };
  });
  // Whatever the button's title says at the moment it is held — the zoom one
  // carries the current level, and the hint should quote it rather than a
  // copy of the wording taken once at startup.
  check('holding a toolbar icon on a touch screen says what it does',
    holding.said.startsWith('Zoom in'), JSON.stringify(holding));
  check('and the press that asked does not also work the button',
    holding.after === holding.before, JSON.stringify(holding));
  await page.evaluate(() => {
    const bubble = document.querySelector('.tipbubble');
    if (bubble) bubble.hidden = true;
  });

  await page.evaluate(() => {
    const bubble = document.querySelector('.tipbubble');
    if (bubble) bubble.hidden = true;
  });

  // ---------- a phone shows one thing at a time ----------
  //
  // Side by side, the panel and the document each got about 300 pixels of an
  // 844-pixel phone: too little to read a page in and too little to work the
  // controls in. One is open now and the other is a strip down the side,
  // tapped or swiped to trade places. And the frame was built to 100vh, which
  // on a phone is taller than what you can see for as long as the browser's
  // own bar is showing — so the Search and Export buttons sat underneath it.
  await part("a phone shows one thing at a time", async () => {
    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(base);
    await phone.setInputFiles('#file', fixturePath);
    await phone.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await phone.waitForTimeout(400);

    const look = () => phone.evaluate(() => {
      const seen = sel => {
        const n = document.querySelector(sel);
        if (!n) return null;
        const b = n.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height),
                 bottom: Math.round(b.bottom), shown: b.width > 0 && b.height > 0 };
      };
      const head = document.querySelector('.panel-head');
      return {
        viewport: window.innerHeight,
        panel: seen('.panel'), stage: seen('.stage'),
        peekEdit: seen('#peek-edit'), peekDoc: seen('#peek-doc'),
        // Whichever of the two is the one showing: before a search that is
        // Search, and this fixture has not run one.
        bar: seen('.exportbar'),
        search: seen(document.getElementById('search').hidden ? '#apply' : '#search'),
        tools: seen('.tools'),
        toolCount: document.querySelectorAll('.panel-head .tools .tool').length,
        headOutside: head ? !head.closest('.panel') : null,
        pane: document.body.dataset.pane,
        pageScrolls: document.documentElement.scrollHeight
          > document.documentElement.clientHeight + 1,
      };
    });

    const start = await look();
    check('it opens on the controls', start.pane === 'edit', JSON.stringify(start));
    check('the document is a strip rather than gone',
      start.stage.shown === true && start.stage.w < 60, JSON.stringify(start.stage));
    check('and the controls have the rest of the width',
      start.panel.w > start.stage.w * 4, JSON.stringify(start));
    check('the strip names the half it opens',
      start.peekDoc.shown === true && start.peekEdit.shown === false,
      JSON.stringify(start));
    // The reported fault, and the part of it a headless browser can show.
    check('the export bar is fully on screen',
      start.bar.bottom <= start.viewport, JSON.stringify(start.bar));
    check('and so are its buttons',
      start.search.shown === true && start.search.bottom <= start.viewport,
      JSON.stringify(start.search));
    check('and the frame is measured against the visible viewport, not 100vh',
      await phone.evaluate(() => {
        const sheet = [...document.styleSheets].find(s => /app\.css/.test(s.href || ''));
        const rules = [...(sheet ? sheet.cssRules : [])].map(r => r.cssText).join(' ');
        return /100dvh/.test(rules) && /100vh/.test(rules);
      }));
    check('nothing has pushed the page itself into scrolling',
      start.pageScrolls === false, JSON.stringify(start));

    // The toolbar is above both halves, so it is there whichever is open —
    // it cannot live in the panel, because the panel is sometimes a strip.
    check('the toolbar is lifted out of the panel',
      start.headOutside === true, JSON.stringify(start));
    check('and all of its buttons are there',
      start.toolCount === 7 && start.tools.shown === true, JSON.stringify(start));

    // Tapping the strip trades places.
    await phone.click('#peek-doc');
    await phone.waitForTimeout(400);
    const opened = await look();
    check('tapping the strip opens the document',
      opened.pane === 'doc' && opened.stage.w > opened.panel.w * 4,
      JSON.stringify(opened));
    check('and the controls become the strip',
      opened.panel.shown === true && opened.panel.w < 60, JSON.stringify(opened));
    check('the toolbar is still there with the document open',
      opened.tools.shown === true && opened.toolCount === 7, JSON.stringify(opened));
    check('and the export bar is still fully on screen',
      opened.bar.bottom <= opened.viewport, JSON.stringify(opened));
    check('the pages are drawn again when the document comes forward',
      await phone.evaluate(() =>
        window.Blinded.state.pages.some(p => window.Blinded.isLive(p))));

    // Swiping does the same. Right to left opens the document, left to right
    // the controls.
    const swipe = (fromX, toX, y) => phone.evaluate(({ fromX, toX, y }) => {
      const review = document.getElementById('view-review');
      const send = (type, x) => review.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, pointerId: 77 }));
      send('pointerdown', fromX);
      send('pointermove', toX);
      send('pointerup', toX);
      return document.body.dataset.pane;
    }, { fromX, toX, y });

    check('swiping left to right comes back to the controls',
      await swipe(40, 300, 400) === 'edit');
    check('and right to left goes to the document',
      await swipe(300, 40, 400) === 'doc');
    // A swipe that wanders is a scroll, not a swipe.
    check('a mostly-vertical drag is left alone',
      await phone.evaluate(() => {
        const review = document.getElementById('view-review');
        const before = document.body.dataset.pane;
        const send = (type, x, y) => review.dispatchEvent(new PointerEvent(type, {
          clientX: x, clientY: y, bubbles: true, pointerId: 78 }));
        send('pointerdown', 200, 200);
        send('pointermove', 260, 600);
        send('pointerup', 260, 600);
        return document.body.dataset.pane === before;
      }));

    // Two fingers have to do the thing two fingers do — which is zoom the
    // document, not the app around it. Handing the gesture to the browser
    // swelled panel, toolbar and header together and left the page no more
    // readable, so the canvas keeps every touch and answers the pinch itself.
    check('the canvas keeps the two-finger gesture rather than handing it over',
      await phone.evaluate(() => getComputedStyle(
        document.querySelector('.page canvas')).touchAction) === 'none');
    check('and a pinch on it zooms the document',
      await phone.evaluate(() => {
        const B = window.Blinded;
        B.setZoom(1);
        const c = document.querySelector('.page canvas');
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + Math.min(150, r.height / 2);
        const send = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, {
          pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
          bubbles: true, cancelable: true,
        }));
        send('pointerdown', 91, cx - 20, cy);
        send('pointerdown', 92, cx + 20, cy);
        for (let d = 25; d <= 70; d += 5) {
          send('pointermove', 91, cx - d, cy);
          send('pointermove', 92, cx + d, cy);
        }
        const zoomed = B.state.zoom > 1;
        send('pointerup', 91, cx - 70, cy);
        send('pointerup', 92, cx + 70, cy);
        B.setZoom(1);
        return zoomed;
      }));

      // The way out of picking, and where it sits. On a laptop the Cancel in the
    // panel is right there and never covered, so a second cross floating over
    // the document was one more thing to explain; on a phone the panel is a
    // strip down the side while the box is drawn, so the cross is the only way
    // out — under the toolbar on the left, where the hand is.
    const exits = await phone.evaluate(async () => {
      const B = window.Blinded;
      B.setMode('pick');
      await new Promise(r => setTimeout(r, 150));
      const stop = document.getElementById('pickstop');
      const r = stop.getBoundingClientRect();
      const head = document.querySelector('.panel-head').getBoundingClientRect();
      const tip = document.getElementById('tip');
      const out = {
        shown: getComputedStyle(stop).display !== 'none' && r.width > 0,
        onTheLeft: r.left < window.innerWidth / 2,
        belowTheToolbar: r.top >= head.bottom,
        tip: tip.hidden ? null : tip.textContent.trim(),
      };
      B.setMode('box');
      out.goneAfter = getComputedStyle(stop).display === 'none' || stop.hidden;
      out.tipAfter = document.getElementById('tip').hidden;
      return out;
    });
    check('a phone gets a way out of picking', exits.shown === true,
      JSON.stringify(exits));
    check('on the left, under the toolbar',
      exits.onTheLeft === true && exits.belowTheToolbar === true,
      JSON.stringify(exits));
    check('and it goes away when picking ends', exits.goneAfter === true,
      JSON.stringify(exits));
    // The finger that would ordinarily drag the document is busy drawing, so
    // how to move the page is a real question on a phone.
    check('and a line says which finger does what',
      /one finger/i.test(exits.tip || '') && /two/i.test(exits.tip || ''),
      String(exits.tip));
    check('which is not left on screen afterwards', exits.tipAfter === true,
      JSON.stringify(exits));
    // Picking moved the document forward and leaving it moved the panel back;
    // the checks below expect to be looking at the document.
    await phone.evaluate(() => window.Blinded.setPane('doc'));
    await phone.waitForTimeout(200);

  // Following a page number from the tally has to bring the document over.
    await phone.click('#peek-edit');
    await phone.waitForTimeout(300);
    await phone.evaluate(() => window.Blinded.goToPage(0));
    await phone.waitForTimeout(300);
    check('following a page number brings the document forward',
      await phone.evaluate(() => document.body.dataset.pane) === 'doc');

    // ---------- dragging a page towards the bottom, on a phone ----------
    //
    // This worked on a laptop and did nothing here, and the reason is the
    // difference between the two. On a laptop the sheet is capped to the
    // panel, so the bottom of its box is on screen and the creep zone is
    // reachable. On a phone it is left uncapped — the panel is what scrolls —
    // so the box runs far below the fold, measured at 1990 in an 844-pixel
    // window. The code watched an edge no finger could reach.
    //
    // The two halves of the fix are checked directly rather than through a
    // drag. A drag was tried first and was worthless: with the fix deliberately
    // put back to the old bounding-box edge, the panel still moved a couple of
    // hundred pixels — something else in the gesture scrolls it — so the check
    // passed on broken code and guarded nothing. What follows cannot do that,
    // because each is the mechanism itself.
    {
      // A document with enough pages to overrun the screen. The two-page
      // fixture this page has been using cannot show the bug at all — the
      // sheet fits, so there is no edge past the fold and nothing to scroll.
      // Loaded without a catch around it: a load that quietly failed is how a
      // check ends up measuring a document it is not looking at.
      await phone.setInputFiles('#file', manyPath);
      await phone.waitForFunction(() => window.Blinded.state.pages.length > 10,
        null, { timeout: 60000 });
      await phone.evaluate(async () => {
        if (window.Blinded.onPhone()) window.Blinded.setPane('edit');
        document.getElementById('organisesect').open = true;
        await new Promise(r => setTimeout(r, 250));
      });
      const geometry = await phone.evaluate(() => {
        const B = window.Blinded;
        const host = document.getElementById('sheet');
        const panel = document.querySelector('.panel');
        const box = host.getBoundingClientRect();
        const edges = B.creepEdges(host);
        const was = panel.scrollTop;
        // The sheet cannot scroll here, so a push has to walk out to whatever
        // can. That walk is the other half of the fix.
        const pushed = B.pushScroll(host, 60);
        const panelMoved = panel.scrollTop - was;
        panel.scrollTop = was;
        return {
          box: Math.round(box.bottom),
          edge: Math.round(edges.bottom),
          viewport: window.innerHeight,
          sheetScrolls: host.scrollHeight > host.clientHeight + 2,
          pushed, panelMoved,
        };
      });
      check('on a phone the sheet runs past the bottom of the screen',
        geometry.box > geometry.viewport, JSON.stringify(geometry));
      check('so its creep edge is the visible one, not the box',
        geometry.edge <= geometry.viewport && geometry.edge < geometry.box,
        JSON.stringify(geometry));
      check('and the sheet itself has no scrolling to give',
        geometry.sheetScrolls === false, JSON.stringify(geometry));
      check('so a push walks out to the panel, which has',
        geometry.pushed === true && geometry.panelMoved > 0, JSON.stringify(geometry));
    }

    await phone.close();
  });

  // And none of it on a screen with room for both.
  {
    const wide = await context.newPage();
    await wide.setViewportSize({ width: 1280, height: 800 });
    await wide.goto(base);
    await wide.setInputFiles('#file', fixturePath);
    await wide.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await wide.waitForTimeout(300);
    const both = await wide.evaluate(() => {
      const head = document.querySelector('.panel-head');
      const box = sel => {
        const n = document.querySelector(sel);
        const b = n.getBoundingClientRect();
        return { w: Math.round(b.width), shown: b.width > 0 && b.height > 0 };
      };
      return {
        panel: box('.panel'), stage: box('.stage'),
        peekEdit: box('#peek-edit'), peekDoc: box('#peek-doc'),
        headInPanel: !!head.closest('.panel'),
        note: box('#exportnote').w,
      };
    });
    check('a wide screen shows both halves in full',
      both.panel.w > 200 && both.stage.w > 200, JSON.stringify(both));
    check('with no strip and nothing to tap',
      both.peekEdit.shown === false && both.peekDoc.shown === false,
      JSON.stringify(both));
    check('and the toolbar back inside the panel where it belongs',
      both.headInPanel === true, JSON.stringify(both));
    check('and the sentence beside the buttons', both.note > 0, JSON.stringify(both));
    await wide.close();
  }

  // ---------- what is held in memory ----------
  //
  // Every page used to keep two canvases at the full rendered resolution.
  // Measured on a sixty page document that was 888 MB of bitmap from a PDF of
  // nineteen kilobytes. Neither fix may touch `source`: that canvas is what a
  // redaction is measured against and what the export flattens.
  await part("what is held in memory", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', doublePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await page.waitForTimeout(200);

    const held = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      return {
        sourceWidth: p.source.width,
        canvasWidth: p.canvas.width,
        shownWidth: Math.round(p.canvas.getBoundingClientRect().width),
        dpr: window.devicePixelRatio || 1,
      };
    });
    check('the page is still rendered at full resolution',
      held.sourceWidth > 1000, JSON.stringify(held));
    check('but the copy on screen is no bigger than it is shown',
      held.canvasWidth <= held.sourceWidth
        && held.canvasWidth <= Math.ceil(held.shownWidth * held.dpr) + 2,
      JSON.stringify(held));

    // The thing that must not regress: a mark drawn by hand lands where the
    // pointer was, in the page's own pixels, not the view's.
    const placed = await page.evaluate(() => {
      const B = window.Blinded;
      B.setTool('mark');
      const p = B.state.pages[0];
      p.manual = [];
      const box = p.canvas.getBoundingClientRect();
      // A quarter of the way in, and a third of the way down.
      const send = (type, fx, fy) => p.canvas.dispatchEvent(new PointerEvent(type, {
        clientX: box.left + box.width * fx,
        clientY: box.top + box.height * fy,
        bubbles: true, pointerId: 91,
      }));
      send('pointerdown', 0.25, 0.33);
      send('pointermove', 0.55, 0.5);
      send('pointerup', 0.55, 0.5);
      const drawn = p.manual[0];
      const out = drawn
        ? { x: drawn.x / p.source.width, y: drawn.y / p.source.height,
            w: drawn.w / p.source.width }
        : null;
      p.manual = [];
      B.redrawAll();
      return out;
    });
    check('a hand-drawn box lands where the pointer was',
      placed !== null && Math.abs(placed.x - 0.25) < 0.02
        && Math.abs(placed.y - 0.33) < 0.02 && Math.abs(placed.w - 0.30) < 0.02,
      JSON.stringify(placed));

    // Pages far from the view give up their bitmap and get it back.
    const virtual = await page.evaluate(async () => {
      const B = window.Blinded;
      const live = () => B.state.pages.filter(p => B.isLive(p)).length;
      const before = live();
      // Pretend the document is long by releasing one directly, then asking
      // for a refresh: what matters is that it comes back drawn.
      const last = B.state.pages[B.state.pages.length - 1];
      B.releaseCanvas(last);
      const released = B.isLive(last);
      B.updateLivePages();
      await new Promise(r => setTimeout(r, 50));
      return { before, released, backAgain: B.isLive(last),
               width: last.canvas.width };
    });
    check('a page can give up its bitmap', virtual.released === false,
      JSON.stringify(virtual));
    check('and gets it back when it is wanted again',
      virtual.backAgain === true && virtual.width > 0, JSON.stringify(virtual));

    // Releasing must not move the document under the reviewer.
    const shape = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[B.state.pages.length - 1];
      const wrap = p.canvas.parentElement;
      const tall = wrap.getBoundingClientRect().height;
      B.releaseCanvas(p);
      const stillTall = wrap.getBoundingClientRect().height;
      B.updateLivePages();
      return { tall: Math.round(tall), stillTall: Math.round(stillTall) };
    });
    check('and giving it up does not collapse the page under the scroll',
      shape.tall === shape.stillTall && shape.tall > 0, JSON.stringify(shape));
  });

  // ---------- the promise, enforced ----------
  //
  // "Nothing is uploaded" is true of the code, but a promise kept by
  // inspection is only as good as the next change to it. The policy asks the
  // browser to hold it: nothing may be posted anywhere, no form may submit,
  // no plugin may load, and no <base> may point a relative URL elsewhere.
  const policy = await page.evaluate(() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return meta ? meta.getAttribute('content').replace(/\s+/g, ' ').trim() : null;
  });
  check('the page carries a content security policy', policy !== null);
  check('nothing may be sent anywhere but back to this origin',
    /connect-src 'self'/.test(policy || ''), policy);
  check('and no form may submit', /form-action 'none'/.test(policy || ''), policy);
  check('nor any plugin load', /object-src 'none'/.test(policy || ''), policy);
  check('nor a base tag redirect a relative url',
    /base-uri 'none'/.test(policy || ''), policy);
  // Inline script is refused outright, which is why the pdf.js bridge is a
  // file: an inline block would need its hash in the policy, and that is a
  // thing to forget on every edit.
  check('inline script is refused, so there is no hash to keep in step',
    !/script-src[^;]*unsafe-inline/.test(policy || ''), policy);
  check('and the page still worked, which every check above this one proves',
    await page.evaluate(() => typeof window.Blinded === 'object'
      && typeof window.pdfjsLib === 'object'));

  // ---------- the questions page ----------
  //
  // The claim on the front page is that nothing is uploaded. That claim is
  // only checkable if a reader can reach the source, so the link is part of
  // the argument rather than decoration. It used to sit in the footer; it now
  // lives on the questions page, reached from the header, and the test follows
  // the same route a reader would.
  const headerLink = await page.evaluate(() => {
    const a = document.getElementById('faq-open');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { tag: a.tagName, text: a.textContent.trim(),
             visible: r.width > 0 && r.height > 0,
             onTheRight: r.left > window.innerWidth / 2 };
  });
  // The mark itself, as the page actually paints it.
  {
    const mark = await page.evaluate(() => {
      const svg = document.querySelector('.mark .markmark');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      const s = getComputedStyle(svg);
      const name = document.querySelector('.mark');
      const at = name.getBoundingClientRect();
      return {
        wide: Math.round(r.width), tall: Math.round(r.height),
        fill: s.fill, shapes: svg.querySelectorAll('rect').length,
        // White on the header's black, by following the text rather than by
        // being told a colour of its own.
        ink: getComputedStyle(name).color,
        // Beside the name, not above or below it.
        beside: Math.abs((r.top + r.height / 2) - (at.top + at.height / 2)) < 4,
        before: r.left < at.left + 30,
      };
    });
    check('the header draws the mark', mark !== null, JSON.stringify(mark));
    check('as four shapes, not one rectangle',
      mark && mark.shapes === 4, JSON.stringify(mark));
    check('painted in the same ink as the name beside it',
      mark && mark.fill === mark.ink, JSON.stringify(mark));
    check('sitting on the name\'s own line, ahead of it',
      mark && mark.beside === true && mark.before === true, JSON.stringify(mark));
    check('and small enough to leave the header thin',
      mark && mark.tall <= 18 && mark.wide <= 30, JSON.stringify(mark));
  }

  check('the header carries a way to the questions', headerLink !== null,
    JSON.stringify(headerLink));
  check('and it is labelled Q&A', headerLink && headerLink.text === 'Q&A',
    headerLink && headerLink.text);
  check('and it is on the right of the strip, where it was asked for',
    headerLink && headerLink.visible && headerLink.onTheRight, JSON.stringify(headerLink));
  // Not a link. Following one unloads the page, which throws away the open
  // document and puts the browser's "leave site?" warning in front of a
  // reviewer who only wanted to read what the tool does.
  check('it is a button, not a link that would unload the document',
    headerLink && headerLink.tag === 'BUTTON', JSON.stringify(headerLink));

  await page.click('#faq-open');
  await page.waitForSelector('#view-faq:not([hidden])', { timeout: 15000 });
  // The questions are fetched from faq.html now -- one copy, at an address a
  // reader can link to and a crawler can index -- so the view is a heading
  // and an empty box until they arrive.
  await page.waitForFunction(
    () => document.querySelectorAll('#faq-here .faq').length > 0,
    undefined, { timeout: 15000 });
  // Off the button before measuring it: the click that opened this page left
  // the pointer sitting on it, and hover is not the colour being asserted.
  await page.mouse.move(5, 400);
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
      back: !!document.getElementById('faq-back-bottom'),
      header: document.getElementById('faq-open').textContent.trim(),
      title: (document.querySelector('.faqtitle') || {}).textContent,
      // Every policy directive the answer quotes at the reader, so the prose
      // can be held to what the browser is actually told.
      quoted: [...document.querySelectorAll('.faq .ph')]
        .map(el => el.textContent.trim())
        .filter(text => /^[a-z-]+ /.test(text)),
      // Both doors wear the header's coat.
      doors: [document.getElementById('faq-open'),
              document.querySelector('.faqbackbtn')].map(el => {
        if (!el) return null;
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color, weight: s.fontWeight };
      }),
    };
  });
  check('the page is titled Q&A, the same as the way in', faq.title === 'Q&A', faq.title);
  // The answer tells the reader to go and read the policy. If the prose named
  // a directive the page does not carry, that instruction would send them
  // looking for a promise nobody made.
  check('the upload answer quotes at least two directives to check',
    faq.quoted.length >= 2, JSON.stringify(faq.quoted));
  for (const directive of faq.quoted) {
    check('and the policy really says ' + directive,
      (policy || '').replace(/\s+/g, ' ').includes(directive), policy);
  }
  const [wayIn, wayBack] = faq.doors;
  check('both doors are black, white and bold, like the header',
    wayIn && wayBack
      && wayIn.bg === 'rgb(13, 17, 23)' && wayBack.bg === 'rgb(13, 17, 23)'
      && wayIn.color === 'rgb(255, 255, 255)' && wayBack.color === 'rgb(255, 255, 255)'
      && Number(wayIn.weight) >= 700 && Number(wayBack.weight) >= 700,
    JSON.stringify(faq.doors));
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
  check('and the header button offers the way back too',
    /back to the tool/i.test(faq.header), faq.header);

  // Closing them returns to whatever was open before, which here is whatever
  // the previous block left behind.
  await page.click('#faq-open');
  await page.waitForFunction(
    () => document.getElementById('view-faq').hidden, undefined, { timeout: 15000 });
  check('closing the answers puts the previous view back',
    (await page.isVisible('#view-drop')) || (await page.isVisible('#view-review')));

  // Reading the answers with a document open must not cost the document.
  {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Jane']);
    await redact(page);
    const before = await page.evaluate(() => ({
      pages: window.Blinded.state.pages.length,
      terms: window.Blinded.state.terms.slice(),
      applied: window.Blinded.state.applied,
      marks: window.Blinded.state.pages.reduce(
        (n, p) => n + window.Blinded.activeBoxes(p).length, 0),
    }));

    await page.click('#faq-open');
    await page.waitForSelector('#view-faq:not([hidden])', { timeout: 15000 });
    check('the review goes out of sight while the answers are open',
      (await page.isVisible('#view-review')) === false);

    await page.click('#faq-back-bottom');
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 15000 });
    const after = await page.evaluate(() => ({
      pages: window.Blinded.state.pages.length,
      terms: window.Blinded.state.terms.slice(),
      applied: window.Blinded.state.applied,
      marks: window.Blinded.state.pages.reduce(
        (n, p) => n + window.Blinded.activeBoxes(p).length, 0),
    }));
    check('and coming back finds the document where it was',
      after.pages === before.pages && after.terms.join() === before.terms.join(),
      JSON.stringify({ before, after }));
    check('with its marks and its state intact',
      after.marks === before.marks && after.applied === before.applied,
      JSON.stringify({ before, after }));
    await newFile();
  }

  // ---------- the bar names the text work too ----------
  //
  // Reported: adding a word and an image together showed only "Searching
  // images". On a document already read there is nothing to read, but every
  // page is still walked to match the word against it, and a bar that names
  // only half of what was asked for reads as the other half being ignored.
  await part("the bar names the text work too", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Jane']);
    await redact(page);

    // Now both at once, against pages that have already been read.
    await page.fill('#termbox', 'Doe');
    await page.press('#termbox', 'Enter');
    await page.evaluate(({ x, y, size }) => {
      const B = window.Blinded;
      B.addTemplate(B.state.pages[0],
        { x: x * 2 - 3, y: y * 2 - 3, w: size * 2 + 6, h: size * 2 + 6 });
    }, LOGO_PLACEMENTS[1] || LOGO_PLACEMENTS[0]);
    await page.waitForTimeout(200);

    const watched = page.evaluate(() => new Promise(resolve => {
      const seen = new Set();
      const look = () => {
        // Wherever the run is reporting itself: a search says so along the
        // foot of the page, and everything else in the dialog.
        for (const row of document.querySelectorAll('[data-leg]')) {
          const label = row.querySelector('.leg-label span');
          if (label) seen.add(label.textContent.trim());
        }
      };
      const poll = setInterval(look, 25);
      const done = setInterval(() => {
        if (!window.Blinded.state.searched) return;
        clearInterval(poll); clearInterval(done);
        resolve([...seen]);
      }, 25);
    }));
    await page.click('#search');
    await page.waitForFunction(() => window.Blinded.state.searched === true,
      undefined, { timeout: 240000 });
    const legs = await watched;
    check('the bar names the image work', legs.some(l => /image/i.test(l)),
      JSON.stringify(legs));
    check('and the text work alongside it',
      legs.some(l => /searching text|matching words/i.test(l)), JSON.stringify(legs));
    // Named by what it is looking for. "Reading pages" described the method,
    // which is the tool's business and not the reviewer's.
    check('and never by the old name for the method',
      !legs.some(l => /reading pages/i.test(l)), JSON.stringify(legs));
  });

  // ---------- what the offer says ----------
  //
  // The dialog used to say "a couple of minutes" whatever the document was,
  // and the panel's estimate came from a constant measured before the sweep
  // drew two typefaces instead of eight, before the shortlist grew and before
  // the numerator moved into a transform: it was out by a factor of thirty,
  // promising three seconds for a check that took ninety-two.
  await part("what the offer says", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Zzyzx']);

    const said = await page.evaluate(() => {
      const B = window.Blinded;
      B.state.searched = true;
      B.state.sweptTerms = [];
      const real = B.state.pages;
      const grow = n => Array.from({ length: n }, (_, i) => ({ ...real[0], index: i }));
      const at = n => {
        B.state.pages = grow(n);
        const cost = B.sweepEstimate();
        B.describeSweepOffer();
        return { pages: n, seconds: Math.round(cost.seconds),
          perPage: +cost.perPage.toFixed(1),
          words: document.getElementById('sweepofferbody').textContent };
      };
      const out = { small: at(1), big: at(90) };
      B.state.pages = real;
      return out;
    });

    check('the offer says why a second check is needed',
      /appear as images in the document with no underlying text/.test(said.big.words),
      said.big.words);
    check('and how long it will take, for this document',
      /This requires a second check \(.+\)\. Proceed\?/.test(said.big.words),
      said.big.words);
    // Not a constant: ninety pages is ninety times one page's work, and the
    // sentence has to move with it or it is decoration.
    check('an estimate that grows with the document',
      said.big.seconds > said.small.seconds * 50,
      JSON.stringify({ one: said.small.seconds, ninety: said.big.seconds }));
    check('and is quoted in minutes once it is minutes',
      /\d+ minutes?\)/.test(said.big.words), said.big.words);
  });

  // ---------- a running check stays on screen ----------
  //
  // Changing a setting puts the document back to un-searched, and that was
  // taking the progress bar of a still-running check off the screen with it.
  // The work carried on in the background with nothing to show for it, and no
  // way left to stop it.
  //
  // On screen now means the foot of the page, where the bars are. The amber
  // panel is where the check is offered and where it reports afterwards; while
  // it runs it has nothing to say, and it used to stay up empty.
  await part("a running check stays on screen", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    // Two words: one the reading finds confidently, and one it does not.
    //
    // The second check only visits pages where reading left a word unsettled,
    // so a document whose every word was read confidently gives it nothing to
    // do — and a progress bar for work that is not happening cannot be
    // tested. "Zzyzx" is on no page, so every page needs looking at by shape.
    await setTerms(page, ['Jane', 'Zzyzx']);
    // A picked image, because the setting changed below is now its own
    // slider rather than one that governed the whole section.
    await page.evaluate(() => window.Blinded.addTemplate(
      window.Blinded.state.pages[0], { x: 40, y: 40, w: 120, h: 120 }));
    await redact(page);

    const during = await page.evaluate(async () => {
      const B = window.Blinded;
      const sweeping = B.runSweep();
      const box = document.getElementById('sweepbox');
      const bar = document.getElementById('sweeprun');
      const started = { box: !box.hidden, bar: !bar.hidden,
                        running: B.state.sweepRunning };

      // Change a setting while it runs, exactly as a reviewer would.
      const other = document.querySelector('.templates .barpip:not(.now)');
      if (other) other.click();
      else B.moveBarTo(B.state.templates[0],
        Math.max(B.AUTO_FLOOR, B.sensFor(B.state.templates[0]) - 0.05));
      await new Promise(r => setTimeout(r, 80));
      const after = { box: !box.hidden, bar: !bar.hidden,
                      searched: B.state.searched, running: B.state.sweepRunning,
                      canStop: !document.getElementById('sweepstop').hidden };

      // The Search button is dead while the check runs, and pressing it
      // changes nothing: the check keeps going and keeps its bar.
      const button = document.getElementById('apply');
      const greyed = button.disabled;
      await B.runSearch();
      const declined = { running: B.state.sweepRunning, box: !box.hidden,
                         bar: !bar.hidden, greyed };

      await B.settleSweep();
      await sweeping;
      return { started, after, declined };
    });

    check('the check shows its progress when it starts',
      during.started.bar === true && during.started.box === false,
      JSON.stringify(during));
    check('changing a setting mid-check does not hide it',
      during.after.bar === true && during.after.box === false
        && during.after.running === true, JSON.stringify(during));
    check('even though the document went back to un-searched',
      during.after.searched === false, JSON.stringify(during));
    check('and it can still be stopped', during.after.canStop === true,
      JSON.stringify(during));
    check('the Search button is greyed out while it runs',
      during.declined.greyed === true, JSON.stringify(during));
    check('and pressing it leaves the check running and on screen',
      during.declined.running === true && during.declined.bar === true,
      JSON.stringify(during));
  });

  // ---------- what the second check found outlives a re-search ----------
  //
  // Its marks come off the page when a setting changes, like every other
  // found mark: they answered the search that has just been set aside. What
  // they must not do is go for good. Re-running a check that takes minutes to
  // say the same thing is not a reasonable price for moving a slider.
  await part("what the second check found outlives a re-search", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', fixturePath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Jane']);
    await page.evaluate(() => window.Blinded.addTemplate(
      window.Blinded.state.pages[0], { x: 40, y: 40, w: 120, h: 120 }));
    await redact(page);

    const planted = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      // What a finished second check leaves behind.
      p.imageHits.push({ id: 'sweep:kept', term: 'Jane',
        rect: { x: 300, y: 500, w: 90, h: 24 }, score: 1, bySweep: true });
      B.state.sweptTerms = ['Jane'];
      B.state.sweepAdded = 1;
      B.redrawAll();
      return {
        held: p.imageHits.filter(m => m.bySweep).length,
        drawn: B.activeBoxes(p).filter(b => b.sweep).length,
      };
    });
    check('a mark from the check is on the page to begin with',
      planted.held === 1 && planted.drawn === 1, JSON.stringify(planted));

    // Move a setting: anything that changes what to look for.
    await page.evaluate(() => {
      const B = window.Blinded;
      const other = document.querySelector('.templates .barpip:not(.now)');
      if (other) other.click();
      else B.moveBarTo(B.state.templates[0],
        Math.max(B.AUTO_FLOOR, B.sensFor(B.state.templates[0]) - 0.05));
    });
    await page.waitForTimeout(400);
    const afterChange = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      return {
        searched: B.state.searched,
        held: p.imageHits.filter(m => m.bySweep).length,
        drawn: B.activeBoxes(p).filter(b => b.sweep).length,
      };
    });
    // What a setting invalidates is that setting's own results. Moving an
    // image's bar sends the document back to un-searched and takes that
    // image's matches off the page — and leaves alone a mark the second check
    // found for a word, which cost minutes and has nothing to do with the
    // slider that moved. It used to take everything off, which is why the
    // check's work kept disappearing.
    check('changing a setting sends the document back to un-searched',
      afterChange.searched === false, JSON.stringify(afterChange));
    check('but leaves the check\u2019s own marks where they are',
      afterChange.held === 1 && afterChange.drawn === 1,
      JSON.stringify(afterChange));

    await redact(page);
    const afterSearch = await page.evaluate(() => {
      const B = window.Blinded;
      const p = B.state.pages[0];
      return {
        held: p.imageHits.filter(m => m.bySweep).length,
        drawn: B.activeBoxes(p).filter(b => b.sweep).length,
      };
    });
    check('and searching again puts it back on the page',
      afterSearch.held === 1 && afterSearch.drawn === 1, JSON.stringify(afterSearch));

    // Deleting the word it belongs to is the one thing that does remove it.
    await page.evaluate(() => window.Blinded.dropTerm('Jane'));
    await page.waitForTimeout(300);
    const afterDelete = await page.evaluate(() =>
      window.Blinded.state.pages[0].imageHits.filter(m => m.bySweep).length);
    check('deleting the word it belongs to does remove it',
      afterDelete === 0, String(afterDelete));
  });

  // ---------- the overlay covers the whole search ----------
  //
  // Reported twice as "the button is dead but it is clearly working". The
  // overlay used to be raised inside the reading pass, which lowers it on its
  // way out — so a run that read the pages and then searched them spent the
  // whole second half with nothing on screen at all.
  await part("the overlay covers the whole search", async () => {
    if (await page.isVisible('#view-review')) await newFile();
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.setInputFiles('#file', logoPath);
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    await setTerms(page, ['Jane']);
    await page.evaluate(({ x, y, size }) => {
      const B = window.Blinded;
      B.addTemplate(B.state.pages[0],
        { x: x * 2 - 3, y: y * 2 - 3, w: size * 2 + 6, h: size * 2 + 6 });
    }, LOGO_PLACEMENTS[0]);

    // Watched with an observer rather than sampled: a gap shorter than the
    // poll would not be a gap the reviewer misses, but it would be one the
    // test misses.
    const watched = page.evaluate(() => new Promise(resolve => {
      // The foot of the page, which is where a search reports itself. It used
      // to be the dialog over the whole page; what is being watched is the
      // same thing either way — that the reviewer can see it running, without
      // a gap, for as long as it runs.
      const busy = document.getElementById('runfoot');
      // Counted as stretches, not samples. The bar is legitimately hidden
      // before the click lands; what would be a dead button is it going down
      // and coming back up in between, so that is what is counted: one stretch
      // is right, two means a hole.
      let spells = 0;
      let seen = 0;
      let up = false;
      // And whether it was up while the *image search* was running, which is
      // the half that lost it. Counting stretches alone cannot tell "up for
      // the reading only" from "up throughout".
      let searchingSeen = 0;
      let searchingHidden = 0;
      let dialog = 0;
      const look = () => {
        const nowUp = !busy.hidden;
        if (nowUp && !up) spells++;
        if (nowUp) seen++;
        up = nowUp;
        const leg = document.querySelector('[data-leg="search"] [data-count]');
        const moving = leg && !/^0 of/.test(leg.textContent || '');
        if (moving) { if (nowUp) searchingSeen++; else searchingHidden++; }
        if (!document.getElementById('busy').hidden) dialog++;
      };
      const observer = new MutationObserver(look);
      observer.observe(document.body, { attributes: true, subtree: true });
      const poll = setInterval(look, 30);
      const done = setInterval(() => {
        if (!window.Blinded.state.searched) return;
        clearInterval(poll); clearInterval(done); observer.disconnect();
        resolve({ seen, spells, searchingSeen, searchingHidden, dialog });
      }, 30);
    }));
    await page.click('#search');
    await page.waitForFunction(() => window.Blinded.state.searched === true,
      undefined, { timeout: 240000 });
    const overlay = await watched;
    check('the foot of the page says a search is running',
      overlay.seen > 0, JSON.stringify(overlay));
    // Both passes ran, so a hole between them would show here.
    check('and does not blink out between reading and searching',
      overlay.spells === 1, JSON.stringify(overlay));
    check('it is still there while the image search is running',
      overlay.searchingSeen > 0 && overlay.searchingHidden === 0,
      JSON.stringify(overlay));
    // And the page was never covered, which is the point of moving it: a
    // search is not a reason to stop reading the document.
    check('while the dialog never went up over the document',
      overlay.dialog === 0, JSON.stringify(overlay));
  });

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
      // The drop box and the cards below it are one column. The box used to
      // run the full width of the wrapper while the cards were capped, so its
      // edges sat outside theirs at any window wide enough to show it.
      edges: (() => {
        const drop = document.getElementById('drop').getBoundingClientRect();
        const cards = [...document.querySelectorAll('.features li')]
          .map(n => n.getBoundingClientRect());
        return {
          left: Math.round(drop.left - Math.min(...cards.map(c => c.left))),
          right: Math.round(Math.max(...cards.map(c => c.right)) - drop.right),
        };
      })(),
    }));
    check('the drop box lines up with the cards below it, at ' + w + 'px',
      Math.abs(front.edges.left) <= 1 && Math.abs(front.edges.right) <= 1,
      JSON.stringify(front.edges));

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

  // ---------- how it compares ----------
  //
  // Four columns of claims about other people's products, so the table has to
  // stay honest as it is edited. Every peer column keeps a real answer in
  // every row: a blank cell in a comparison reads as "cannot do it", which
  // would be a claim nobody checked.
  await part("how it compares", async () => {
    const versus = await page.evaluate(() => {
      const table = document.querySelector('.versus-table');
      if (!table) return null;
      const head = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      const rows = [...table.querySelectorAll('tbody tr')].map(tr => ({
        label: (tr.querySelector('th') || {}).textContent || '',
        cells: [...tr.querySelectorAll('td')].map(td => td.textContent.trim().length),
        ours: [...tr.querySelectorAll('td')].filter(td => td.classList.contains('us')).length,
      }));
      const ink = getComputedStyle(document.body).getPropertyValue('color');
      const heads = [...table.querySelectorAll('thead th')]
        .slice(1).map(th => getComputedStyle(th).color);
      return {
        head, rows, heads,
        mark: Boolean(table.querySelector('thead .us .markmark')),
        // Ours is the one in full ink; the peers are a shade back, which is
        // the difference the eye reads before it reads a word.
        inkedHeads: heads.filter(c => c === ink).length,
        width: Math.round(document.querySelector('.versus').getBoundingClientRect().width),
        above: Math.round(document.querySelector('.gallery').getBoundingClientRect().width),
        // A comparison is read by sweeping across it, which only works while
        // each cell is a phrase rather than a paragraph.
        longest: Math.max(...[...table.querySelectorAll('tbody td')]
          .map(td => td.textContent.trim().length)),
        worst: [...table.querySelectorAll('tbody td')]
          .map(td => td.textContent.trim())
          .sort((a, b) => b.length - a.length)[0],
        // It has to be able to overflow inside its own box rather than taking
        // the whole page sideways with it.
        scrolls: getComputedStyle(document.querySelector('.versus-scroll')).overflowX,
        pageWide: document.documentElement.scrollWidth
          - document.documentElement.clientWidth,
      };
    });
    check('the front page compares Blinded with the tools people already have',
      versus !== null && versus.head.includes('Blinded'),
      JSON.stringify(versus && versus.head));
    check('the Blinded column carries the mark',
      versus && versus.mark === true, JSON.stringify(versus && versus.head));
    check('and is the only column in full ink',
      versus && versus.inkedHeads === 1, JSON.stringify(versus && versus.heads));
    check('against three named peers', versus && versus.head.length === 5,
      JSON.stringify(versus && versus.head));
    check('every row answers for every one of them',
      versus && versus.rows.length >= 6
        && versus.rows.every(r => r.cells.length === 4 && r.cells.every(n => n > 0)),
      JSON.stringify(versus && versus.rows.filter(r => r.cells.some(n => !n))));
    check('and exactly one column in each row is ours',
      versus && versus.rows.every(r => r.ours === 1),
      JSON.stringify(versus && versus.rows.map(r => r.ours)));
    check('the table scrolls inside its own box',
      versus && versus.scrolls === 'auto', JSON.stringify(versus && versus.scrolls));
    check('it sits in the same column as the rest of the front page',
      versus && Math.abs(versus.width - versus.above) <= 1,
      JSON.stringify({ versus: versus && versus.width, above: versus && versus.above }));
    check('and every cell is short enough to read at a glance',
      versus && versus.longest <= 60, JSON.stringify(versus && versus.worst));
    check('and does not push the page sideways',
      versus && versus.pageWide <= 0, JSON.stringify(versus && versus.pageWide));
  });

  // ---------- the front page, read alongside an open document ----------
  //
  // The same page, minus the one thing it must not offer: somewhere to drop a
  // file. An invitation to open a document, shown to someone who has one open,
  // is an invitation to throw their work away.
  await part("the front page, read alongside an open document", async () => {
    if (!(await page.isVisible('#view-review'))) {
      await page.setInputFiles('#file', fixturePath);
      await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    }
    const link = sel => page.evaluate(s2 => {
      const node = document.querySelector(s2);
      return node ? { hidden: node.hidden, says: node.textContent.trim() } : null;
    }, sel);

    const reviewing = {
      home: await link('#home-top'), reset: await link('#reset-top'),
      faq: await link('#faq-open'),
    };
    check('with a document open the header offers Home',
      reviewing.home.hidden === false && reviewing.home.says === 'Home',
      JSON.stringify(reviewing));
    check('beside Reset and the questions',
      reviewing.reset.hidden === false && reviewing.faq.says === 'Q&A',
      JSON.stringify(reviewing));

    await page.click('#home-top');
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    const home = {
      drop: await page.isVisible('#drop'),
      pages: await page.evaluate(() => window.Blinded.state.pages.length),
      home: await link('#home-top'), reset: await link('#reset-top'),
      faq: await link('#faq-open'),
      // The page itself is still there to read.
      versus: await page.isVisible('.versus'),
    };
    check('Home shows the front page without closing the document',
      home.pages > 0 && home.versus === true, JSON.stringify(home));
    check('and without a place to drop another one',
      home.drop === false, JSON.stringify(home));
    check('the only thing offered there is the way back',
      home.faq.says === 'Back to the tool' && home.faq.hidden === false,
      JSON.stringify(home));
    check('with no Reset and no Home beside it',
      home.reset.hidden === true && home.home.hidden === true,
      JSON.stringify(home));

    await page.click('#faq-open');
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 15000 });
    check('and it goes back to the document',
      (await page.isVisible('#view-review')) === true);

    // The questions page answers the same way.
    await page.click('#faq-open');
    await page.waitForSelector('#view-faq:not([hidden])', { timeout: 15000 });
    const asking = {
      home: await link('#home-top'), reset: await link('#reset-top'),
      faq: await link('#faq-open'),
    };
    check('the questions page offers only the way back too',
      asking.faq.says === 'Back to the tool' && asking.reset.hidden === true
        && asking.home.hidden === true, JSON.stringify(asking));
    await page.click('#faq-open');
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 15000 });

    // And with no document at all, the front page is the way in again.
    await page.click('#reset-top');
    await page.waitForSelector('#confirmbox:not([hidden])', { timeout: 15000 });
    await page.click('#confirmyes');
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    const fresh = { drop: await page.isVisible('#drop'), faq: await link('#faq-open') };
    check('with nothing open the drop zone is back',
      fresh.drop === true && fresh.faq.says === 'Q&A', JSON.stringify(fresh));
  });

  // ---------- Back means back to the tool ----------
  //
  // The views were switched without touching history, so the browser's Back
  // left the site — and the document lives in the tab and nowhere else, so
  // leaving the site is losing it. Every way out of the tool pushes an entry
  // now, and Back is one of the ways home.
  await part("Back means back to the tool", async () => {
    if (!(await page.isVisible('#view-review'))) {
      await page.setInputFiles('#file', fixturePath);
      await page.waitForSelector('#view-review:not([hidden])', { timeout: 30000 });
    }
    const opened = await page.evaluate(() => window.Blinded.state.pages.length);

    await page.click('#faq-open');
    await page.waitForSelector('#view-faq:not([hidden])', { timeout: 15000 });
    await page.goBack();
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 15000 });
    check('Back from the questions returns to the document',
      (await page.evaluate(() => window.Blinded.state.pages.length)) === opened);

    await page.click('#home-top');
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.goBack();
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 15000 });
    check('and Back from the front page does too',
      (await page.evaluate(() => window.Blinded.state.pages.length)) === opened);

    // The button and the browser have to be the same step, or one of them
    // leaves an entry behind and the next Back goes somewhere surprising.
    //
    // Checked by what history holds afterwards rather than by pressing Back
    // again. Back at that point is correct to leave the site — the app has
    // nothing left of its own to go back to — and an earlier version of this
    // test did press it, walked the browser off the page, and left every check
    // after it reading a blank document.
    const depth = await page.evaluate(() => history.state);
    await page.click('#faq-open');
    await page.waitForSelector('#view-faq:not([hidden])', { timeout: 15000 });
    const away = await page.evaluate(() => history.state);
    await page.click('#faq-open');
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 15000 });
    const home = await page.evaluate(() => history.state);
    check('going away puts an entry in history',
      away && away.away === 'faq', JSON.stringify({ depth, away, home }));
    check('and leaving by the button takes it out again',
      JSON.stringify(home) === JSON.stringify(depth),
      JSON.stringify({ depth, away, home }));
  });

  // ---------- the detectors, before and after the search ----------
  //
  // They read what OCR reads now, as well as the text layer — an email address
  // painted into a screenshot is an email address. OCR happens during the
  // search, so before it a number would be a count of half the document
  // offered as a count of all of it. A question mark says the honest thing.
  //
  // And they are off until asked for, so this block asks: every row listed,
  // every one of them a question, which is the state a reviewer who has just
  // ticked the lot is looking at.
  await part("the detectors, before and after the search", async () => {
    const readKinds = () => page.evaluate(() => {
      const section = document.getElementById('kindsect');
      const rows = [...document.querySelectorAll('#kinds .kind')];
      return {
        hidden: section.hidden,
        known: window.Blinded.kindsKnown(),
        note: Boolean(document.getElementById('kind-note')),
        hint: Boolean(section.querySelector('summary .why')),
        rows: rows.map(r => ({
          name: r.querySelector('.name').textContent,
          says: r.querySelector('.n').textContent,
          asking: r.querySelector('.n').classList.contains('unknown'),
        })),
      };
    });

    await noDetectors(page);

    // One switch for all of them, above the list. Five taps to ask for
    // everything is four too many.
    const all = await page.evaluate(async () => {
      const row = document.querySelector('#kinds .kindall');
      const box = row && row.querySelector('input');
      if (!box) return { missing: true };
      const first = document.querySelector('#kinds .kindall + .kind');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      const on = {
        ticked: [...document.querySelectorAll('#kinds .kind input')]
          .every(b => b.checked),
        enabled: window.Blinded.state.enabled.size,
        red: document.getElementById('search').classList.contains('hunt'),
        above: Boolean(first),
      };
      const again = document.querySelector('#kinds .kindall input');
      again.checked = false;
      again.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      const off = {
        ticked: [...document.querySelectorAll('#kinds .kind input')]
          .some(b => b.checked),
        red: document.getElementById('search').classList.contains('hunt'),
      };
      // Half on, half off: the switch says so rather than picking a side.
      const one = document.querySelector('#kinds .kind input');
      one.checked = true;
      one.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      const middle = document.querySelector('#kinds .kindall input');
      const partly = { mixed: middle.indeterminate, checked: middle.checked };
      one.checked = false;
      one.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      return { missing: false, on, off, partly };
    });
    check('the detectors have one switch for all of them, above the list',
      all.missing === false && all.on.above === true, JSON.stringify(all));
    check('which ticks every one of them, and asks the search for them',
      all.on.ticked === true && all.on.red === true, JSON.stringify(all));
    check('and clears them again', all.off.ticked === false
      && all.off.red === false, JSON.stringify(all));
    check('standing half-ticked while only some are on',
      all.partly.mixed === true && all.partly.checked === false,
      JSON.stringify(all));

    await noDetectors(page);
    const quiet = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('#kinds .kind')].map(r => ({
        ticked: r.querySelector('input').checked,
        circle: !r.querySelector('.n').hidden,
      })),
      hidden: document.getElementById('kindsect').hidden,
    }));
    check('a document opens with every detector off and none of them asking',
      quiet.rows.length > 0 && quiet.rows.every(r => !r.ticked && !r.circle)
      && quiet.hidden === false, JSON.stringify(quiet));

    await useDetectors(page);
    const before = await readKinds();
    // However many there are, rather than a number that has to be edited every
    // time one is added or taken away.
    const total = await page.evaluate(() => window.BlindedDetect.KINDS.length);
    check('before the search every detector shows a question, not a number',
      before.known === false && before.rows.length > 0
        && before.rows.every(r => r.says === '?' && r.asking),
      JSON.stringify(before));
    check('and all of them are listed, since none has been answered',
      before.rows.length === total && before.hidden === false,
      JSON.stringify(before));
    check('the count of detectors is gone from the heading',
      before.note === false, JSON.stringify(before));
    check('and what the section is for is a hint on it instead',
      before.hint === true, JSON.stringify(before));

    await page.click('#search');
    await page.waitForFunction(() => window.Blinded.state.searched === true,
      null, { timeout: 90000 });
    const after = await readKinds();
    check('after it, numbers rather than questions',
      after.known === true && after.rows.every(r => !r.asking && /^\d+$/.test(r.says)),
      JSON.stringify(after));
    // Every detector that was asked keeps its row, including one that found
    // nothing: "we looked, there are none" is an answer, and a row that
    // vanishes takes the switch with it.
    check('every detector asked for reports what it found',
      after.rows.length === total, JSON.stringify(after));

    // An unticked detector that turned something up is still offered, so the
    // reviewer can see what is there without having guessed in advance.
    const offered = await page.evaluate(async () => {
      const B = window.Blinded;
      const found = window.BlindedDetect.KINDS
        .map(row => row.kind)
        .find(kind => (B.countsByKind()[kind] || 0) > 0);
      B.state.enabled.delete(found);
      B.renderKinds();
      const row = [...document.querySelectorAll('#kinds .kind')]
        .find(r => r.querySelector('input').dataset.kind === found);
      const out = {
        found,
        listed: Boolean(row),
        ticked: row ? row.querySelector('input').checked : null,
        says: row ? row.querySelector('.n').textContent : null,
        asking: row ? row.querySelector('.n').classList.contains('unknown') : null,
      };
      B.state.enabled.add(found);
      B.renderKinds();
      return out;
    });
    check('a detector left unticked still shows what it would cover',
      offered.listed === true && offered.ticked === false
      && Number(offered.says) > 0 && offered.asking === false,
      JSON.stringify(offered));

    // The tally is the same control the words and the pictures carry: green,
    // and it opens where they are. A grey number that does nothing teaches the
    // reviewer that this one circle is decoration.
    const tally = await page.evaluate(async () => {
      const row = [...document.querySelectorAll('#kinds .kind')]
        .find(r => Number(r.querySelector('.n').textContent) > 0);
      if (!row) return { skip: true };
      const dot = row.querySelector('.n');
      const green = getComputedStyle(dot).backgroundColor;
      dot.click();
      await new Promise(r => setTimeout(r, 80));
      const list = document.querySelector('#kinds .tally');
      const spots = list ? [...list.querySelectorAll('.tallyspot')] : [];
      const out = {
        skip: false,
        tag: dot.tagName,
        green,
        opened: Boolean(list),
        pages: spots.map(b => b.textContent),
        // A click on the circle must not tick the detector it reports on:
        // the circle lives inside the label.
        stillOn: row.querySelector('input').checked,
      };
      dot.click();
      await new Promise(r => setTimeout(r, 80));
      out.closes = !document.querySelector('#kinds .tally');
      return out;
    });
    if (!tally.skip) {
      check('the detector tally is a button, not a label',
        tally.tag === 'BUTTON', JSON.stringify(tally));
      check('and it is the same green the other sections use',
        tally.green === 'rgb(227, 243, 234)', JSON.stringify(tally));
      check('clicking it opens where they are, by page',
        tally.opened === true && tally.pages.length > 0
          && tally.pages.every(t => /Page \d+/.test(t)), JSON.stringify(tally));
      check('and does not tick the detector it reports on',
        tally.stillOn === true, JSON.stringify(tally));
      check('clicking it again closes the list', tally.closes === true,
        JSON.stringify(tally));
    }

    // Switching a detector off is a question about what to cover, not about
    // what is there. Both places it looks are already in hand, so the answer
    // must not be thrown away and asked for again.
    const unticked = await page.evaluate(async () => {
      const row = [...document.querySelectorAll('#kinds .kind')]
        .find(r => Number(r.querySelector('.n').textContent) > 0);
      if (!row) return { skip: true };
      const name = row.querySelector('.name').textContent;
      const box = row.querySelector('input');
      box.click();
      await new Promise(r => setTimeout(r, 120));
      const rows = [...document.querySelectorAll('#kinds .kind')];
      const same = rows.find(r => r.querySelector('.name').textContent === name);
      const out = {
        skip: false, name,
        searched: window.Blinded.state.searched,
        stillListed: Boolean(same),
        stillCounted: same ? same.querySelector('.n').textContent : null,
        asking: rows.some(r => r.querySelector('.n').classList.contains('unknown')),
      };
      same.querySelector('input').click();
      await new Promise(r => setTimeout(r, 120));
      return out;
    });
    if (!unticked.skip) {
      check('unticking a detector leaves the search standing',
        unticked.searched === true, JSON.stringify(unticked));
      check('and leaves the detector on the list, still counted',
        unticked.stillListed === true && Number(unticked.stillCounted) > 0,
        JSON.stringify(unticked));
      check('with nothing put back to a question mark',
        unticked.asking === false, JSON.stringify(unticked));
    }

    // The section stays even when there is nothing to report.
    //
    // It used to go, on the reasoning that a row of zeroes is a fact about
    // the tool rather than about the document. That was right when every
    // detector was on: the list was a result. Now it is the switchboard —
    // the only place a detector can be asked for at all — and a panel that
    // takes the switches away because they have not found anything yet is a
    // panel that cannot be asked a second question.
    const bare = await page.evaluate(async () => {
      const B = window.Blinded;
      const was = B.state.pages.map(p => p.text);
      B.state.pages.forEach(p => { p.text = 'nothing of interest here at all'; });
      B.rescan({ settled: true });
      await new Promise(r => setTimeout(r, 60));
      const hidden = document.getElementById('kindsect').hidden;
      B.state.pages.forEach((p, i) => { p.text = was[i]; });
      B.rescan({ settled: true });
      await new Promise(r => setTimeout(r, 60));
      return { hidden, backAgain: document.getElementById('kindsect').hidden };
    });
    check('the Detectors section stays even with nothing found, since it holds the switches',
      bare.hidden === false, JSON.stringify(bare));
    check('and is still there when there is something again',
      bare.backAgain === false, JSON.stringify(bare));
  });

  // ---------- the foot of the page ----------
  await part("the foot of the page", async () => {
    await page.evaluate(() => window.Blinded.state.pages.length
      && document.getElementById('home-top').click());
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    const foot = await page.evaluate(() => {
      const row = document.querySelector('.foot');
      if (!row) return null;
      const link = row.querySelector('a.footlink');
      return {
        says: row.textContent.replace(/\s+/g, ' ').trim(),
        source: link ? link.getAttribute('href') : null,
        // The source link leaves the tab, so it must not hand the new page a
        // handle back to this one.
        safe: link ? (link.getAttribute('rel') || '').includes('noopener') : false,
      };
    });
    check('the page ends with its name, the questions and the source',
      foot && /Blinded · FAQ · Source code on GitHub/.test(foot.says),
      JSON.stringify(foot));
    check('and the source link points at the repository',
      foot && /github\.com\/.+\/blinded/.test(foot.source) && foot.safe === true,
      JSON.stringify(foot));

    await page.click('#foot-faq');
    await page.waitForSelector('#view-faq:not([hidden])', { timeout: 15000 });
    check('the FAQ link opens the questions',
      (await page.isVisible('#view-faq')) === true);

    // The reported bug, which is two pages deep: a document open, Home to the
    // front page, the FAQ from the foot of it — and then Back to the tool did
    // nothing visible, because it went back one entry to the front page,
    // where the button says Back to the tool again. Away is one place now, so
    // one press lands on the document.
    await page.click('#faq-open');
    // Waited for by what becomes visible, not by what becomes hidden: a
    // selector that matches a hidden element still waits for it to be seen,
    // which it never will be.
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 15000 });
    check('two pages away, one press of Back to the tool reaches the document',
      (await page.isVisible('#view-review')) === true);

    // And the browser's own Back agrees with the button: one entry to unwind,
    // not two.
    await page.evaluate(() => document.getElementById('home-top').click());
    await page.waitForSelector('#view-drop:not([hidden])', { timeout: 15000 });
    await page.click('#foot-faq');
    await page.waitForSelector('#view-faq:not([hidden])', { timeout: 15000 });
    await page.goBack();
    await page.waitForSelector('#view-review:not([hidden])', { timeout: 15000 });
    check('and so does the browser\u2019s own Back button',
      (await page.isVisible('#view-review')) === true);
  });

  check('nothing threw in the page', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log('\nBlinded UI test');
// Said on every run, not only the filtered ones: a suite that quietly stopped
// running sixty of its sections is the one failure a test suite must not have.
const partial = skippedParts
  ? '  ' + skippedParts + ' of ' + partNames.length + ' sections SKIPPED (ONLY='
    + process.env.ONLY + ') - this is not a full pass'
  : null;
if (failures.length) {
  console.error('  ' + failures.length + ' FAILED:');
  for (const f of failures) console.error('    - ' + f);
  if (partial) console.error(partial);
  console.error('\n  ' + passed + ' checks passed');
  process.exit(1);
}
if (partial) console.log(partial);
console.log('  ' + passed + ' checks passed');
