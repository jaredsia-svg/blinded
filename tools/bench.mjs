// Runs the real tool over a folder of real documents and reports what it found.
//
// The suites say the tool still works. This says whether it still works *well*:
// how many marks a search proposes, what they scored, how long it took. Those
// are the numbers every change to the matcher has to be judged against, and
// judging them by opening the app and looking is how a regression survives.
//
// A benchmark is a folder holding a document and, optionally, the draft saved
// against it — the words typed and the images picked. The draft is what makes
// a run reproducible: without it there is nothing to search for.
//
//   bench/
//     Kimberly-Clark/
//       deck.pdf
//       deck.blinded.json
//
// The documents are confidential and never enter the repository: bench/ is
// ignored by git, and this file reads whatever is put there. Point it
// somewhere else with BENCH=/path/to/folder.
//
// On a machine of your own, once, from the project folder:
//
//   npm install                        pdf.js and Playwright, for the tools
//   npx playwright install chromium    the browser the bench drives
//
// then unpack the bench folder into bench/ beside this project's files.
// Timings are the machine's own: run once with SAVE=1 on a new machine so
// later runs are compared with that machine, not with another one.
//
//   node tools/bench.mjs              every benchmark
//   node tools/bench.mjs kimberly     the ones whose name matches
//   REVIEW=1 node tools/bench.mjs     also draw every page with its marks
//   SAVE=1 node tools/bench.mjs       keep this run as the baseline
//
// Whether it works *well* needs an answer key: truth.json beside the
// document, listing every place something should be covered -- what it is,
// which page, and where, in the page's own pixels. With one, a run says
// what it found, what it missed and what it covered that it should not
// have, and holds all three against the baseline: a place found before and
// missed now, or a false alarm that was not there before, fails the run.
//
//   { "items": [ { "page": 0, "what": "Kimberly-Clark",
//                  "rect": { "x": 120, "y": 80, "w": 300, "h": 40 } } ] }
//
// A place counts as covered when marks cover at least half of it, or its
// centre -- the key is drawn by hand and need not be exact to the pixel. A
// mark counts as a false alarm when nine-tenths of it lies outside every
// place in the key.
//
// What it prints, per picked image: how many matches came back at the bar the
// draft was saved with, the best score, and the whole verified distribution
// sorted — which is where a flood of look-alikes shows itself as a dense
// plateau under a handful of real ones. A copy of that distribution is written
// beside the run as JSON so a rule for choosing the bar can be tried against
// it without searching the document again.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, statSync, readdirSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Through fileURLToPath rather than .pathname. On Windows a file URL's
// pathname is "/C:/Users/..." -- with a leading slash -- and resolve() reads
// that as a path rooted at the current drive, so it hands back "C:\\C:\\Users".
// fileURLToPath is the conversion that knows about drive letters.
const root = fileURLToPath(new URL('..', import.meta.url));
const bench = process.env.BENCH || join(root, 'bench');
const only = process.argv[2];
const REVIEW = Boolean(process.env.REVIEW);
const SAVE = Boolean(process.env.SAVE);
const baselinePath = join(bench, 'baseline.json');
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
const results = {};
let regressions = 0;

// ---------- scoring against the answer key ----------

const area = r => Math.max(0, r.w) * Math.max(0, r.h);
function overlap(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}
// Half of a place under marks, or its centre under one, is covered. Overlaps
// are summed across marks, which slightly overcounts where two marks overlap
// each other -- harmless at a threshold of half.
function covered(place, rects) {
  const cx = place.x + place.w / 2;
  const cy = place.y + place.h / 2;
  if (rects.some(r => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)) return true;
  const under = rects.reduce((sum, r) => sum + overlap(place, r), 0);
  return under >= area(place) * 0.5;
}
function score(truth, marksByPage) {
  const items = truth.items || [];
  const found = [];
  const missed = [];
  items.forEach((item, i) => {
    const page = marksByPage.find(p => p.page === item.page);
    const rects = page ? page.marks.flatMap(m => m.rects) : [];
    (covered(item.rect, rects) ? found : missed).push(i);
  });
  const alarms = [];
  for (const page of marksByPage) {
    const places = items.filter(item => item.page === page.page).map(item => item.rect);
    for (const mark of page.marks) {
      for (const r of mark.rects) {
        const inside = places.reduce((sum, place) => sum + overlap(place, r), 0);
        if (inside < area(r) * 0.1) {
          alarms.push({ page: page.page, what: mark.what, how: mark.how,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } });
        }
      }
    }
  }
  return { total: items.length, found, missed, alarms };
}

