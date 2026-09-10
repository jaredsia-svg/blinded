// Turns a typed word into pictures of itself, so the image matcher can hunt
// for it where the text layer cannot reach.
//
// A word in a PDF is sometimes not text. It is a logo, a scan, a screenshot, a
// signature block, a chart label baked into a bitmap. The detectors and the
// terms box both read the text layer, so all of those are invisible to them —
// and a document can look thoroughly redacted while the same name sits in an
// image three pages later.
//
// The matcher in lib/match.js can already find any picture anywhere. What was
// missing was a picture to give it. This renders the typed word at a large
// size in several typefaces and hands each one over as a template.
//
// What this is NOT, and the README says so in the same words: it is not OCR.
// It finds the word drawn in something close to one of the faces below. A
// stylised logotype, an unusual face, letter-spaced capitals, anything curved
// or rotated — these will be missed. Everything it does find is proposed for
// review like any other match, and a search that finds nothing says so. Treat
// it as a second pair of eyes, never as a guarantee.
(function (root) {
  'use strict';

  const Match = root.BlindedMatch;

  // Rendered large, because the matcher scales the page to the template rather
  // than the other way round: a big template downsampled to the working size
  // carries cleaner letterforms than a small one does.
  const RENDER_PX = 72;

  // The faces to try. Four, not forty: each one is a full sweep of the
  // document, and these cover the overwhelming majority of what documents are
  // actually set in — a grotesque and a serif, each regular and bold. Adding
  // more would cost linearly and catch very little.
  const FACES = [
    { name: 'sans', weight: '400', family: 'Helvetica, Arial, sans-serif' },
    { name: 'sans bold', weight: '700', family: 'Helvetica, Arial, sans-serif' },
    { name: 'serif', weight: '400', family: '"Times New Roman", Times, serif' },
    { name: 'serif bold', weight: '700', family: '"Times New Roman", Times, serif' },
  ];

  function fontFor(face) {
    return face.weight + ' ' + RENDER_PX + 'px ' + face.family;
  }

  // Draws one word in one face and returns it as a greyscale template,
  // trimmed to its ink so the matcher's scale ladder is measured against the
  // letterforms rather than against whatever padding was used.
  function renderTerm(text, face) {
    const word = String(text || '').trim();
    if (!word) return null;

    const measure = document.createElement('canvas').getContext('2d');
    measure.font = fontFor(face);
    const width = Math.ceil(measure.measureText(word).width) + RENDER_PX;
    const height = Math.ceil(RENDER_PX * 1.8);
    if (width < 8 || height < 8) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.font = fontFor(face);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(word, width / 2, height / 2);

    const data = ctx.getImageData(0, 0, width, height).data;
    const gray = Match.toGray(data, width, height);
    const box = Match.trimToContent(gray, width, height);
    // A word that rendered to nothing — an unsupported script, say — has no
    // ink to trim to and nothing to search for.
    if (box.w < 4 || box.h < 4) return null;

    return {
      gray: Match.crop(gray, width, height, box),
      width: box.w,
      height: box.h,
      face: face.name,
      text: word,
    };
  }

  // Every face for one word, skipping any that produced nothing.
  function templatesFor(text, faces) {
    const out = [];
    for (const face of faces || FACES) {
      const template = renderTerm(text, face);
      if (template) out.push(template);
    }
    return out;
  }

  root.BlindedTextImage = { renderTerm, templatesFor, fontFor, FACES, RENDER_PX };
})(typeof window !== 'undefined' ? window : globalThis);
