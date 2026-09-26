// Keeps the tool working with the network gone.
//
// The site says: open the page, pull the cable out, and it carries on. It did
// not. The front page loads only what it needs to draw itself; the PDF reader's
// worker, the matching kernel, the fonts and the page reader are fetched the
// first time a document is opened -- and with the cable out, that fetch fails:
// "Setting up fake worker failed: Failed to fetch dynamically imported module".
// The browser's own cache could not cover for it either, because every file is
// served no-cache, which means "ask the server first".
//
// So this keeps a copy of each file here, on this machine, and answers from it
// only when the network does not. While the network is there every request
// goes to it exactly as before -- a new release is picked up the moment it is
// published -- and the answer is copied into the store on its way back.
//
// Nothing about a document passes through here. This sees requests for the
// site's own files, and the site never sends a document anywhere: the page's
// security policy forbids it, and there is no request here that could carry
// one. Other sites -- the payment processor, the license service -- are not
// touched at all, and neither is the payment page, which needs the network to
// do anything.
'use strict';

const STORE = 'blinded-offline';

// Everything the tool needs before its first document, in the order it is
// needed. The self-test holds this to the files the page actually loads, and
// to the files on disk.
const CORE = [
  '/',
  '/app.css',
  '/app.js',
  '/lib/schedule.js',
  '/lib/detect.js',
  '/lib/labels.js',
  '/lib/boxes.js',
  '/lib/measure.js',
  '/lib/match.js',
  '/lib/pageprep.js',
  '/lib/pagerole.js',
  '/lib/imagesearch.js',
  '/lib/ocr.js',
  '/lib/textimage.js',
  '/lib/pdfwrite.js',
  '/lib/pdfread.js',
  '/lib/pass.js',
  '/lib/pay.js',
  '/lib/render.js',
  '/lib/boot.mjs',
  '/lib/searchworker.js',
  '/lib/fft.wasm',
  '/vendor/pdf.min.mjs',
  '/vendor/pdf.worker.min.mjs',
  '/vendor/fonts/arimo-latin-400-normal.woff2',
  '/vendor/fonts/arimo-latin-400-italic.woff2',
  '/vendor/fonts/arimo-latin-700-normal.woff2',
  '/vendor/fonts/arimo-latin-700-italic.woff2',
  '/vendor/fonts/tinos-latin-400-normal.woff2',
  '/vendor/fonts/tinos-latin-400-italic.woff2',
  '/vendor/fonts/tinos-latin-700-normal.woff2',
  '/vendor/fonts/tinos-latin-700-italic.woff2',
  '/faq.html',
  '/license/',
  '/icon.svg',
  '/favicon.ico',
  '/icon-192.png',
];

// Never answered from the store. The payment page is no use without the
// network, and a stale copy of it could only mislead.
const NEVER = ['/unlock.html'];

// One copy per file, whatever version stamp the page asked for it with: the
// page asks for app.js?v=1234, and offline the copy of app.js is the answer.
function keyOf(url) {
  const at = new URL(url, self.location.href);
  at.search = '';
  at.hash = '';
  if (at.pathname.endsWith('/index.html')) at.pathname = at.pathname.slice(0, -'index.html'.length);
  return at.href;
}

async function keep(store, url) {
  try {
    const answer = await fetch(url, { cache: 'no-cache' });
    if (answer.status === 200) await store.put(keyOf(url), answer);
    return answer.status === 200;
  } catch {
    return false;
  }
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(STORE).then(store => Promise.all(CORE.map(url => keep(store, url)))));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// The page asks for more to be kept -- the page reader's engine and language
// data, which only it knows how to choose -- and is told when that is done.
self.addEventListener('message', event => {
  const ask = event.data || {};
  if (ask.type !== 'keep' || !Array.isArray(ask.urls)) return;
  const reply = event.ports && event.ports[0];
  event.waitUntil(caches.open(STORE).then(async store => {
    const kept = await Promise.all(ask.urls
      .filter(url => new URL(url, self.location.href).origin === self.location.origin)
      .map(url => keep(store, url)));
    if (reply) reply.postMessage({ kept: kept.filter(Boolean).length, of: kept.length });
  }));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.includes(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const answer = await fetch(request);
      if (answer.status === 200 && answer.type === 'basic') {
        const copy = answer.clone();
        event.waitUntil(caches.open(STORE).then(store => store.put(keyOf(request.url), copy))
          .catch(() => {}));
      }
      return answer;
    } catch (error) {
      const kept = await caches.match(keyOf(request.url));
      if (kept) return kept;
      // A page of the site that was never visited, asked for with the
      // network gone: the tool itself is the useful answer.
      if (request.mode === 'navigate') {
        const home = await caches.match(keyOf('/'));
        if (home) return home;
      }
      throw error;
    }
  })());
});