if (!existsSync(bench)) {
  console.log('No benchmarks at ' + bench + '.');
  console.log('Put a document and its draft in a folder there, or set BENCH.');
  process.exit(0);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
};
const server = createServer((req, res) => {
  const want = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const path = join(root, want === '/' ? '/index.html' : want);
  if (!path.startsWith(root)) { res.writeHead(403).end('no'); return; }
  try { statSync(path); } catch { res.writeHead(404).end('no'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
  createReadStream(path).pipe(res);
});
const port = await new Promise(done => server.listen(0, () => done(server.address().port)));
// The browser the cloud sandbox provides, where there is one; anywhere else,
// the one Playwright installs (npx playwright install chromium).
const browser = await chromium.launch(existsSync('/opt/pw-browsers/chromium')
  ? { executablePath: '/opt/pw-browsers/chromium' } : {});

let ran = 0;
for (const name of readdirSync(bench).sort()) {
  const folder = join(bench, name);
  let files;
  try { files = readdirSync(folder); } catch { continue; }
  if (only && !name.toLowerCase().includes(only.toLowerCase())) continue;

  const draft = files.find(f => f.endsWith('.json'));
  // Whatever the draft was saved against, not the redacted output beside it.
  const doc = files.find(f => /\.(pdf|jpe?g|png)$/i.test(f) && !/redact/i.test(f));
  if (!doc) { console.log('--', name, '(no document)'); continue; }
  ran++;

  const page = await browser.newPage();
  page.on('pageerror', e => console.log('   !!', String(e).slice(0, 160)));
  await page.goto('http://localhost:' + port + '/index.html');
  await page.waitForSelector('#view-drop:not([hidden])', { timeout: 20000 });
  if (draft) {
    await page.setInputFiles('#file', join(folder, draft));
    await page.waitForTimeout(400);
  }
  await page.setInputFiles('#file', join(folder, doc));
  await page.waitForSelector('#view-review:not([hidden])', { timeout: 180000 });
  await page.waitForTimeout(1200);
  // A document over the free page limit is opened with the price notice,
  // and its draft is put back only once that is closed. Searching before
  // then searched for nothing: the words and picked images were not back
  // yet. Only that notice is answered -- "this is a different file" is a
  // question about the benchmark, and is left for a person to see.
  if (draft) {
    for (let i = 0; i < 60; i++) {
      const back = await page.evaluate(() => {
        const box = document.getElementById('confirmbox');
        if (box && !box.hidden && /license required/i.test(
          document.getElementById('confirmhead').textContent)) {
          document.getElementById('confirmyes').click();
        }
        const B = window.Blinded;
        return B.state.terms.length > 0 || B.state.templates.length > 0;
      });
      if (back) break;
      await page.waitForTimeout(250);
    }
  }

  // Each leg of the search timed on its own, not just the whole press.
  //
  // "The search took twenty seconds" says nothing about which part of it did:
  // reading a scanned page and matching a picked logo across it are different
  // work at different prices, and the question of what a document will cost
  // before it is opened can only be answered per leg. Watched on the bars the
  // run draws for itself, which is the same thing the reviewer watches.
  await page.evaluate(() => {
    window.__legTimes = { start: Date.now(), legs: {} };
    const look = () => {
      for (const row of document.querySelectorAll('[data-leg]')) {
        const key = row.dataset.leg;
        const count = row.querySelector('[data-count]');
        const said = count && /^Page (\d+) of (\d+)$/.exec(count.textContent.trim());
        if (!said) continue;
        const at = window.__legTimes.legs[key]
          || (window.__legTimes.legs[key] = { total: Number(said[2]) });
        if (at.first === undefined) at.first = Date.now();
        // How long the bar was up. Waiting for it to read 100% does not work:
        // the row is taken down the moment the run ends, so the full bar is
        // often never on screen to be sampled. The last time the row was seen
        // is the same answer to within one sample.
        at.done = Date.now();
        at.reached = Number(said[1]);
      }
    };
    window.__legWatch = setInterval(look, 40);
  });

  const started = Date.now();
  // A restored draft comes back already searched, and its picked images come
  // back already answered, so the search is asked for directly rather than
  // through the button — which at that point means "redact".
  await page.evaluate(() => {
    const offer = document.getElementById('sweepoffer');
    if (offer && !offer.hidden) document.getElementById('sweepofferskip').click();
    const B = window.Blinded;
    B.state.searched = false;
    for (const logo of B.state.templates) { logo.searched = false; logo.matches = 0; }
    // The draft restored the marks its own run had found, at whatever bar it
    // was saved with. Left in place they mix with this run's and the report
    // describes two searches at once.
    //
    // The boxes drawn by hand go too. They are part of the draft's intent, but
    // a benchmark is asking what the tool finds on its own: a word sitting
    // under a box the reviewer had already drawn is skipped as "covered
    // already" and counted as a miss, which is the opposite of the truth.
    for (const p of B.state.pages) {
      p.imageHits = [];
      p.manual = [];
      p.dismissed = new Set();
    }
    return B.runSearch();
  });
  await page.waitForFunction(() => document.getElementById('busy').hidden,
    undefined, { timeout: 900000 });
  const searchTook = (Date.now() - started) / 1000;

  // Then the second check, which is the half that matters on a scanned
  // page: the plain search reads the text layer, and a photographed slide has
  // none. Reported separately because they cost very different amounts.
  const legTimes = await page.evaluate(() => {
    clearInterval(window.__legWatch);
    const out = window.__legTimes;
    window.__legTimes = { start: Date.now(), legs: {} };
    window.__legWatch = setInterval(() => {
      for (const row of document.querySelectorAll('[data-leg]')) {
        const key = row.dataset.leg;
        const at = window.__legTimes.legs[key]
          || (window.__legTimes.legs[key] = {});
        if (at.first === undefined) at.first = Date.now();
        at.done = Date.now();
      }
    }, 40);
    return out;
  });

  const swept = Date.now();
  const sweepAdded = await page.evaluate(() => window.Blinded.runSweep());
  await page.waitForFunction(() => document.getElementById('busy').hidden,
    undefined, { timeout: 1800000 });
  const sweepTook = (Date.now() - swept) / 1000;
  const checkLegs = await page.evaluate(() => {
    clearInterval(window.__legWatch);
    return window.__legTimes;
  });

  const out = await page.evaluate(() => {
    const B = window.Blinded;
    return {
      pages: B.state.pages.length,
      // What the check found and then threw away. A word that cleared its bar
      // and is still not on the page was refused by one of the vetoes, and
      // that is a different failure from one that never scored well enough.
      refused: (B.state.sweepRefusedAt || []).map(r => ({
        term: r.term, page: r.pageIndex, at: Math.round(r.at), why: r.why || 'reader' })),
      // The near misses the panel is putting to the reviewer, read off the
      // panel itself rather than recomputed here: what they are actually
      // shown is the thing worth reporting.
      // Which words the later passes were spent on, and what the panel
      // thinks the whole check will cost before it starts.
      deepened: (B.state.sweepDeepened || []).slice(),
      seeded: (B.state.sweepSeeded || []).slice(),
      seedReport: (B.state.sweepSeedReport || []).slice(),
      offers: [...document.querySelectorAll('.termcounts .offer')].map(card => ({
        term: card.dataset.term,
        why: (card.querySelector('.offerwhy') || card.querySelector('.offerlead'))
          .textContent,
        shown: Boolean(card.querySelector('canvas.offershot')),
      })),
      // How coarse the pages are, which decides whether they get a second
      // look at twice the size.
      size: [...new Set(B.state.pages.map(p => p.source.width + 'x' + p.source.height))],
      dpi: [...new Set(B.state.pages.map(p => {
        const at = window.BlindedImageSearch.dpiOf(p);
        return at ? Math.round(at) : 0;
      }))],
      terms: B.state.terms.map(term => ({ term,
        // What the reading found, and what the check found by sight, kept
        // apart: a word found in the text layer says nothing about whether
        // the check can see it on a scan.
        read: B.state.pages.reduce((n, p) =>
          n + p.hits.filter(hit => hit.term === term).length, 0),
        // Every mark this word has, not only the second check's. A word
        // can be found as a picture by the search itself — that is what the
        // typed-word image pass is for — and counting only the check's marks
        // reported four copies of a found word as found nowhere, because the
        // check had correctly deduped its own candidates against them.
        // What the reviewer actually sees: marks that are not superseded by
        // something covering them and not dismissed. Counting every mark in
        // the array reported words as found that show nothing in the tally and
        // nothing on the page.
        seen: B.state.pages.reduce((n, p) => n + B.liveImageHits(p)
          .filter(hit => hit.term === term && !p.dismissed.has(hit.id)).length, 0),
        // And every mark the search made, superseded or not, which is what
        // tells "found and hidden" apart from "never found".
        made: B.state.pages.reduce((n, p) =>
          n + (p.imageHits || []).filter(hit => hit.term === term).length, 0),
        bySweep: B.state.pages.reduce((n, p) =>
          n + (p.imageHits || []).filter(hit => hit.bySweep && hit.term === term).length, 0),
        // The best the check managed for this word, and the bar it had to
        // clear: a word missed at 0.62 against 0.70 is a different problem
        // from one missed at 0.21.
        best: (B.state.sweepBest || {})[term] || null,
        // Where the check put them, so they can be cropped and looked at.
        where: B.state.pages.flatMap(p => (p.imageHits || [])
          .filter(hit => hit.term === term && hit.rect)
          .map(hit => ({ p: p.index, x: Math.round(hit.rect.x), y: Math.round(hit.rect.y),
            w: Math.round(hit.rect.w), h: Math.round(hit.rect.h),
            s: +(hit.score || 0).toFixed(3) }))) })),
      templates: B.state.templates.map(logo => {
        const report = logo.report || {};
        const all = (report.scores || []).concat(report.near || [])
          .sort((a, b) => b - a).map(score => +score.toFixed(4));
        // Where they landed, so a score that looks wrong can be cropped out
        // of the page and looked at rather than argued about.
        const where = [];
        for (const p of B.state.pages) {
          for (const hit of p.imageHits || []) {
            if (hit.templateId !== logo.id || !hit.rect) continue;
            where.push({ p: p.index, x: Math.round(hit.rect.x), y: Math.round(hit.rect.y),
              w: Math.round(hit.rect.w), h: Math.round(hit.rect.h),
              s: +(hit.score || 0).toFixed(3) });
          }
        }
        return { id: logo.id, page: logo.pageIndex, bar: logo.sens,
          size: logo.cut ? logo.cut.width + 'x' + logo.cut.height : '?',
          matches: logo.matches, best: report.best || 0, all, where };
      }),
    };
  });

  console.log('==', name, '·', out.pages, 'pages · ' + out.size.join('/') + ' · ' + out.dpi.join('/') + ' dpi · search ' + searchTook.toFixed(1)
    + 's · check ' + sweepTook.toFixed(1) + 's (+' + sweepAdded + ')');
  // Per page, per leg, so the numbers can be carried to another document.
  {
    const mp = out.size.map(one => {
      const [w, h] = one.split('x').map(Number);
      return (w * h) / 1e6;
    });
    const biggest = Math.max(...mp);
    const say = (name, at, per) => {
      if (!at || at.first === undefined || at.done === undefined) return;
      const took = (at.done - at.first) / 1000;
      console.log('   ' + (name + ' ').padEnd(24) + took.toFixed(1) + 's total, '
        + (took / out.pages).toFixed(2) + 's a page'
        + (per ? ', ' + (took / out.pages / per).toFixed(2) + 's a page a ' + (per === 1 ? 'thing' : 'thing') : '')
        + ' · ' + biggest.toFixed(1) + 'MP pages');
    };
    say('reading the pages', legTimes.legs.read);
    say('matching picked images', legTimes.legs.search);
    const check = checkLegs.legs.sweep;
    if (check && check.first !== undefined && check.done !== undefined) {
      const took = (check.done - check.first) / 1000;
      const words = out.terms.length || 1;
      console.log('   ' + 'the check (first pass) '.padEnd(24) + took.toFixed(1)
        + 's total, ' + (took / out.pages).toFixed(2) + 's a page, '
        + (took / out.pages / words).toFixed(2) + 's a page a word'
        + ' · ' + biggest.toFixed(1) + 'MP pages');
    }
  }
  if (out.refused.length) {
    const byTerm = new Map();
    for (const one of out.refused) {
      const key = one.term + ' (' + one.why + ')';
      byTerm.set(key, (byTerm.get(key) || 0) + 1);
    }
    console.log('   refused ' + [...byTerm].map(([t, n]) => JSON.stringify(t) + ' x' + n)
      .join(', '));
  }
  if ((out.deepened || []).length || (out.seeded || []).length) {
    console.log('   looked again for ' + JSON.stringify(out.deepened || [])
      + ', seeded from the reader for ' + JSON.stringify(out.seeded || []));
  }
  for (const one of out.seedReport || []) {
    console.log('      seeded "' + one.part + '" at ' + one.seeds + ' places · best '
      + one.best.toFixed(3) + ' of ' + one.bar.toFixed(2) + ' · kept ' + one.kept);
  }
  for (const offer of out.offers || []) {
    console.log('   offering "' + offer.term + '" - ' + offer.why
      + (offer.shown ? '' : ' (no picture)'));
  }
  for (const term of out.terms) {
    // The verified best is the one the bar is a bar on. When nothing was
    // verified at all, only refinement's guess exists, and it is a different
    // and higher scale — saying so keeps it from being read as a near miss.
    const best = term.best
      ? (term.best.verified
        ? ' · best ' + term.best.score.toFixed(3) + ' of ' + term.best.bar.toFixed(2)
          + ' (' + term.best.part + ')'
        : ' · nothing verified, refine topped out at ' + term.best.refined.toFixed(3)
          + ' (' + term.best.part + ')')
      : '';
    console.log('   word ' + JSON.stringify(term.term)
      + ' -> read ' + term.read + ', seen ' + term.seen
      + ' of ' + term.made + ' made (' + term.bySweep + ' by the check)' + best);
  }
  for (const logo of out.templates) {
    console.log('   image ' + logo.id + ' p' + (logo.page + 1) + ' ' + logo.size
      + ' · bar ' + logo.bar + ' · ' + logo.matches + ' matches · best '
      + logo.best.toFixed(3));
    console.log('      ' + JSON.stringify(logo.all.slice(0, 16)));
  }
  writeFileSync(join(folder, 'scores.json'), JSON.stringify(out, null, 1));

  // Every mark the run left standing, said by what it is for, in the page's
  // own pixels. This is what the answer key is held against.
  const marks = await page.evaluate(() => {
    const B = window.Blinded;
    const number = id => B.state.templates.findIndex(t => t.id === id) + 1;
    return B.state.pages.map(p => {
      const list = [];
      for (const hit of p.hits) {
        if (p.dismissed.has(hit.finding.id)) continue;
        list.push({ what: hit.finding.term || hit.finding.kind, how: 'text',
          rects: hit.rects.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h })) });
      }
      for (const m of B.liveImageHits(p)) {
        if (p.dismissed.has(m.id) || !m.rect) continue;
        list.push({ what: m.term || ('image ' + number(m.templateId)),
          how: m.bySweep ? 'check' : (m.term ? 'reader' : 'image'),
          score: m.score ? +m.score.toFixed(3) : undefined,
          rects: [{ x: m.rect.x, y: m.rect.y, w: m.rect.w, h: m.rect.h }] });
      }
      for (const r of p.manual || []) {
        list.push({ what: 'drawn', how: 'manual', rects: [{ x: r.x, y: r.y, w: r.w, h: r.h }] });
      }
      return { page: p.index, w: p.source.width, h: p.source.height, marks: list };
    });
  });

  // Pictures to read the key off: each page with every mark outlined and
  // numbered, and a grid every hundred pixels so a place the run missed can
  // be written down. Into the benchmark's own folder, which git ignores --
  // these are pictures of confidential documents.
  if (REVIEW) {
    const dir = join(folder, 'review');
    mkdirSync(dir, { recursive: true });
    const shots = await page.evaluate(marks => {
      const B = window.Blinded;
      const colour = how => ({ text: '#1f6feb', reader: '#8250df', check: '#d4a72c',
        image: '#1a7f37', manual: '#cf222e' })[how] || '#cf222e';
      return B.state.pages.map(p => {
        const src = p.source;
        const c = document.createElement('canvas');
        c.width = src.width; c.height = src.height;
        const x = c.getContext('2d');
        x.drawImage(src, 0, 0);
        x.strokeStyle = 'rgba(0,0,0,0.12)'; x.lineWidth = 1;
        x.fillStyle = 'rgba(0,0,0,0.45)'; x.font = '11px sans-serif';
        for (let gx = 0; gx < c.width; gx += 100) {
          x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, c.height); x.stroke();
          x.fillText(String(gx), gx + 2, 11);
        }
        for (let gy = 0; gy < c.height; gy += 100) {
          x.beginPath(); x.moveTo(0, gy); x.lineTo(c.width, gy); x.stroke();
          x.fillText(String(gy), 2, gy + 11);
        }
        const mine = marks.find(m => m.page === p.index);
        let n = 0;
        for (const mark of mine.marks) {
          n++;
          for (const r of mark.rects) {
            x.strokeStyle = colour(mark.how); x.lineWidth = 3;
            x.strokeRect(r.x, r.y, r.w, r.h);
          }
          const r = mark.rects[0];
          x.font = 'bold 16px sans-serif';
          x.fillStyle = colour(mark.how);
          x.fillText('#' + n, r.x, Math.max(14, r.y - 4));
        }
        return { page: p.index, url: c.toDataURL('image/png') };
      });
    }, marks);
    for (const shot of shots) {
      writeFileSync(join(dir, 'p' + (shot.page + 1) + '.png'),
        Buffer.from(shot.url.split(',')[1], 'base64'));
    }
    writeFileSync(join(dir, 'marks.json'), JSON.stringify(marks.map(p => ({
      page: p.page, size: p.w + 'x' + p.h,
      marks: p.marks.map((m, i) => ({ n: i + 1, what: m.what, how: m.how, score: m.score,
        rects: m.rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]) })),
    })), null, 1));
    console.log('   drew ' + shots.length + ' pages into ' + join(name, 'review'));
  }

  // Against the key, when there is one.
  const truthPath = join(folder, 'truth.json');
  const result = { search: +searchTook.toFixed(1), check: +sweepTook.toFixed(1) };
  if (existsSync(truthPath)) {
    const truth = JSON.parse(readFileSync(truthPath, 'utf8'));
    const got = score(truth, marks);
    Object.assign(result, { total: got.total, found: got.found, alarms: got.alarms.length });
    console.log('   KEY: found ' + got.found.length + ' of ' + got.total
      + ' · false alarms ' + got.alarms.length);
    for (const i of got.missed) {
      const item = truth.items[i];
      console.log('      missed #' + (i + 1) + ' ' + JSON.stringify(item.what) + ' p' + (item.page + 1)
        + (item.note ? ' (' + item.note + ')' : ''));
    }
    for (const a of got.alarms) {
      console.log('      false alarm ' + JSON.stringify(a.what) + ' (' + a.how + ') p' + (a.page + 1)
        + ' at ' + [a.rect.x, a.rect.y, a.rect.w, a.rect.h].join(','));
    }
    const before = baseline && baseline[name];
    if (before && before.found) {
      const lost = before.found.filter(i => !got.found.includes(i));
      const gained = got.found.filter(i => !before.found.includes(i));
      if (lost.length) {
        regressions++;
        console.log('   !! WORSE: no longer finds ' + lost.map(i => '#' + (i + 1)
          + ' ' + JSON.stringify(truth.items[i].what)).join(', '));
      }
      if (got.alarms.length > before.alarms) {
        regressions++;
        console.log('   !! WORSE: false alarms ' + before.alarms + ' -> ' + got.alarms.length);
      }
      if (gained.length) {
        console.log('   better: now finds ' + gained.map(i => '#' + (i + 1)).join(', '));
      }
      if (got.alarms.length < before.alarms) {
        console.log('   better: false alarms ' + before.alarms + ' -> ' + got.alarms.length);
      }
    }
  }
  const before = baseline && baseline[name];
  if (before) {
    const pct = (now, was) => was ? Math.round((now / was - 1) * 100) : 0;
    console.log('   time: search ' + result.search + 's (' + (pct(result.search, before.search) >= 0 ? '+' : '')
      + pct(result.search, before.search) + '%) · check ' + result.check + 's ('
      + (pct(result.check, before.check) >= 0 ? '+' : '') + pct(result.check, before.check) + '%)');
  }
  results[name] = result;
  await page.close();
}

