// Writes a fresh PDF whose pages are single flattened images.
//
// This is the whole safety argument of the tool, so it is worth stating
// plainly. The usual way to "redact" a PDF is to draw a black rectangle over
// the text. That is not redaction: the text objects are still in the file, and
// anyone can select, copy, or `pdftotext` them straight back out. Newspapers
// have published documents redacted that way and been read anyway.
//
// So Blinded never edits the input. It rasterises each page to a canvas,
// paints the black boxes onto those pixels, and then builds a *new* PDF from
// the resulting images with this writer. The output has no text objects, no
// fonts, no annotations, no embedded attachments, no JavaScript, no XMP, and
// no document-information dictionary carried over from the original. There is
// nothing underneath the black boxes because there is no underneath.
//
// The cost, which the UI states rather than hides: the output is not
// searchable or selectable, and it is bigger than the original. That trade is
// the point. A redaction you cannot undo is worth more than a text layer.
(function (root) {
  'use strict';

  const encoder = new TextEncoder();
  const ascii = s => encoder.encode(s);

  // A PDF cross-reference table is a list of byte offsets, so the file has to
  // be assembled as bytes while counting them. Chunks accumulate here and are
  // concatenated once at the end.
  function Sink() {
    const chunks = [];
    let length = 0;
    return {
      push(bytes) {
        const b = typeof bytes === 'string' ? ascii(bytes) : bytes;
        chunks.push(b);
        length += b.length;
        return b.length;
      },
      get length() { return length; },
      concat() {
        const out = new Uint8Array(length);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        return out;
      },
    };
  }

  // PDF numbers must not be written in exponential notation, and trailing
  // zeros only make the file bigger.
  function num(n) {
    if (!Number.isFinite(n)) throw new Error('Blinded: refusing to write a non-finite number into a PDF');
    const fixed = n.toFixed(4);
    return fixed.replace(/\.?0+$/, '') || '0';
  }

  // Escapes a literal string for a PDF ( ) string object.
  function litstr(s) {
    return '(' + String(s).replace(/[\\()]/g, m => '\\' + m).replace(/[\r\n]/g, ' ') + ')';
  }

  // Text in the font's own encoding, WinAnsi, as a literal string of bytes.
  //
  // The stream is written as UTF-8, which suited placeholders made of ASCII
  // and garbled anything else: a curly apostrophe came out as three bytes and
  // three wrong characters. Latin-1 maps straight across; the handful WinAnsi
  // keeps in 0x80-0x9F are mapped by name; what the font cannot carry is
  // left out rather than written as something else.
  const WIN_ANSI = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
    0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
    0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
  };
  function winAnsiBytes(text) {
    const out = [];
    for (const ch of String(text).replace(/[\r\n]/g, ' ')) {
      const code = ch.codePointAt(0);
      if (code >= 0x20 && code < 0x7F) out.push(code);
      else if (code >= 0xA0 && code <= 0xFF) out.push(code);
      else if (WIN_ANSI[code]) out.push(WIN_ANSI[code]);
    }
    return out;
  }
  function winAnsiString(text) {
    let s = '(';
    for (const b of winAnsiBytes(text)) {
      if (b === 0x28 || b === 0x29 || b === 0x5C) s += '\\' + String.fromCharCode(b);
      else if (b < 0x80) s += String.fromCharCode(b);
      else s += '\\' + b.toString(8).padStart(3, '0');
    }
    return s + ')';
  }

  // Helvetica's advance widths, in thousandths of the size, for the printable
  // ASCII range; anything else is taken at an average letter.
  const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333,
    278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778,
    722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500,
    556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556,
    500, 722, 500, 500, 500, 334, 260, 334, 584];
  function helveticaWidth(text, size) {
    let units = 0;
    for (const b of winAnsiBytes(text)) units += b >= 0x20 && b < 0x7F ? HELVETICA[b - 0x20] : 556;
    return units * size / 1000;
  }

  // pages: [{ widthPt, heightPt, image: { bytes, width, height, filter } }]
  //   widthPt/heightPt — the page box in points, so the output prints at the
  //     same physical size as the original however densely it was rasterised.
  //   filter — 'DCTDecode' for JPEG bytes, 'FlateDecode' for deflated raw RGB.
  function build(pages, options) {
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error('Blinded: a PDF needs at least one page');
    }
    const opts = options || {};
    const sink = Sink();

    // Object 0 is the free-list head and is never written; offsets[i] is the
    // byte offset of object i.
    const offsets = [0];
    // Any page carrying placeholder text needs a font, and one shared font
    // object serves the whole document.
    const wantsText = pages.some(page => page.labels && page.labels.length);
    // Object ids run 1..4 for the catalog, page tree, info and font, then three
    // per page. The highest id is therefore 4 + 3n, and /Size is one past it —
    // it counts the free-list entry at index 0. Getting this one short leaves
    // the final page's image out of the cross-reference table, which forgiving
    // readers silently repair and strict ones render as a blank page.
    const objectCount = 5 + pages.length * 3;

    const begin = id => { offsets[id] = sink.length; sink.push(id + ' 0 obj\n'); };
    const end = () => sink.push('endobj\n');

    // The %-comment with high bytes is what tells transfer agents the file is
    // binary. Without it some tools will happily mangle the JPEG streams.
    sink.push('%PDF-1.7\n');
    sink.push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    const FONT_ID = 4;
    const pageId = i => 5 + i * 3;
    const contentId = i => 6 + i * 3;
    const imageId = i => 7 + i * 3;

    // 1: catalog
    begin(1);
    sink.push('<< /Type /Catalog /Pages 2 0 R >>\n');
    end();

    // 2: page tree
    begin(2);
    sink.push('<< /Type /Pages /Count ' + pages.length + ' /Kids [' +
      pages.map((_, i) => pageId(i) + ' 0 R').join(' ') + '] >>\n');
    end();

    // 3: document information. Deliberately minimal — this is a new document,
    // and nothing about the original belongs in it. No author, no title, no
    // creation date, because those are exactly the fields that leak.
    begin(3);
    sink.push('<< /Producer ' + litstr(opts.producer || 'Blinded') + ' >>\n');
    end();

    // 4: the one font, a base-14 so nothing has to be embedded. Written even
    // when unused, so object numbering does not depend on the content.
    begin(FONT_ID);
    sink.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
    end();

    pages.forEach((page, i) => {
      const img = page.image;
      const w = num(page.widthPt);
      const h = num(page.heightPt);

      begin(pageId(i));
      sink.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + ']' +
        ' /Resources << /XObject << /Im0 ' + imageId(i) + ' 0 R >>' +
        ' /Font << /F1 ' + FONT_ID + ' 0 R >> /ProcSet [/PDF /ImageC /Text] >>' +
        ' /Contents ' + contentId(i) + ' 0 R >>\n');
      end();

      // Scale the unit image square up to the page box and draw it once.
      let stream = 'q\n' + w + ' 0 0 ' + h + ' 0 0 cm\n/Im0 Do\nQ\n';

      // Placeholder labels, as invisible text sitting exactly over the labels
      // already burned into the image.
      //
      // Text render mode 3 draws nothing, which is the whole point: the reader
      // sees the white label painted into the black bar, and anything
      // extracting text — pdftotext, a search index, a model reading the file
      // rather than looking at it — gets the same label as real characters.
      // The two never disagree because they come from one list.
      //
      // What is in this layer is decided before it gets here: the placeholders,
      // and when the reviewer asks for searchable text, the words that can be
      // seen on the finished page (app.js, keptTextFor). This writes what it
      // is given and nothing else. tools/selftest.mjs holds that by searching
      // the finished bytes for the secrets in the fixture.
      //
      // A label may also say how wide it should run and at what angle: the
      // words kept from the original page are written over their own pictures,
      // stretched to the width they take there, so that selecting a line of
      // the finished page selects that line.
      if (page.labels && page.labels.length) {
        stream += 'BT\n3 Tr\n';
        for (const label of page.labels) {
          const size = Math.max(1, label.size || 8);
          const text = winAnsiString(label.text);
          if (text === '()') continue;
          const angle = label.angle || 0;
          const cos = Math.cos(angle), sin = Math.sin(angle);
          const natural = helveticaWidth(label.text, size);
          const stretch = label.width > 0 && natural > 0
            ? Math.min(1000, Math.max(10, 100 * label.width / natural)) : 100;
          stream += '/F1 ' + num(size) + ' Tf\n'
            + num(stretch) + ' Tz\n'
            + num(cos) + ' ' + num(sin) + ' ' + num(-sin) + ' ' + num(cos) + ' '
            + num(label.x) + ' ' + num(label.y) + ' Tm\n'
            + text + ' Tj\n';
        }
        stream += '100 Tz\nET\n';
      }
      begin(contentId(i));
      sink.push('<< /Length ' + ascii(stream).length + ' >>\nstream\n');
      sink.push(stream);
      sink.push('endstream\n');
      end();

      begin(imageId(i));
      sink.push('<< /Type /XObject /Subtype /Image' +
        ' /Width ' + img.width + ' /Height ' + img.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8' +
        ' /Filter /' + img.filter +
        ' /Length ' + img.bytes.length + ' >>\nstream\n');
      sink.push(img.bytes);
      sink.push('\nendstream\n');
      end();
    });

    // Cross-reference table. Entries are fixed at 20 bytes each, which is why
    // the offset is zero-padded to ten digits and the line ends with " \n".
    const xrefAt = sink.length;
    sink.push('xref\n0 ' + objectCount + '\n');
    sink.push('0000000000 65535 f \n');
    for (let id = 1; id < objectCount; id++) {
      sink.push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
    }

    sink.push('trailer\n<< /Size ' + objectCount + ' /Root 1 0 R /Info 3 0 R >>\n');
    sink.push('startxref\n' + xrefAt + '\n%%EOF\n');

    return sink.concat();
  }

  root.BlindedPdfWrite = {
    winAnsiBytes, helveticaWidth, build, num, litstr };
})(typeof window !== 'undefined' ? window : globalThis);
