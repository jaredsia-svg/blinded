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
//   node tools/bench.mjs              every benchmark
//   node tools/bench.mjs kimberly     the ones whose name matches
//
// What it prints, per picked image: how many matches came back at the bar the
// draft was saved with, the best score, and the whole verified distribution
// sorted — which is where a flood of look-alikes shows itself as a dense
// plateau under a handful of real ones. A copy of that distribution is written
// beside the run as JSON so a rule for choosing the bar can be tried against
// it without searching the document again.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, statSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const bench = process.env.BENCH || join(root, 'bench');
const only = process.argv[2];

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
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

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

  // Then the comprehensive check, which is the half that matters on a scanned
  // page: the plain search reads the text layer, and a photographed slide has
  // none. Reported separately because they cost very different amounts.
  const swept = Date.now();
  const sweepAdded = await page.evaluate(() => window.Blinded.runSweep());
  await page.waitForFunction(() => document.getElementById('busy').hidden,
    undefined, { timeout: 1800000 });
  const sweepTook = (Date.now() - swept) / 1000;

  const out = await page.evaluate(() => {
    const B = window.Blinded;
    return {
      pages: B.state.pages.length,
      // What the check found and then threw away. A word that cleared its bar
      // and is still not on the page was refused by one of the vetoes, and
      // that is a different failure from one that never scored well enough.
      refused: (B.state.sweepRefusedAt || []).map(r => ({
        term: r.term, page: r.pageIndex, at: Math.round(r.at), why: r.why || 'reader' })),
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
        // Every mark this word has, not only the comprehensive check's. A word
        // can be found as a picture by the search itself — that is what the
        // typed-word image pass is for — and counting only the check's marks
        // reported four copies of a found word as found nowhere, because the
        // check had correctly deduped its own candidates against them.
        seen: B.state.pages.reduce((n, p) =>
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
  if (out.refused.length) {
    const byTerm = new Map();
    for (const one of out.refused) {
      const key = one.term + ' (' + one.why + ')';
      byTerm.set(key, (byTerm.get(key) || 0) + 1);
    }
    console.log('   refused ' + [...byTerm].map(([t, n]) => JSON.stringify(t) + ' x' + n)
      .join(', '));
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
      + ' (' + term.bySweep + ' by the check)' + best);
  }
  for (const logo of out.templates) {
    console.log('   image ' + logo.id + ' p' + (logo.page + 1) + ' ' + logo.size
      + ' · bar ' + logo.bar + ' · ' + logo.matches + ' matches · best '
      + logo.best.toFixed(3));
    console.log('      ' + JSON.stringify(logo.all.slice(0, 16)));
  }
  writeFileSync(join(folder, 'scores.json'), JSON.stringify(out, null, 1));
  await page.close();
}

if (!ran) console.log('Nothing matched' + (only ? ' ' + JSON.stringify(only) : '') + '.');
await browser.close();
server.close();
