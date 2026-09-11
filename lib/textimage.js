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

  // The faces to try. Eight, not eighty: each one is a full sweep of the
  // document, and these cover the overwhelming majority of what documents are
  // actually set in — a grotesque and a serif, each regular and bold. Adding
  // more would cost linearly and catch very little.
  // Bold was always here; italic was not, and a slanted word is a different
  // shape rather than the same shape drawn differently. On a real slide the
  // italic "KAG's" in a caption scored 0.386 against these upright faces —
  // indistinguishable from the page around it — and 0.564 once a slanted
  // template was among them, while the upright occurrence on the same page was
  // unaffected at 0.771. Underlining needs nothing: the rule is a separate
  // stroke below the baseline that the letters still dominate.
  //
  // Eight faces is twice the sweep of four, and this is the slow part of the
  // search. It is spent because a word the tool cannot match in italics is a
  // word it silently leaves in the document.
  const FACES = [
    { name: 'sans', weight: '400', style: 'normal', family: 'Helvetica, Arial, sans-serif' },
    { name: 'sans bold', weight: '700', style: 'normal', family: 'Helvetica, Arial, sans-serif' },
    { name: 'sans italic', weight: '400', style: 'italic', family: 'Helvetica, Arial, sans-serif' },
    { name: 'sans bold italic', weight: '700', style: 'italic', family: 'Helvetica, Arial, sans-serif' },
    { name: 'serif', weight: '400', style: 'normal', family: '"Times New Roman", Times, serif' },
    { name: 'serif bold', weight: '700', style: 'normal', family: '"Times New Roman", Times, serif' },
    { name: 'serif italic', weight: '400', style: 'italic', family: '"Times New Roman", Times, serif' },
    { name: 'serif bold italic', weight: '700', style: 'italic', family: '"Times New Roman", Times, serif' },
  ];

  function fontFor(face) {
    // CSS shorthand order: style, then weight, then size and family.
    return (face.style && face.style !== 'normal' ? face.style + ' ' : '')
      + face.weight + ' ' + RENDER_PX + 'px ' + face.family;
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

  // How much of the bar a word earns back for being long.
  //
  // Measured on three real documents. A short word resembles a great deal of
  // a page and a long one resembles much less, but the true scores fall with
  // length as well, so the bar has to come down with them or long words are
  // never found:
  //
  //   "KAG"          3 glyphs   true 0.679-0.799   best false 0.554
  //   "proprietary"  11 glyphs  true 0.639         best false 0.587
  //
  // One bar cannot serve both: 0.65 admits every true KAG and rejects the
  // 0.644 that a four-letter acronym threw up on another deck, but it misses
  // "proprietary" at 0.639. Sliding it down with length fits all three.
  //
  // Nothing is granted to a term with a space in it. A phrase is matched as
  // one picture, and the space in the template is rarely the width of the
  // space in the document, so the second word lands misaligned and drags the
  // correlation down across the whole thing: "proprietary innovation" scores
  // 0.455 where it genuinely appears, below four things on the page that are
  // not it. Relief there would admit those four and still miss the real one.
  const RELIEF_FROM = 4;
  const RELIEF_PER_GLYPH = 0.008;
  const RELIEF_MAX = 0.08;

  function shapeRelief(text) {
    const word = String(text || '').trim();
    if (!word || /\s/.test(word)) return 0;
    const glyphs = word.length;
    if (glyphs <= RELIEF_FROM) return 0;
    return Math.min(RELIEF_MAX, (glyphs - RELIEF_FROM) * RELIEF_PER_GLYPH);
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

  // The faces worth drawing when the search is a targeted fallback rather than
  // a sweep of the whole document.
  //
  // Measured on two real decks: one upright face and one slanted face between
  // them found every true occurrence there was — an acronym on a coloured
  // badge at 0.81, four upright occurrences of a name, and two italic ones.
  // Dropping to a single face is not safe: all four upright faces miss the
  // italic captions outright, scoring nothing at all, so a lone upright
  // template would silently lose exactly the case OCR is most likely to have
  // fumbled. Two is the floor the measurements support, and it is a quarter of
  // the work of eight.
  const FALLBACK_FACES = FACES.filter(f =>
    f.family.indexOf('Helvetica') === 0 && f.weight === '400');

  root.BlindedTextImage = {
    renderTerm, templatesFor, fontFor, shapeRelief, FACES, FALLBACK_FACES, RENDER_PX,
    RELIEF_FROM, RELIEF_PER_GLYPH, RELIEF_MAX,
  };
})(typeof window !== 'undefined' ? window : globalThis);