// The whole bench in two lines, and the verdict.
{
  const all = Object.values(results).filter(r => r.total !== undefined);
  if (all.length) {
    const total = all.reduce((n, r) => n + r.total, 0);
    const found = all.reduce((n, r) => n + r.found.length, 0);
    const alarms = all.reduce((n, r) => n + r.alarms, 0);
    console.log('\nALL: found ' + found + ' of ' + total + ' · false alarms ' + alarms);
  }
  const search = Object.values(results).reduce((n, r) => n + r.search, 0);
  const check = Object.values(results).reduce((n, r) => n + r.check, 0);
  console.log('TIME: search ' + search.toFixed(1) + 's · check ' + check.toFixed(1) + 's');
  if (baseline && !only) {
    const was = Object.values(baseline);
    const s0 = was.reduce((n, r) => n + (r.search || 0), 0);
    const c0 = was.reduce((n, r) => n + (r.check || 0), 0);
    console.log('BASELINE: search ' + s0.toFixed(1) + 's · check ' + c0.toFixed(1) + 's');
  }
  if (regressions) console.log('\n!! ' + regressions + ' regression(s) against the baseline');
  if (SAVE) {
    const keep = Object.assign({}, baseline || {}, results);
    writeFileSync(baselinePath, JSON.stringify(keep, null, 1));
    console.log('saved as the baseline: ' + baselinePath);
  }
}

if (!ran) console.log('Nothing matched' + (only ? ' ' + JSON.stringify(only) : '') + '.');
await browser.close();
server.close();
process.exitCode = regressions ? 1 : 0;
