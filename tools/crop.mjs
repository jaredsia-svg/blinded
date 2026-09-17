// Cuts a match out of a benchmark document and writes it large, so a score can
// be looked at instead of argued about. The positions come from bench.mjs's
// scores.json.
//
//   node tools/crop.mjs bench/Some-Doc tpl10          the first eight matches
//   node tools/crop.mjs bench/Some-Doc tpl10 3,4,5    those ones
//   node tools/crop.mjs bench/Some-Doc Acme  best     the best it scored, even
//                                                    if the bar turned it away
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const folder = resolve(process.argv[2]);
const wanted = process.argv[3];
const wantBest = process.argv[4] === 'best';
const picks = process.argv[4] && !wantBest
  ? process.argv[4].split(',').map(Number) : null;
const scores = JSON.parse(readFileSync(join(folder, 'scores.json')));
// Either a picked image by its id, or a word the comprehensive check found.
const logo = scores.templates.find(t => t.id === wanted)
  || scores.terms.find(t => t.term === wanted)
  || scores.templates[0];
if (logo && logo.term) logo.id = logo.term.replace(/[^a-z0-9]+/gi, '-');
// `best` cuts out the top score the check reached for a word, whether or not
// it cleared the bar — the near miss is the thing worth looking at.
const spots = (wantBest
  ? [logo.best && logo.best.at && { ...logo.best.at, s: logo.best.score }]
  : picks ? picks.map(i => logo.where[i])
  : logo.where.slice(0, 8)).filter(Boolean);
const doc = readdirSync(folder).find(f => /\.(pdf|jpe?g|png)$/i.test(f) && !/redact/i.test(f));

const server = createServer((req, res) => {
  const want = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const path = join(root, want === '/' ? '/index.html' : want);
  if (!path.startsWith(root)) { res.writeHead(403).end('no'); return; }
  try { statSync(path); } catch { res.writeHead(404).end('no'); return; }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.css': 'text/css' }[extname(path)]
    || 'application/octet-stream' });
  createReadStream(path).pipe(res);
});
const port = await new Promise(done => server.listen(0, () => done(server.address().port)));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto('http://localhost:' + port + '/index.html');
await page.waitForSelector('#view-drop:not([hidden])', { timeout: 20000 });
await page.setInputFiles('#file', join(folder, doc));
await page.waitForSelector('#view-review:not([hidden])', { timeout: 180000 });

const cuts = await page.evaluate(({ spots }) => spots.map((spot, i) => {
  const source = window.Blinded.state.pages[spot.p].source;
  const pad = Math.max(16, Math.round(Math.max(spot.w, spot.h) * 0.4));
  const cut = document.createElement('canvas');
  cut.width = spot.w + pad * 2;
  cut.height = spot.h + pad * 2;
  const ctx = cut.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cut.width, cut.height);
  ctx.drawImage(source, spot.x - pad, spot.y - pad, cut.width, cut.height,
    0, 0, cut.width, cut.height);
  // Nearest-neighbour, four times: a small match is being judged, and a
  // smoothed enlargement would hide the very edges that decide it.
  const big = document.createElement('canvas');
  big.width = cut.width * 4;
  big.height = cut.height * 4;
  const bx = big.getContext('2d');
  bx.imageSmoothingEnabled = false;
  bx.drawImage(cut, 0, 0, big.width, big.height);
  return { i, data: big.toDataURL('image/png') };
}), { spots });

for (const cut of cuts) {
  const name = join(folder, 'crop-' + logo.id + '-' + cut.i + '.png');
  writeFileSync(name, Buffer.from(cut.data.split(',')[1], 'base64'));
  console.log(name, 'score', spots[cut.i].s, 'page', spots[cut.i].p + 1,
    spots[cut.i].w + 'x' + spots[cut.i].h);
}
await browser.close();
server.close();
