// Burns boxes into pixels and encodes the result.
//
// The one function that must never be "optimised" into drawing onto the
// displayed canvas: redaction happens on a copy of the source bitmap, and the
// encoded bytes come from that copy. The preview canvas carries selection
// handles, hover states and a dashed outline, none of which belong in the
// output, and a reviewer who saw a dashed box in their exported PDF would
// rightly stop trusting the rest of it.
(function (root) {
  'use strict';

  // Paints filled rectangles onto a fresh canvas of the same size and returns
  // it. `boxes` are in the source canvas's pixel coordinates.
  function flatten(source, boxes, texts) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0);

    ctx.fillStyle = '#000000';
    const painted = [];
    for (const box of boxes) {
      // Round outward. A box rounded inward can leave a half-lit pixel column
      // at the edge of a glyph, which is faint but not nothing.
      const x = Math.floor(box.x);
      const y = Math.floor(box.y);
      const w = Math.ceil(box.x + box.w) - x;
      const h = Math.ceil(box.y + box.h) - y;
      ctx.fillRect(x, y, Math.max(1, w), Math.max(1, h));
      painted.push({ x, y, w: Math.max(1, w), h: Math.max(1, h), label: box.label });
    }

    // Labels go on last, over every bar, so one box overlapping another cannot
    // paint out a label that was already written.
    for (const box of painted) {
      if (box.label) drawLabel(ctx, box, box.label);
    }
    // And the reviewer's own writing over everything, including the bars: a
    // note saying what was covered is most useful sitting on the thing that
    // covered it.
    drawTexts(ctx, texts || []);
    return canvas;
  }

  // ---------- text the reviewer added ----------
  //
  // One function draws these, and both the page on screen and the flattened
  // export call it. That is the whole reason it lives here rather than in the
  // app: a note that wrapped onto two lines in the preview and three in the
  // finished PDF would push a word off the bottom of the box, and the only
  // way to be sure that cannot happen is for there to be one piece of code
  // that decides where the words go.
  //
  // A stack the browser and the canvas both resolve the same way, since the
  // editing overlay is laid out by CSS and the finished text is measured here.
  const TEXT_FONT = 'Helvetica, Arial, "Helvetica Neue", sans-serif';
  const TEXT_LINE = 1.3;

  function fontFor(item) {
    return Math.max(1, item.size) + 'px ' + TEXT_FONT;
  }

  // Breaks a note into lines that fit the box's width. Long words that do not
  // fit on a line of their own are left to overhang rather than chopped: a
  // truncated word in a redacted document reads as damage.
  function wrapText(ctx, text, width) {
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = words[0];
      for (const word of words.slice(1)) {
        const next = line + ' ' + word;
        if (ctx.measureText(next).width <= width) line = next;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }

  // A scratch context for measuring outside a paint — the overlay needs to
  // know how tall a note is before anything is drawn.
  let ruler = null;
  function measuring() {
    if (!ruler) ruler = document.createElement('canvas').getContext('2d');
    return ruler;
  }

  // How much room a note takes: its own width, and the height of however many
  // lines it wrapped onto.
  function textBox(item) {
    const ctx = measuring();
    ctx.font = fontFor(item);
    const lines = wrapText(ctx, item.text || '', item.w);
    return { x: item.x, y: item.y, w: item.w,
             h: Math.max(1, lines.length) * item.size * TEXT_LINE, lines: lines.length };
  }

  function drawTexts(ctx, texts) {
    for (const item of texts) {
      if (!item || !item.text) continue;
      ctx.save();
      ctx.font = fontFor(item);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = item.colour || '#000000';
      const lines = wrapText(ctx, item.text, item.w);
      lines.forEach((line, i) => {
        // The baseline sits within the line box, not on top of it, or the
        // first line is drawn above the box the reviewer placed.
        const baseline = item.y + (i + 0.79) * item.size * TEXT_LINE;
        ctx.fillText(line, item.x, baseline);
      });
      ctx.restore();
    }
  }

  // The smallest legible label. Below this the text is a grey smudge that
  // makes the bar look damaged rather than annotated, so nothing is drawn and
  // the legend carries the meaning instead.
  const MIN_LABEL_PX = 7;

  // Writes a placeholder into a bar, in white, as large as will fit.
  //
  // Fitting rather than picking a size matters because bars are the size of
  // whatever they cover: a bar over a postcode is a few characters wide and a
  // bar over a letterhead is half a page. Returns whether it managed to draw.
  function drawLabel(ctx, box, label) {
    const text = '[' + label + ']';
    // Leave a margin so the text does not touch the edge of the bar, where it
    // reads as clipped.
    const room = { w: box.w * 0.92, h: box.h * 0.78 };

    let size = Math.min(room.h, box.w);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Shrink until it fits the width. Measured rather than estimated: label
    // lengths vary from [SSN_1] to [DATE_OF_BIRTH_12].
    while (size >= MIN_LABEL_PX) {
      ctx.font = '600 ' + size + 'px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      if (ctx.measureText(text).width <= room.w) break;
      size -= 1;
    }

    if (size < MIN_LABEL_PX) {
      ctx.restore();
      return false;
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, box.x + box.w / 2, box.y + box.h / 2);
    ctx.restore();
    return true;
  }

  // Draws the legend as a page image, so it can be appended to the export
  // without the output gaining any text objects.
  //
  // Carries labels and what kind of thing each stands for — never the original
  // values. A legend printed inside a redacted document that mapped
  // [PERSON_1] back to a name would undo the entire redaction, which is why
  // that mapping lives in a separate file the reviewer downloads deliberately.
  function legendCanvas(entries, options) {
    const opts = options || {};
    const width = opts.width || 1224;
    const height = opts.height || 1584;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    // Every line is recorded as it is drawn, so the legend can be added to the
    // machine-readable layer too rather than being a picture of a list.
    const lines = [];

    const unit = width / 612;
    const margin = 64 * unit;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'alphabetic';

    let y = margin + 18 * unit;
    ctx.font = '600 ' + Math.round(17 * unit) + 'px ' +
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.fillText('Redaction legend', margin, y);
    lines.push({ text: 'Redaction legend', x: margin, y, size: 17 * unit });

    y += 22 * unit;
    ctx.font = Math.round(10.5 * unit) + 'px ' +
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#444444';
    const preamble = 'Each placeholder below replaces content removed from this document. '
      + 'The same placeholder always stands for the same thing. '
      + 'This page does not record what any of them were.';
    for (const line of wrap(ctx, preamble, width - margin * 2)) {
      ctx.fillText(line, margin, y);
      lines.push({ text: line, x: margin, y, size: 10.5 * unit });
      y += 15 * unit;
    }

    y += 12 * unit;
    const rows = [];
    for (const entry of entries) {
      const labelFont = '600 ' + Math.round(11 * unit) + 'px ui-monospace, Menlo, Consolas, monospace';
      const proseFont = Math.round(11 * unit) + 'px '
        + '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
      rows.push({ entry, labelFont, proseFont });
    }

    for (const row of rows) {
      if (y > height - margin) break;
      ctx.fillStyle = '#000000';
      ctx.font = row.labelFont;
      const tag = '[' + row.entry.label + ']';
      ctx.fillText(tag, margin, y);
      const tagWidth = Math.max(ctx.measureText(tag).width + 12 * unit, 150 * unit);

      ctx.fillStyle = '#444444';
      ctx.font = row.proseFont;
      const times = row.entry.count === 1 ? 'once' : row.entry.count + ' times';
      const prose = row.entry.description + ' — appears ' + times;
      ctx.fillText(prose, margin + tagWidth, y);
      lines.push({ text: tag + '  ' + prose, x: margin, y, size: 11 * unit });
      y += 19 * unit;
    }

    return { canvas, lines };
  }

  function wrap(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Blinded: the browser could not encode a page image'));
      }, type, quality);
    });
  }

  // Encodes a canvas as the image a PDF can embed directly.
  //
  // JPEG goes in as DCTDecode with no re-encoding. Lossless goes in as raw RGB
  // through FlateDecode, which means deflating it here — bigger files, but no
  // compression artefacts around small text, which matters for a document
  // someone may need to read as evidence.
  async function encodeForPdf(canvas, lossless, quality) {
    if (!lossless) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality === undefined ? 0.92 : quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { bytes, width: canvas.width, height: canvas.height, filter: 'DCTDecode' };
    }

    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // PDF's DeviceRGB wants three channels; the canvas gives four.
    const rgb = new Uint8Array(canvas.width * canvas.height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    return {
      bytes: await deflate(rgb),
      width: canvas.width,
      height: canvas.height,
      filter: 'FlateDecode',
    };
  }

  // CompressionStream('deflate') emits a zlib stream, which is exactly what
  // PDF's FlateDecode expects.
  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') {
      throw new Error('Blinded: this browser cannot produce lossless output — switch the quality setting to JPEG');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  root.BlindedRender = { flatten, drawLabel, legendCanvas, encodeForPdf, canvasToBlob, deflate,
    drawTexts, wrapText, textBox, TEXT_FONT, TEXT_LINE, MIN_LABEL_PX };
})(typeof window !== 'undefined' ? window : globalThis);
