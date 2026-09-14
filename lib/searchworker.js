// Search worker — kept tiny so it starts fast. The heavy logic lives in
// lib/imagesearch.js and lib/match.js, which this imports via importScripts.

/* global BlindedMatch, BlindedImageSearch, BlindedPagePrep */

importScripts('match.js', 'pageprep.js', 'imagesearch.js');

let ready = null;
let options = null;

function grayFromBitmap(bitmap, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  return BlindedMatch.toGray(data, width, height);
}

self.onmessage = event => {
  const message = event.data;
  if (message.type === 'init') {
    options = BlindedImageSearch.cloneableOptions(message.options);
    ready = [];
    for (const entry of message.entries) {
      const prepared = BlindedImageSearch.prepareTemplate(entry.template, options);
      if (prepared) ready.push({
        key: entry.key,
        threshold: entry.threshold,
        smallText: entry.smallText,
        ...prepared,
      });
    }
    return;
  }
  if (message.type !== 'page' || !ready) return;

  let gray;
  if (message.bitmap) {
    gray = grayFromBitmap(message.bitmap, message.width, message.height);
  } else {
    gray = message.gray;
  }

  const results = [];
  for (const item of ready) {
    const found = BlindedImageSearch.searchPage(
      gray, message.width, message.height, item, options);
    results.push({
      key: item.key,
      matches: found.matches,
      best: found.best,
      near: found.near || [],
    });
  }
  self.postMessage({ type: 'result', index: message.index, results });
};
