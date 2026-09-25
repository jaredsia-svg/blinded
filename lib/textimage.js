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
  // The typefaces, bundled rather than borrowed from the machine.
  //
  // "Helvetica, Arial" meant whatever the machine had: real Helvetica on a
  // Mac, Arial on Windows, Liberation Sans on Linux -- three different sets of
  // letterforms for the same template, so the second check found different
  // things on different computers. Arimo and Tinos are drawn to Arial's and
  // Times New Roman's exact metrics (Liberation is built from them), and are
  // the same file everywhere. Arial is what the documents this was measured
  // on are overwhelmingly set in -- more than eighty percent of their text,
  // against a few characters of Calibri -- which is why these two and not a
  // Calibri stand-in: a third face would be half as much again on the check,
  // for a font that barely appears.
  //
  // The system names stay behind them in each list, so a font that did not
  // load draws in what it used to.
  const SANS = '"Blinded Arimo", Helvetica, Arial, sans-serif';
  const SERIF = '"Blinded Tinos", "Times New Roman", Times, serif';
  const FONT_FILES = [
    ['Blinded Arimo', 'arimo', '400', 'normal'], ['Blinded Arimo', 'arimo', '700', 'normal'],
    ['Blinded Arimo', 'arimo', '400', 'italic'], ['Blinded Arimo', 'arimo', '700', 'italic'],
    ['Blinded Tinos', 'tinos', '400', 'normal'], ['Blinded Tinos', 'tinos', '700', 'normal'],
    ['Blinded Tinos', 'tinos', '400', 'italic'], ['Blinded Tinos', 'tinos', '700', 'italic'],
  ];
  // Resolved while this script runs, because currentScript means nothing later.
  const FONT_BASE = (typeof document !== 'undefined' && document.currentScript)
    ? new URL('../vendor/fonts/', document.currentScript.src).href : null;
  let fontsReady = null;
  let fontsSettled = false;

  // Loads the faces once, and resolves whether they loaded or not: a template
  // drawn in the fallback face is the old behaviour, not a failure.
  function ready() {
    if (fontsReady) return fontsReady;
    if (!FONT_BASE || typeof FontFace === 'undefined' || !document.fonts) {
      fontsReady = Promise.resolve(false);
      fontsSettled = true;
      return fontsReady;
    }
    fontsReady = Promise.all(FONT_FILES.map(([family, file, weight, style]) => {
      const face = new FontFace(family,
        'url(' + FONT_BASE + file + '-latin-' + weight + '-' + style + '.woff2) format("woff2")',
        { weight, style });
      return face.load().then(loaded => { document.fonts.add(loaded); return true; })
        .catch(() => false);
    })).then(all => all.every(Boolean)).finally(() => { fontsSettled = true; });
    return fontsReady;
  }
  // Whether the faces have finished loading (or failed to), so a caller that
  // must start in this moment -- the check shows its bar the instant it is
  // asked for -- need not wait a turn for a promise that has already settled.
  function settled() { return fontsSettled; }

  const FACES = [
    { name: 'sans', weight: '400', style: 'normal', family: SANS },
    { name: 'sans bold', weight: '700', style: 'normal', family: SANS },
    { name: 'sans italic', weight: '400', style: 'italic', family: SANS },
    { name: 'sans bold italic', weight: '700', style: 'italic', family: SANS },
    { name: 'serif', weight: '400', style: 'normal', family: SERIF },
    { name: 'serif bold', weight: '700', style: 'normal', family: SERIF },
    { name: 'serif italic', weight: '400', style: 'italic', family: SERIF },
    { name: 'serif bold italic', weight: '700', style: 'italic', family: SERIF },
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
  const FALLBACK_FACES = FACES.filter(f => f.family === SANS && f.weight === '400');

  // The two faces the whole-document sweep draws.
  //
  // Two rather than eight because the sweep is a second opinion on work the
  // reader has already done well, and eight was four times the cost for it —
  // 96 pages of one word went from 271 seconds to 67.
  //
  // Bold rather than regular, which is not obvious and was measured. Searching
  // a rendered PDF of ordinary Helvetica text for "Parkway", face by face:
  // sans bold scored 0.83 and sans bold italic 0.74, both over the bar, while
  // sans regular managed 0.56 and sans italic 0.33 against a threshold of
  // 0.636 — so the regular-weight pair, which is what the targeted fallback
  // used, would have found nothing at all. Ink thickens when a page is
  // rasterised and then resampled for the coarse pass, and a heavier template
  // is closer to what the matcher actually sees. One upright and one slanted,
  // because a single upright face misses italic captions outright.
  const SWEEP_FACES = FACES.filter(f => f.family === SANS && f.weight === '700');


  const PHRASE_STOP = new Set(['and', 'or', 'of', 'the', 'a', 'an', '&', '+']);

  // Content words of a typed phrase for the second check's per-word sweeps.
  function phraseContentParts(term) {
    return String(term || '').trim().split(/\s+/)
      .filter(w => w && !PHRASE_STOP.has(w.toLowerCase()) && /[A-Za-z0-9]/.test(w));
  }

  root.BlindedTextImage = {
    renderTerm, templatesFor, fontFor, shapeRelief, phraseContentParts, FACES, FALLBACK_FACES, ready, settled,
    SWEEP_FACES, RENDER_PX,
    RELIEF_FROM, RELIEF_PER_GLYPH, RELIEF_MAX,
  };
})(typeof window !== 'undefined' ? window : globalThis);
