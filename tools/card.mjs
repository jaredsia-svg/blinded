// The picture that stands in for a link to this, in a message or a post.
//
// Drawn rather than photographed: the claim is a before and an after, so the
// card is the before and the after, side by side, with one line saying what
// changed between them. It is built from the gallery pair already in the
// repo, so it cannot show something the tool does not do.
//
//   node tools/card.mjs       writes og.png at 1200x630
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const as64 = name =>
  'data:image/jpeg;base64,' + readFileSync(resolve(root, name)).toString('base64');

const html = `<!doctype html><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; display: flex; flex-direction: column;
    background: #0d1117; color: #fff; overflow: hidden;
    font: 400 20px/1.4 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .head { padding: 40px 56px 26px; }
  .mark { display: flex; align-items: center; gap: 13px; font-size: 38px; font-weight: 700; }
  .mark svg { width: 52px; }
  .claim { margin-top: 14px; font-size: 27px; color: #b9c2d0; }
  .claim b { color: #fff; font-weight: 600; }
  .pair { flex: 1; display: flex; gap: 22px; padding: 0 56px 44px; min-height: 0; }
  .one { flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .cap { font-size: 17px; letter-spacing: .09em; text-transform: uppercase; color: #8e99a8; }
  .cap.after { color: #f0a63c; }
  .shot {
    flex: 1; min-height: 0; border-radius: 10px; overflow: hidden;
    border: 1px solid #2b333f; background: #fff; padding: 6px;
  }
  .shot img { width: 100%; height: 100%; object-fit: contain; object-position: center; display: block; }
</style>
<div class="head">
  <div class="mark"><svg viewBox="0 0 26 15"><g fill="currentColor">
    <rect width="26" height="6.4" rx="2"/><rect y="8.6" width="14" height="6.4" rx="2"/>
    <rect x="16.6" y="8.6" width="3.6" height="6.4" rx="1.5"/>
    <rect x="22.2" y="8.6" width="2" height="6.4" rx="1"/>
  </g></svg> Blinded</div>
  <p class="claim">Redaction for confidential documents.
    <b>Nothing is uploaded.</b></p>
</div>
<div class="pair">
  <div class="one"><div class="cap">Before</div>
    <div class="shot"><img src="${as64('gallery/slide-4-original.jpg')}"></div></div>
  <div class="one"><div class="cap after">After</div>
    <div class="shot"><img src="${as64('gallery/slide-4-redacted.jpg')}"></div></div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 },
                                     deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(250);
writeFileSync(resolve(root, 'og.png'), await page.screenshot({ type: 'png' }));
await browser.close();
console.log('wrote og.png');
