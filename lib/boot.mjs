// pdf.js ships as an ES module; everything else here is a classic script, so it
// is bridged onto the global the other modules already look for. Both the
// library and its worker come from vendor/ — no CDN, because a tool that
// promises the file never leaves the machine should not be fetching code from
// somewhere else while it makes that promise.
//
// A file rather than an inline script so that the page's Content-Security-Policy
// can refuse inline script outright. An inline block would need its hash in the
// policy, which is a thing to forget on every edit.
import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
window.pdfjsLib = pdfjsLib;
window.dispatchEvent(new Event('blinded:ready'));
