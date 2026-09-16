import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTextPdf } from './fixture.mjs';
const root = process.cwd();
const TYPES = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.pdf':'application/pdf','.jpg':'image/jpeg','.svg':'image/svg+xml' };
const server = createServer((req,res)=>{
  const p = join(root, normalize(decodeURIComponent(new URL(req.url,'http://x').pathname)));
  try { statSync(p); } catch { return res.writeHead(404).end(); }
  res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream'});
  createReadStream(p).pipe(res);
});
await new Promise(r=>server.listen(0,r));
const base='http://127.0.0.1:'+server.address().port+'/';
const fixture = join(tmpdir(),'dbg.pdf');
writeFileSync(fixture, buildTextPdf());
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(base+'index.html');
await page.waitForFunction(()=>window.Blinded);
await page.setInputFiles('#file', fixture);
await page.waitForSelector('#view-review:not([hidden])', { timeout: 60000 });
await page.evaluate(() => { document.getElementById('organisesect').open = true; });
await page.waitForTimeout(150);
const before = await page.evaluate(() => window.Blinded.state.pages.length);
const errs2 = [];
page.on('console', m => { if (m.type() === 'error') errs2.push(m.text()); });
await page.setInputFiles('#addfile', fixture);
await page.waitForTimeout(3000);
const after = await page.evaluate(() => ({
  pages: window.Blinded.state.pages.length,
  busy: document.getElementById('busy').hidden,
  err: (document.getElementById('drop-error') || {}).textContent,
  errHidden: (document.getElementById('drop-error') || {}).hidden,
}));
console.log('ADD:', JSON.stringify({ before, after, errs: errs2.slice(0,3), pageErrs: errs.slice(0,3) }));
await browser.close(); server.close();
