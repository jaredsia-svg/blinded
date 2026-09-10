// Runs the template matcher over the pages of a document.
//
// lib/match.js does the arithmetic on plain arrays; this is the part that
// knows about canvases, about searching a logo at sizes other than the one it
// was picked at, and about not freezing the tab while it works.
//
// The size search is the reason this is not a one-liner. A logo picked from a
// letterhead may appear again half that size in a footer, so the same template
// is correlated against the page resampled to several different scales. Rather
// than growing the template — cost is linear in its area, so a 1.75x template
// costs three times as much per position — the page is shrunk or grown around
// a template held at one small working size. Every scale then costs about the
// same, and the whole sweep stays predictable.
(function (root) {
  'use strict';

  const Match = root.BlackbarMatch;

  // Pulls the picked region out of a canvas as greyscale.
  function templateFrom(canvas, rect) {
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const w = Math.min(canvas.width - x, Math.round(rect.w));
    const h = Math.min(canvas.height - y, Math.round(rect.h));
    if (w < 4 || h < 4) return null;

    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(x, y, w, h).data;
    return { gray: Match.toGray(data, w, h), width: w, height: h };
  }

  function grayOf(canvas) {
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return Match.toGray(data, canvas.width, canvas.height);
  }

  // Lets the browser paint between pages. Without it the whole sweep runs in
  // one turn of the event loop and the progress message never appears — the
  // tab simply locks until the search is finished.
  const breathe = () => new Promise(resolve => setTimeout(resolve, 0));

  /**
   * Finds `template` across every page.
   *
   * pages: [{ index, source }] where source is the pristine page canvas.
   * Returns [{ pageIndex, x, y, w, h, score }] in source-canvas coordinates.
   */
  async function search(pages, template, options, onProgress) {
    const opts = options || {};
    const scales = opts.scales || Match.SCALES;
    const threshold = opts.threshold === undefined ? Match.THRESHOLD : opts.threshold;
    const work = opts.workSize || Match.WORK_SIZE;

    // Shrink the template to its working size once. Everything downstream is
    // measured against this, so `base` is also what converts a hit's position
    // back into real page pixels.
    const base = work / Math.max(template.width, template.height);
    const tw = Math.max(2, Math.round(template.width * base));
    const th = Math.max(2, Math.round(template.height * base));
    const small = Match.resize(template.gray, template.width, template.height, tw, th);
    const prepared = Match.prepareTemplate(small, tw, th);
    // A blank or near-blank pick has no structure to search for.
    if (!prepared) return [];

    const results = [];
    for (const page of pages) {
      const gray = grayOf(page.source);
      const perPage = [];

      for (const scale of scales) {
        // At scale s the logo is s times the picked size, so the page has to
        // shrink by s for the fixed-size template to sit over it.
        const factor = base / scale;
        const pw = Math.round(page.source.width * factor);
        const ph = Math.round(page.source.height * factor);
        if (pw < tw || ph < th) continue;

        const scaled = Match.resize(gray, page.source.width, page.source.height, pw, ph);
        for (const hit of Match.correlate(scaled, pw, ph, prepared, { threshold })) {
          perPage.push({
            x: hit.x / factor,
            y: hit.y / factor,
            w: template.width * scale,
            h: template.height * scale,
            score: hit.score,
            scale,
          });
        }
      }

      // Suppress within the page: the same logo found at three neighbouring
      // scales is one logo, and only the best-scoring box should survive.
      for (const hit of Match.suppress(perPage, opts.overlap)) {
        results.push({ ...hit, pageIndex: page.index });
      }

      if (onProgress) onProgress(page.index + 1, pages.length);
      await breathe();
    }
    return results;
  }

  root.BlackbarImageSearch = { search, templateFrom, grayOf };
})(typeof window !== 'undefined' ? window : globalThis);
