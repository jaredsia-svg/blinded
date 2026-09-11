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

importScripts('match.js', 'imagesearch.js');

const Search = self.BlindedImageSearch;

let ready = [];
let options = {};

self.onmessage = event => {
  const message = event.data;

  if (message.type === 'init') {
    options = message.options || {};
    ready = [];
    for (const entry of message.entries) {
      const prepared = Search.prepareTemplate(entry.template, options);
      // A template with no structure in it is skipped rather than reported as
      // finding nothing everywhere.
      if (prepared) ready.push({
        key: entry.key, threshold: entry.threshold, smallText: entry.smallText, ...prepared,
      });
    }
    return;
  }

  if (message.type === 'page') {
    const results = ready.map(item => {
      const found = Search.searchPage(message.gray, message.width, message.height, item, options);
      return { key: item.key, matches: found.matches, best: found.best };
    });
    self.postMessage({ type: 'result', index: message.index, results });
  }
};
