// One core's share of an image search.
//
// The main thread owns the document and the canvases; this owns nothing but
// arithmetic. It is handed a page's greyscale and asked to search it for every
// template, which is the expensive part and the only part that parallelises
// cleanly — no page's result depends on any other's.
//
// lib/imagesearch.js touches the DOM in exactly two places, templateFrom and
// grayOf, and neither is reachable from here: a worker never sees a canvas.
// Everything else in it is arithmetic over plain arrays and runs unchanged.
'use strict';

importScripts('match.js', 'pageprep.js', 'imagesearch.js');

const Search = self.BlindedImageSearch;

// The transforms in WebAssembly, loaded once as the worker starts and waited
// for before the first page. If it cannot load, this resolves all the same
// and the search runs on the JavaScript it always ran on.
const kernelReady = self.BlindedMatch.loadKernel(new URL('fft.wasm', self.location.href).href);

let ready = [];
let options = {};

self.onmessage = async event => {
  await kernelReady;
  const message = event.data;

  if (message.type === 'init') {
    options = message.options || {};
    ready = [];
    for (const entry of message.entries) {
      const prepared = Search.prepareTemplate(entry.template, options);
      // A template with no structure in it is skipped rather than reported as
      // finding nothing everywhere.
      if (prepared) {
        const pages = entry.pageIndexes;
        ready.push({
          key: entry.key, threshold: entry.threshold, smallText: entry.smallText,
          pageIndexes: pages && pages.length ? new Set(pages) : null,
          // Where the page reader put something that looks like this word,
          // so the matcher can look there whether or not it would have
          // nominated the spot itself.
          seeds: entry.seeds || null,
          ...prepared,
        });
      }
    }
    return;
  }

  if (message.type === 'page') {
    // Either the greyscale itself, or the page as a bitmap to make it from.
    // The bitmap is the usual case: decoding it here keeps the main thread
    // free, which is the difference between a tab that stays usable during a
    // long sweep and one the browser offers to kill.
    let gray = message.gray;
    if (!gray && message.bitmap) {
      const canvas = new OffscreenCanvas(message.width, message.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(message.bitmap, 0, 0);
      message.bitmap.close();
      const data = ctx.getImageData(0, 0, message.width, message.height).data;
      gray = self.BlindedMatch.toGray(data, message.width, message.height);
    }
    // How coarse the page is came with it: the worker has the pixels but not
    // the paper size they were rendered from.
    const pageOpts = message.dpi ? { ...options, pageDpi: message.dpi } : options;
    const results = ready.map(item => {
      if (item.pageIndexes && !item.pageIndexes.has(message.index)) {
        return { key: item.key, matches: [], best: 0, near: [] };
      }
      const mine = item.seeds
        ? item.seeds.filter(seed => seed.pageIndex === message.index) : null;
      const itemOpts = mine && mine.length ? { ...pageOpts, seeds: mine } : pageOpts;
      const found = Search.searchPage(gray, message.width, message.height, item, itemOpts);
      return { key: item.key, matches: found.matches, best: found.best, near: found.near };
    });
    self.postMessage({ type: 'result', index: message.index, results });
  }
};
