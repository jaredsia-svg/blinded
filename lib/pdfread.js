// Reads a PDF in the browser: page images to show, and text with coordinates
// to search. Wraps pdf.js so nothing else in the app has to know about it.
//
// Everything here is local. pdf.js is vendored in vendor/ and its worker is
// loaded from the same directory, so the page makes no network request once it
// has loaded, and the file the reviewer picked never leaves the tab.
(function (root) {
  'use strict';

  // Rasterisation resolution. 2x device pixels per PDF point keeps small print
  // readable while reviewing, which matters: the reviewer has to be able to
  // see what they are about to cover.
  const RENDER_SCALE = 2;

  function lib() {
    if (!root.pdfjsLib) throw new Error('Blinded: pdf.js has not finished loading');
    return root.pdfjsLib;
  }

  // pdf.js continues a page render from a requestAnimationFrame callback, and
  // a hidden tab has no frames — so opening a document and switching away
  // parks the render mid-page until you come back and look at it. The wrapper
  // keeps those callbacks arriving while the page is hidden; when it is
  // visible nothing changes and real frames are used.
  if (root.BlindedSchedule) root.BlindedSchedule.keepRenderingWhenHidden();

  // Pulls the text of one page, with every run positioned in the coordinate
  // space of the canvas that page was rendered onto — which is what lets a
  // character span become a rectangle later.
  async function readItems(page, viewport) {
    const content = await page.getTextContent();
    const { Util } = lib();
    const items = [];

    // pdf.js installs each embedded font under a generated family name while
    // it renders, and that is the only handle on the actual metrics. It is
    // only present once the page has been rendered, and not at all for fonts
    // it could not load, so every lookup is allowed to fail.
    const familyOf = name => {
      if (!name) return null;
      try {
        const font = page.commonObjs.get(name);
        return font && font.loadedName ? font.loadedName : null;
      } catch {
        return null;
      }
    };

    for (const item of content.items) {
      // Marked-content markers have no glyphs and no transform.
      if (typeof item.str !== 'string' || !item.transform) continue;

      const tx = Util.transform(viewport.transform, item.transform);
      // The vertical scale of the composed matrix is the rendered font height;
      // item.height is in text space and would be wrong once the viewport
      // scale is applied.
      const height = Math.hypot(tx[2], tx[3]) || item.height * viewport.scale;
      items.push({
        str: item.str,
        x: tx[4],
        y: tx[5],
        w: item.width * viewport.scale,
        h: height,
        hasEOL: Boolean(item.hasEOL),
        font: familyOf(item.fontName),
        // Which way the run is written, on the page as drawn: 0 for ordinary
        // text, a quarter turn either way for text set vertically, a half
        // turn for text upside down. Without it every run was boxed as if it
        // were horizontal, and a name set up the side of a page was covered
        // by a bar lying across it -- in the wrong place, with the name left
        // showing.
        angle: Math.atan2(tx[1], tx[0]),
      });
    }
    return items;
  }

  // Opens a PDF and returns one entry per page: a canvas of the rendered page,
  // the stitched text, and the placed items behind it.
  //
  // `onProgress` is called per page because a long document takes real time to
  // rasterise, and a reviewer staring at a frozen tab assumes it crashed.
  // A locked file, told apart from a broken one.
  //
  // pdf.js throws a PasswordException with a code saying which of the two
  // things happened: it wants a password, or the one it was given is wrong.
  // Both come back as this, so the caller can ask rather than report a file
  // it could not read.
  const NEED_PASSWORD = 'need-password';
  const WRONG_PASSWORD = 'wrong-password';

  function lockedError(error) {
    if (!error || error.name !== 'PasswordException') return null;
    // 1 is NEED_PASSWORD and 2 is INCORRECT_PASSWORD in pdf.js.
    const locked = new Error(error.code === 2
      ? 'That password did not open the file.'
      : 'This PDF is password protected.');
    locked.blindedLocked = error.code === 2 ? WRONG_PASSWORD : NEED_PASSWORD;
    return locked;
  }

  // The page drawn small with its text left out, and where what is left has
  // edges: pictures, logos, charts, outlined lettering -- everything a word
  // could be in that the text layer does not report. pdf.js draws a font's
  // text through fillText, so a canvas that ignores fillText draws the rest.
  // Lettering drawn any other way (a Type 3 font, outlines) is still drawn,
  // so it counts as picture and is read: the safe direction.
  //
  // Edges rather than darkness: a slide's tinted or graded background has
  // none, and counted as ink it made every slide one picture.
  //
  // Returns the areas in the page's own render pixels, and the share of the
  // page they cover.
  const MAP_LONG_EDGE = 480;
  const MAP_EDGE = 24;
  const MAP_GROW = 3;
  async function pictureMap(page, viewport) {
    const small = MAP_LONG_EDGE / Math.max(viewport.width, viewport.height);
    const view = page.getViewport({ scale: viewport.scale * small });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(view.width));
    c.height = Math.max(1, Math.round(view.height));
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillText = () => {};
    ctx.strokeText = () => {};
    await page.render({ canvasContext: ctx, viewport: view }).promise;
    const W = c.width, H = c.height;
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const grown = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const dx = x + 2 < W ? Math.abs(g[i] - g[i + 2]) : 0;
        const dy = y + 2 < H ? Math.abs(g[i] - g[i + 2 * W]) : 0;
        if (Math.max(dx, dy) <= MAP_EDGE) continue;
        for (let yy = Math.max(0, y - MAP_GROW); yy <= Math.min(H - 1, y + MAP_GROW); yy++) {
          for (let xx = Math.max(0, x - MAP_GROW); xx <= Math.min(W - 1, x + MAP_GROW); xx++) grown[yy * W + xx] = 1;
        }
      }
    }
    const seen = new Uint8Array(W * H);
    const boxes = [];
    let covered = 0;
    for (let i = 0; i < W * H; i++) {
      if (!grown[i] || seen[i]) continue;
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop();
        const x = k % W, y = (k - x) / W;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x + 1 < W && grown[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack.push(k + 1); }
        if (x > 0 && grown[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack.push(k - 1); }
        if (y + 1 < H && grown[k + W] && !seen[k + W]) { seen[k + W] = 1; stack.push(k + W); }
        if (y > 0 && grown[k - W] && !seen[k - W]) { seen[k - W] = 1; stack.push(k - W); }
      }
      if (x1 - x0 < 6 && y1 - y0 < 6) continue;
      covered += (x1 - x0 + 1) * (y1 - y0 + 1);
      boxes.push({ x: x0 / small, y: y0 / small, w: (x1 - x0 + 1) / small, h: (y1 - y0 + 1) / small });
    }
    return { boxes, area: covered / (W * H) };
  }

  async function load(bytes, onProgress, options) {
    const pdfjs = lib();
    const OPS = pdfjs.OPS;
    const password = options && options.password;
    let doc;
    try {
      doc = await pdfjs.getDocument({
        data: bytes,
        // A corrupt file should fail loudly here rather than half-render and
        // give a false sense of a complete review.
        stopAtErrors: true,
        isEvalSupported: false,
        // Opening a locked file is the reviewer's own document being unlocked
        // on their own machine, with a password they typed into this tab. It
        // goes no further than pdf.js, in this tab, like the file itself.
        ...(password ? { password } : {}),
      }).promise;
    } catch (error) {
      const locked = lockedError(error);
      if (locked) throw locked;
      throw error;
    }

    const pages = [];
    let stillWorthAsking = true;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const base = page.getViewport({ scale: 1 });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;

      // Whether this page could hide lettering the text layer does not report.
      // Only two things can: pixels, and vector outlines — and outlined glyphs
      // are filled paths. A page with neither has nothing for the reader to
      // find, so it need not be read at all.
      //
      // Asking is not free. The operator list was expected to be served from
      // pdf.js's cache, having just been built to render the page; it is not,
      // and measured on a graphics-heavy slide it adds about half a second per
      // page — which is most of a page load, to save nothing at all, because
      // every page of a slide deck has images on it.
      //
      // So the asking stops at the first page that has to be read. Documents
      // are not usually half text and half pictures, and the assumption is
      // made in the safe direction: a page not inspected is a page read. A
      // contract skips its whole document for a few milliseconds a page; a
      // deck pays for one page and then stops asking.
      let couldHideText = true;
      try {
        if (!stillWorthAsking) throw new Error('not asking');
        const ops = await page.getOperatorList();
        let images = 0;
        let fills = 0;
        for (const fn of ops.fnArray) {
          if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject
            || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) images++;
          else if (fn === OPS.fill || fn === OPS.eoFill) fills++;
        }
        couldHideText = images > 0 || fills > 0;
        if (couldHideText) stillWorthAsking = false;
      } catch {
        // Never guess "nothing here" from a failure: a page we cannot inspect
        // is a page we read.
        couldHideText = true;
      }

      // Where the page has pictures, as against the words its text layer
      // holds (see pictureMap). Never a reason to read less on its own: a page
      // without one is read whole, as it always was.
      let art = null;
      try { art = await pictureMap(page, viewport); } catch { art = null; }

      const items = await readItems(page, viewport);
      const stitched = root.BlindedBoxes.buildPageText(items);

      pages.push({
        index: n - 1,
        canvas,
        widthPt: base.width,
        heightPt: base.height,
        text: stitched.text,
        items: stitched.items,
        couldHideText,
        art,
      });

      if (onProgress) onProgress(n, doc.numPages);
      // Page resources are not needed again once it is on a canvas, and a
      // long document will otherwise hold every one of them in memory.
      page.cleanup();
    }

    await doc.destroy();
    return pages;
  }

  root.BlindedPdfRead = { load, readItems, RENDER_SCALE,
                          NEED_PASSWORD, WRONG_PASSWORD };
})(typeof window !== 'undefined' ? window : globalThis);
