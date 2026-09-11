// Stamps index.html's asset links with a hash of what they point at.
//
// A reviewer who loaded the tool yesterday gets yesterday's app.js and
// app.css from their browser cache, and the two halves of a change can
// arrive separately: new markup against old styling shows the labels that
// styling was there to hide, and new styling against old behaviour shows a
// tool that looks selected and does nothing. That was reported from the
// field, and it is not something a reviewer can be expected to diagnose.
//
// The query string makes the URL change whenever the file does, so the
// browser fetches it instead of guessing. Run this after touching any asset;
// the test suite fails if the stamps are stale, so it cannot be forgotten.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
// Every page that links an asset, not just the front one: the FAQ loads the
// same stylesheet, and a page left unstamped is a page that can be served from
// a stale cache — which is the whole thing this exists to prevent.
const PAGES = ['index.html', 'faq.html'];

// Only local assets: a versioned URL for a file we do not control is a lie.
const LINK = /(\s(?:href|src)=")([A-Za-z0-9_./-]+\.(?:css|js))(?:\?v=[0-9a-f]+)?(")/g;

export function stamped(html) {
  return html.replace(LINK, (whole, before, path, after) => {
    let body;
    try { body = readFileSync(join(root, path)); } catch { return whole; }
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
    return before + path + '?v=' + hash + after;
  });
}

export function isStale() {
  return PAGES.some(name => {
    let html;
    try { html = readFileSync(join(root, name), 'utf8'); } catch { return false; }
    return stamped(html) !== html;
  });
}

if (process.argv[1] && process.argv[1].endsWith('stamp.mjs')) {
  let changed = 0;
  for (const name of PAGES) {
    const path = join(root, name);
    let html;
    try { html = readFileSync(path, 'utf8'); } catch { continue; }
    const next = stamped(html);
    if (next === html) continue;
    writeFileSync(path, next);
    changed += [...next.matchAll(/\?v=[0-9a-f]+/g)].length;
  }
  console.log(changed ? 'stamped ' + changed + ' asset links' : 'asset stamps already current');
}
