// The favicon, in the formats a search result will actually take.
//
// icon.svg is the logo and stays the source of truth, but an SVG on its own
// is not enough to get a picture beside the result in Google. What that
// wants is a square raster whose side is a multiple of 48, at a stable URL,
// crawlable, and pointed at from the <head> of the home page. So the same
// mark is rendered here at the sizes that satisfy it:
//
//   favicon.ico           16, 32 and 48 in one file, each drawn from the
//                         vector at its own size rather than shrunk down
//                         from a big one -- three white bars 3px apart
//                         survive being rendered small and do not survive
//                         being resampled small
//   icon-192.png          the multiple of 48 a crawler is offered
//   apple-touch-icon.png  192 as well, so every raster on the site obeys the
//                         same rule, and square-cornered and full-bleed
//                         because iOS puts its own mask over it and a
//                         transparent corner comes out black
//
//   node tools/icon.mjs        rewrite them from icon.svg
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Through fileURLToPath rather than .pathname, for the Windows drive letter.
const root = fileURLToPath(new URL('..', import.meta.url));
const svg = readFileSync(resolve(root, 'icon.svg'), 'utf8');

// The tile is rounded, so its corners are transparent and have to stay that
// way: a favicon sits on a white row in one browser and a dark one in the
// next, and a corner filled in with either is wrong in the other half of the
// world. omitBackground is what keeps them clear.
const page = (size, square) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${size}px; height: ${size}px; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style>${square ? svg.replace(/ rx="12"/, '') : svg}`;

const browser = await chromium.launch();
const shot = async (size, square) => {
  const tab = await browser.newPage({ viewport: { width: size, height: size },
                                      deviceScaleFactor: 1 });
  await tab.setContent(page(size, square), { waitUntil: 'load' });
  const png = await tab.screenshot({ type: 'png', omitBackground: !square });
  await tab.close();
  return png;
};

// An .ico is a header, a directory, and then the images one after another.
// Since Vista each image may simply be a PNG, which every browser that is
// still shipping reads, so there is no need to write bitmaps by hand.
function ico(images) {
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);              // reserved
  dir.writeUInt16LE(1, 2);              // 1 = icon
  dir.writeUInt16LE(images.length, 4);
  let at = dir.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);      // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);           // not a palette
    dir.writeUInt8(0, e + 3);           // reserved
    dir.writeUInt16LE(1, e + 4);        // colour planes
    dir.writeUInt16LE(32, e + 6);       // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(at, e + 12);
    at += png.length;
  });
  return Buffer.concat([dir, ...images.map(one => one.png)]);
}

const small = [];
for (const size of [16, 32, 48]) small.push({ size, png: await shot(size, false) });
writeFileSync(resolve(root, 'favicon.ico'), ico(small));
writeFileSync(resolve(root, 'icon-192.png'), await shot(192, false));
writeFileSync(resolve(root, 'apple-touch-icon.png'), await shot(192, true));
await browser.close();

// What these were drawn from. The pictures cannot be checked against the
// vector without a browser, which the self-test has not got, so it checks
// this instead and says to run this tool when the logo has moved on without
// them.
writeFileSync(resolve(root, 'content', 'icons.json'),
  JSON.stringify({ note: 'Written by tools/icon.mjs. Run it after editing icon.svg.',
                   from: 'icon.svg',
                   sha256: createHash('sha256').update(svg).digest('hex') },
                 null, 2) + '\n');

console.log('wrote favicon.ico (16, 32, 48), icon-192.png, apple-touch-icon.png');
