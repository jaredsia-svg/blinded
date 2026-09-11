// Unit pass over everything that does not need a browser.
//
// The browser-side modules are written as classic scripts attached to a global
// so that they can be loaded here without a bundler, the same way the page
// loads them. tools/uitest.mjs covers the parts that need a real canvas.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

import { buildTextPdf, buildTrackedPdf, FIXTURE_LINES } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) passed++;
  else failures.push(label + (detail === undefined ? '' : ' — ' + detail));
};

for (const file of ['schedule.js', 'detect.js', 'boxes.js', 'pdfwrite.js', 'match.js', 'imagesearch.js', 'labels.js']) {
  runInThisContext(readFileSync(join(root, 'lib', file), 'utf8'), { filename: file });
}
const Detect = globalThis.BlindedDetect;
const Boxes = globalThis.BlindedBoxes;
const PdfWrite = globalThis.BlindedPdfWrite;
const Match = globalThis.BlindedMatch;
const ImageSearch = globalThis.BlindedImageSearch;
const Labels = globalThis.BlindedLabels;
const Schedule = globalThis.BlindedSchedule;

// ---------- checksums ----------

check('luhn accepts a real card', Detect.luhnValid('4242424242424242'));
check('luhn accepts amex length', Detect.luhnValid('378282246310005'));
check('luhn rejects a transposition', !Detect.luhnValid('4242424242424252'));
check('luhn rejects repeated digits', !Detect.luhnValid('4444444444444444'));
check('luhn rejects a short number', !Detect.luhnValid('42424242'));
check('iban accepts a valid GB number', Detect.ibanValid('GB82 WEST 1234 5698 7654 32'));
check('iban rejects a bad check digit', !Detect.ibanValid('GB83 WEST 1234 5698 7654 32'));
check('mod97 of a known value', Detect.mod97('3214282912345698765432161182') === 1);

// ---------- detectors ----------

const kindsIn = (text, options) => Detect.findAll(text, options).map(f => f.kind);
const textsOf = (text, kind, options) =>
  Detect.findAll(text, options).filter(f => f.kind === kind).map(f => f.text);

check('finds an email', kindsIn('write to a.b+c@sub.example.co.uk now').includes('email'));
check('email keeps its whole domain',
  textsOf('write to a.b+c@sub.example.co.uk now', 'email')[0] === 'a.b+c@sub.example.co.uk');

for (const phone of ['(415) 555-0132', '415-555-0132', '415.555.0132', '+44 20 7946 0958', '+1 (415) 555-0132']) {
  check('finds phone ' + phone, kindsIn('call ' + phone + ' today').includes('phone'), phone);
}
// findAll reports everything it finds and labels how sure it is; the caller
// decides what to act on. These two assert the label, not the filtering.
check('a bare ten-digit run is reported at medium confidence', (() => {
  const found = Detect.findAll('call 415 555 0132').filter(f => f.kind === 'phone');
  return found.length === 1 && found[0].confidence === 'medium';
})());
check('a separated number is reported at high confidence', (() => {
  const found = Detect.findAll('call 415-555-0132').filter(f => f.kind === 'phone');
  return found.length === 1 && found[0].confidence === 'high';
})());

check('finds a Luhn-valid card', kindsIn('card 4242 4242 4242 4242 ok').includes('card'));
check('ignores a sixteen-digit non-card', !kindsIn('ref 1234 5678 9012 3456 ok').includes('card'));
// The US Social Security detector was removed: it is one country's identifier
// in a tool that is not otherwise US-specific, and a nine-digit rule earns its
// keep only where those numbers actually appear. Anyone who needs them can
// type the number into the terms box like any other string.
check('no detector claims to find Social Security numbers',
  !Detect.DETECTORS.some(d => d.kind === 'ssn'),
  Detect.DETECTORS.map(d => d.kind).join(', '));
check('and a Social Security number is no longer picked up on its own',
  Detect.findAll('ssn 123-45-6789').length === 0,
  JSON.stringify(Detect.findAll('ssn 123-45-6789').map(s => s.kind)));
check('while a typed term still covers one for anyone who wants it',
  Detect.findAll('ssn 123-45-6789', { terms: ['123-45-6789'] }).length === 1);
check('finds an IPv4 address', kindsIn('host 192.168.1.44 up').includes('ip'));
check('rejects an out-of-range dotted quad', !kindsIn('build 999.1.1.1 failed').includes('ip'));
check('finds a URL', kindsIn('see https://example.com/a?token=abc for more').includes('url'));
check('a URL drops the sentence full stop',
  textsOf('see https://example.com/a.', 'url')[0] === 'https://example.com/a');
check('finds a street address', kindsIn('at 1600 Amphitheatre Parkway today').includes('address'));
check('finds a labelled date of birth', kindsIn('DOB: 04/11/1979').includes('dob'));
check('ignores an unlabelled date', !kindsIn('shipped 04/11/1979').includes('dob'));

// ---------- terms ----------

check('matches a listed term', textsOf('Jane spoke to jane', 'term', { terms: ['Jane'] }).length === 2);
check('term matching is case-insensitive',
  textsOf('JANE spoke', 'term', { terms: ['jane'] })[0] === 'JANE');
check('a term does not match inside a longer word',
  Detect.findAll('Janet spoke', { terms: ['Jane'] }).length === 0);
check('the longer of two overlapping terms wins',
  textsOf('Jane Doe called', 'term', { terms: ['Jane', 'Jane Doe'] })[0] === 'Jane Doe');
check('a term with punctuation still matches',
  textsOf('ref #A-1/22 here', 'term', { terms: ['#A-1/22'] }).length === 1);

// A PDF is free to draw a word as separately positioned glyphs, and a heading
// set with letter-spacing arrives from pdf.js as the items "K", " ", "A",
// " ", "G" — those spaces are pdf.js's rendering of the gaps, not characters
// in the document. Matching the term literally found the word everywhere it
// was set plainly and missed it wherever a designer had styled it: the least
// helpful possible failure, and a silent one.
check('a term still matches when the document tracked its letters apart',
  textsOf('K A G ’s value', 'term', { terms: ['KAG'] })[0] === 'K A G');
check('and the match spans the gaps, so the box covers the whole word',
  (textsOf('K A G ’s value', 'term', { terms: ['KAG'] })[0] || '').length === 5);
check('wider tracking is matched too',
  textsOf('K   A   G here', 'term', { terms: ['KAG'] }).length === 1);
check('a tracked term is matched across a line break',
  textsOf('K\nA\nG here', 'term', { terms: ['KAG'] }).length === 1);
check('a term containing a space still requires one',
  Detect.findAll('JaneDoe signed', { terms: ['Jane Doe'] }).length === 0);
check('but tolerates a document that spaced that name out as well',
  textsOf('J a n e  D o e signed', 'term', { terms: ['Jane Doe'] }).length === 1);
// Only whitespace may separate the letters, and the ends still have to be
// word boundaries — otherwise "KAG" would swallow half the dictionary.
check('tolerating whitespace does not weaken the leading boundary',
  Detect.findAll('MyKAG value', { terms: ['KAG'] }).length === 0);
check('nor match a longer word that merely starts the same way',
  Detect.findAll('KAGS differs', { terms: ['KAG'] }).length === 0);
check('letters separated by other words are not a match',
  Detect.findAll('a K then A then G', { terms: ['KAG'] }).length === 0);
check('the pattern demands a space where the term has one',
  Detect.termPattern('Jane Doe').includes('\\s+'));
check('and permits an optional one between letters',
  Detect.termPattern('KAG') === 'K\\s*A\\s*G', Detect.termPattern('KAG'));

// ---------- overlap ----------

const overlapped = Detect.findAll('mail me at bob@example.com or https://x.co/bob@example.com');
check('overlapping findings collapse to one span each',
  overlapped.every((f, i) => i === 0 || f.start >= overlapped[i - 1].end),
  JSON.stringify(overlapped.map(f => [f.kind, f.start, f.end])));

// ---------- applying to text ----------

const sample = 'Call Jane on (415) 555-0132.';
const spans = Detect.findAll(sample, { terms: ['Jane'] });
const blocked = Detect.applyToText(sample, spans, 'block');
check('block redaction removes the original text',
  !blocked.includes('Jane') && !blocked.includes('555-0132'), blocked);
check('block redaction preserves length', blocked.length === sample.length, blocked);
check('label redaction names the kind',
  Detect.applyToText(sample, spans, 'label').includes('[PHONE]'));
check('remove redaction deletes outright',
  Detect.applyToText(sample, spans, 'remove') === 'Call  on .');

// ---------- geometry ----------

const items = [
  { str: 'Jane', x: 10, y: 100, w: 40, h: 10, hasEOL: false },
  { str: 'Doe', x: 56, y: 100, w: 30, h: 10, hasEOL: true },
  { str: 'and Sam Roe', x: 10, y: 120, w: 99, h: 10, hasEOL: false },
];
const stitched = Boxes.buildPageText(items);
check('stitching inserts a space across a gap', stitched.text.startsWith('Jane Doe'), stitched.text);
check('stitching breaks the line at hasEOL', stitched.text.includes('Doe\nand'), stitched.text);
check('placed items carry their offsets',
  stitched.items[2].start === stitched.text.indexOf('and Sam Roe'));

const nameSpan = { start: 0, end: 8 };
const oneLine = Boxes.boxesForSpans(stitched.items, [nameSpan]);
check('a name split across two items becomes one box', oneLine.length === 1, JSON.stringify(oneLine));
check('the box starts left of the text', oneLine[0].x < 10);
check('the box ends right of the text', oneLine[0].x + oneLine[0].w > 86);
// Helvetica's cap height is about 0.72em and its descenders reach about
// 0.21em below the baseline. The box has to clear both, or it shaves the top
// off a capital or leaves the tail of a 'y' showing.
check('the box clears cap height above the baseline', oneLine[0].y <= 100 - 10 * 0.72,
  String(oneLine[0].y));
check('the box clears the descenders below the baseline',
  oneLine[0].y + oneLine[0].h >= 100 + 10 * 0.21,
  String(oneLine[0].y + oneLine[0].h));

const twoLines = Boxes.boxesForSpans(stitched.items, [nameSpan, { start: 17, end: 24 }]);
check('separate lines stay separate boxes', twoLines.length === 2, JSON.stringify(twoLines));

check('a partial item is only partly covered',
  Boxes.sliceRect(stitched.items[2], stitched.items[2].start, stitched.items[2].start + 3).w < 99);
check('merging joins touching rectangles on one line',
  Boxes.mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 0, w: 10, h: 10 }]).length === 1);
check('merging leaves distant rectangles alone',
  Boxes.mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 40, y: 0, w: 10, h: 10 }]).length === 2);
check('merging closes a gap the size of a space',
  Boxes.mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 14, y: 0, w: 10, h: 10 }], 6).length === 1);
check('merging never joins boxes on different lines',
  Boxes.mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 40, w: 10, h: 10 }], 20).length === 2);
// The slab bug: two boxes that overlap vertically by a sliver are adjacent
// lines, not one line, and must not become a single block.
check('boxes that only graze vertically stay separate',
  Boxes.mergeRects([{ x: 0, y: 0, w: 100, h: 10 }, { x: 0, y: 9, w: 100, h: 10 }]).length === 2);
check('a redaction stays inside its own line', (() => {
  // Three lines at realistic 13pt-on-14pt leading, rendered at 2x.
  const lines = [0, 1, 2].map(n => ({ str: 'secret text here', x: 80, y: 100 + n * 28, w: 200, h: 26, hasEOL: true }));
  const page = Boxes.buildPageText(lines);
  const boxes = Boxes.boxesForSpans(page.items, [{ start: page.items[1].start, end: page.items[1].end }]);
  if (boxes.length !== 1) return false;
  const top = page.items[0].y, bottom = page.items[2].y;
  return boxes[0].y > top && boxes[0].y + boxes[0].h < bottom;
})());
check('hit testing finds the top rectangle',
  Boxes.rectAt([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }], 7, 7) === 1);
check('hit testing misses outside', Boxes.rectAt([{ x: 0, y: 0, w: 10, h: 10 }], 40, 40) === -1);
check('a drag normalises to positive extents', (() => {
  const r = Boxes.rectFromDrag(30, 40, 10, 10);
  return r.x === 10 && r.y === 10 && r.w === 20 && r.h === 30;
})());

// ---------- matching an image ----------
//
// A synthetic page with a known mark stamped into it at known places, so the
// matcher can be held to finding exactly those and nothing else.

function blankPage(w, h, level) {
  const page = new Float32Array(w * h).fill(level === undefined ? 210 : level);
  return page;
}

// An asymmetric glyph: a bar across the top, a diagonal, and a stroke down the
// right edge. `gain` fades it towards mid grey, standing in for a lighter
// print or a washed-out scan.
//
// Deliberately not a checkerboard, which was the first thing tried here. A
// periodic pattern correlates with a shifted copy of itself — shift a
// checkerboard by two and it *is* its own inverse — so the inversion test
// below passed against a neighbouring offset and proved nothing about the
// matcher. A logo worth redacting has no such symmetry, and neither does this.
function markPixel(x, y, size) {
  const bar = y < size / 4 && x < size * 0.7;
  const diagonal = Math.abs(x - y) < 2;
  const edge = x > size - 3 && y > size / 3;
  return bar || diagonal || edge;
}

function stamp(page, pw, x0, y0, size, gain) {
  const g = gain === undefined ? 1 : gain;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = markPixel(x, y, size) ? 30 : 235;
      page[(y0 + y) * pw + x0 + x] = v * g + (1 - g) * 128;
    }
  }
}

function markTemplate(size) {
  const t = new Float32Array(size * size);
  stamp(t, size, 0, 0, size, 1);
  return Match.prepareTemplate(t, size, size);
}

{
  const W = 160, H = 120, S = 16;
  const page = blankPage(W, H);
  stamp(page, W, 10, 10, S, 1);
  stamp(page, W, 100, 20, S, 1);
  stamp(page, W, 60, 90, S, 0.45);   // same mark, much fainter
  const tpl = markTemplate(S);

  const raw = Match.correlate(page, W, H, tpl);
  const hits = Match.suppress(raw);
  check('a mark stamped three times is found three times', hits.length === 3,
    hits.length + ' found');
  // At the default threshold a mark also scores above the bar one pixel off
  // centre, so the raw count exceeds the number of marks. That is what
  // suppression is for, and the check above already pins the result at three.
  check('near-miss positions around each mark also clear the threshold',
    raw.length > 3 && raw.length <= 3 * 6, raw.length + ' raw positions');

  // Suppression earns its place at looser thresholds and across the scale
  // sweep, where each mark does come back as a cluster of near-misses around
  // the true position. Forced here rather than assumed.
  const loose = Match.correlate(page, W, H, tpl, { threshold: 0.45 });
  const collapsed = Match.suppress(loose);
  check('a looser threshold does produce a cluster around each mark',
    loose.length > 3, loose.length + ' raw positions at 0.45');
  check('and suppression collapses those clusters',
    collapsed.length < loose.length, loose.length + ' -> ' + collapsed.length);
  check('every real mark survives suppression',
    [[10, 10], [100, 20], [60, 90]].every(([x, y]) =>
      collapsed.some(h => Math.abs(h.x - x) <= 1 && Math.abs(h.y - y) <= 1)),
    JSON.stringify(collapsed.map(h => [h.x, h.y])));
  // Suppression merges boxes that overlap; it cannot know that a box which
  // overlaps nothing is wrong. A threshold loose enough to admit a false
  // positive somewhere else on the page keeps it, which is the whole reason
  // the sensitivity control warns about lowering it and why every match is
  // proposed to the reviewer rather than applied.
  check('a loose threshold still lets an unrelated position through',
    collapsed.length > 3, collapsed.length + ' at 0.45 vs 3 real marks');

  const at = (x, y) => hits.some(h => Math.abs(h.x - x) <= 1 && Math.abs(h.y - y) <= 1);
  check('the first copy is located', at(10, 10));
  check('the second copy is located', at(100, 20));
  check('the faded copy is located too', at(60, 90));
  check('a faded copy still scores as a match',
    hits.every(h => h.score > 0.9), JSON.stringify(hits.map(h => +h.score.toFixed(3))));
}

{
  // Contrast invariance is the whole reason for normalising. The same mark on
  // a darker page, at half the contrast, has entirely different pixel values.
  const W = 80, H = 60, S = 16;
  const dark = blankPage(W, H, 90);
  stamp(dark, W, 20, 20, S, 0.5);
  const hits = Match.suppress(Match.correlate(dark, W, H, markTemplate(S)));
  check('the same mark is found on a darker page at lower contrast',
    hits.length === 1 && Math.abs(hits[0].x - 20) <= 1, JSON.stringify(hits));
}

{
  // Polarity. An inverted mark — light where the template is dark — is the
  // same shape with the colours swapped: white lettering knocked out of a
  // dark banner, against a template cut from dark lettering on white.
  //
  // The primitive keeps the sign, because the sign is real information and a
  // correlation function should not throw it away. The search pipeline asks it
  // to ignore the sign, because "is this the same shape?" is the question a
  // redaction tool wants answered — a word is no less exposed for being
  // knocked out of a coloured box.
  const W = 80, H = 60, S = 16;
  const page = blankPage(W, H);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      page[(20 + y) * W + 20 + x] = markPixel(x, y, S) ? 235 : 30;   // inverted
    }
  }
  const signed = Match.correlate(page, W, H, markTemplate(S), { threshold: -2 });
  const atMark = signed.filter(h => Math.abs(h.x - 20) <= 1 && Math.abs(h.y - 20) <= 1);
  check('an inverted mark correlates strongly negative',
    atMark.some(h => h.score < -0.95), JSON.stringify(atMark.map(h => +h.score.toFixed(3))));
  check('so a signed search does not report it',
    Match.suppress(Match.correlate(page, W, H, markTemplate(S))).length === 0);

  const blind = Match.suppress(
    Match.correlate(page, W, H, markTemplate(S), { anyPolarity: true }));
  check('but a polarity-blind search finds it', blind.length === 1,
    JSON.stringify(blind.map(h => +h.score.toFixed(3))));
  check('and scores it as the match it is',
    blind.length === 1 && blind[0].score > 0.95, JSON.stringify(blind.map(h => h.score)));
  check('and says it was inverted, rather than hiding the fact',
    blind.length === 1 && blind[0].inverted === true);
}

// Brightness and contrast were never the problem — normalising the mean and
// deviation out of both sides already handled those. Pinned here so a future
// change to the correlation cannot quietly lose them.
{
  const W = 80, H = 60, S = 16;
  const variants = {
    'the same colours': (on) => (on ? 30 : 235),
    'darker ink on a grey ground': (on) => (on ? 10 : 120),
    'a coloured ink on white': (on) => (on ? 90 : 245),
    'barely any contrast at all': (on) => (on ? 118 : 138),
    'inverted and barely any contrast': (on) => (on ? 138 : 118),
  };
  for (const [name, paint] of Object.entries(variants)) {
    const page = blankPage(W, H);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) page[(20 + y) * W + 20 + x] = paint(markPixel(x, y, S));
    }
    const hits = Match.suppress(
      Match.correlate(page, W, H, markTemplate(S), { anyPolarity: true, threshold: 0.75 }));
    const at = hits.find(h => Math.abs(h.x - 20) <= 1 && Math.abs(h.y - 20) <= 1);
    check('a mark printed with ' + name + ' is still found',
      Boolean(at) && at.score > 0.95, at ? at.score.toFixed(3) : 'missed');
  }
}

{
  const W = 80, H = 60, S = 16;
  const noise = blankPage(W, H);
  let seed = 7;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed % 256);
  }
  const hits = Match.suppress(Match.correlate(noise, W, H, markTemplate(S)));
  check('random noise produces no matches', hits.length === 0, hits.length + ' false positives');
}

check('a featureless pick is refused rather than matching everything',
  Match.prepareTemplate(new Float32Array(64).fill(120), 8, 8) === null);
check('an empty pick is refused', Match.prepareTemplate(new Float32Array(0), 0, 0) === null);
check('a template larger than the page finds nothing',
  Match.correlate(new Float32Array(16), 4, 4, markTemplate(8)).length === 0);

// Resampling has to preserve structure, since every search runs on a resized
// copy of both the template and the page.
{
  const S = 32;
  const big = new Float32Array(S * S);
  stamp(big, S, 0, 0, S, 1);
  const small = Match.resize(big, S, S, 16, 16);
  check('resampling keeps the mark recognisable',
    Match.prepareTemplate(small, 16, 16) !== null);
  check('resampling preserves the overall brightness', (() => {
    const mean = a => a.reduce((n, v) => n + v, 0) / a.length;
    return Math.abs(mean(big) - mean(small)) < 12;
  })(), 'means drifted');
  check('resizing to nothing returns an empty image',
    Match.resize(big, S, S, 0, 0).length === 0);
}

// Whether two marks are the same find, which is a different question from how
// well two boxes agree.
//
// The same word can be found twice by different means — once from the text
// layer and once by recognising its shape — and the two boxes then differ in
// size and sit slightly apart. The pair that prompted this had the picture box
// entirely inside the text box: an overlap of 1.0 measured against the smaller
// area, but only 0.60 by IoU, which is not obviously "the same thing" at all.
check('a box entirely inside another overlaps it completely',
  Match.overlapFraction({ x: 133, y: 136, w: 132, h: 63 },
    { x: 142, y: 143, w: 115, h: 43 }) === 1);
check('and IoU would have understated it',
  Match.iou({ x: 133, y: 136, w: 132, h: 63 }, { x: 142, y: 143, w: 115, h: 43 }) < 0.7);
check('boxes that miss each other overlap not at all',
  Match.overlapFraction({ x: 0, y: 0, w: 50, h: 50 }, { x: 200, y: 0, w: 50, h: 50 }) === 0);
check('boxes that merely touch do not overlap',
  Match.overlapFraction({ x: 0, y: 0, w: 50, h: 50 }, { x: 50, y: 0, w: 50, h: 50 }) === 0);
check('half of the smaller box inside the larger reads as a half',
  Match.overlapFraction({ x: 0, y: 0, w: 50, h: 50 }, { x: 25, y: 0, w: 50, h: 50 }) === 0.5);
check('a zero-area box cannot overlap anything',
  Match.overlapFraction({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 50, h: 50 }) === 0);

// Overlap arithmetic, which decides what counts as the same find.
check('identical boxes overlap completely',
  Match.iou({x:0,y:0,w:10,h:10}, {x:0,y:0,w:10,h:10}) === 1);
check('disjoint boxes do not overlap',
  Match.iou({x:0,y:0,w:10,h:10}, {x:50,y:50,w:10,h:10}) === 0);
check('suppression keeps the better-scoring of two overlapping finds', (() => {
  const kept = Match.suppress([
    { x: 0, y: 0, w: 10, h: 10, score: 0.85 },
    { x: 1, y: 1, w: 10, h: 10, score: 0.95 },
  ]);
  return kept.length === 1 && kept[0].score === 0.95;
})());
check('suppression keeps finds that do not overlap', Match.suppress([
  { x: 0, y: 0, w: 10, h: 10, score: 0.9 },
  { x: 40, y: 0, w: 10, h: 10, score: 0.9 },
]).length === 2);

// The scale ladder is the whole reason the first version of this "found
// nothing" on real documents: it spanned 0.6x to 1.75x, so a logo at half size
// or double size was never tried at any threshold.
// The rung that matters most, and the one that was missing. A picked logo is
// at scale 1.0 by definition, and so is every copy printed at the same size,
// which on a letterhead is most of them. The ladder used to be 0.25 x 1.25^k,
// which straddles 1.0 at 0.954 and 1.192 and never lands on it: refining the
// source position scored 0.977 while the search topped out at 0.805 and
// reported nothing found.
check('the scale ladder contains exactly 1.0', Match.SCALES.includes(1),
  Match.SCALES.join(','));
check('and 1.0 is not merely close to a rung',
  Match.SCALES.filter(s => s === 1).length === 1);

check('the scale ladder reaches well below half size', Match.SCALES[0] <= 0.3,
  String(Match.SCALES[0]));
check('and well above double size',
  Match.SCALES[Match.SCALES.length - 1] >= 3, String(Match.SCALES[Match.SCALES.length - 1]));
check('the ladder is geometric, so its steps stay proportional', (() => {
  const ratios = Match.SCALES.slice(1).map((s, i) => s / Match.SCALES[i]);
  return ratios.every(r => Math.abs(r - ratios[0]) < 0.02);
})(), JSON.stringify(Match.SCALES));
check('no step is coarse enough for refinement to miss',
  Match.SCALES[1] / Match.SCALES[0] < 1.3);
check('the coarse pass is more permissive than the reported threshold',
  Match.COARSE_THRESHOLD < Match.THRESHOLD);
check('the fine pass scores at a higher resolution than the coarse pass',
  Match.FINE_SIZE.target > Match.COARSE_SIZE.target);
// Localising and scoring are different jobs with different requirements.
// Scoring on a shrunken copy made identical logos score 0.98, 0.85 and 0.74
// depending on where the downsample landed relative to their strokes.
check('the final score is taken at a higher resolution than either search pass',
  Match.NATIVE_SIZE.target > Match.FINE_SIZE.target);
check('verification reaches far enough to correct refinement, not just re-score it',
  Match.VERIFY_RADIUS >= 8, String(Match.VERIFY_RADIUS));

// Sizing a template by its long side alone is what made a wide wordmark
// collapse to a one-pixel-tall strip with no structure left to match — the
// most likely reason a real document came back with nothing found. Every
// shape must survive both stages with something to correlate against.
for (const [w, h] of [[400, 40], [600, 30], [900, 20], [1200, 15], [122, 122], [40, 300], [30, 900]]) {
  for (const [name, size] of [['coarse', Match.COARSE_SIZE], ['fine', Match.FINE_SIZE]]) {
    const base = Match.workingScale(w, h, size);
    const tw = Math.round(w * base);
    const th = Math.round(h * base);
    check('a ' + w + 'x' + h + ' mark keeps structure at the ' + name + ' stage',
      Math.min(tw, th) >= 3, tw + 'x' + th);
  }
}
check('sizing never upsamples a template', (() => {
  const base = Match.workingScale(6, 6, Match.FINE_SIZE);
  return base <= 1;
})(), String(Match.workingScale(6, 6, Match.FINE_SIZE)));
check('a square mark is sized by its target', (() => {
  const base = Match.workingScale(200, 200, Match.COARSE_SIZE);
  return Math.round(200 * base) === Match.COARSE_SIZE.target;
})());
check('an elongated mark is allowed to be longer than the target',
  Math.round(600 * Match.workingScale(600, 30, Match.COARSE_SIZE)) > Match.COARSE_SIZE.target);

// How far a mark can be shrunk for nomination depends on where it keeps its
// identity. A monogram is a shape and survives; a wordmark is letters, and
// the letters live in its height. A real logo cut out of a real deck was not
// found at the pixels it had been cut from, because nomination squashed
// 451x44 of lettering to 72x7 and could no longer tell where to look: it
// proposed the true position with an overlap of zero, so verification was
// never given the chance to score it. Forced to score that position by hand,
// the very same template refined to 0.90.
check('a wordmark-shaped template gets the wide coarse profile',
  Match.coarseSizeFor(451, 44) === Match.COARSE_SIZE_WIDE);
check('and so does one just over the line',
  Match.coarseSizeFor(300, 100) === Match.COARSE_SIZE_WIDE);
check('a tall mark is treated the same way as a wide one',
  Match.coarseSizeFor(44, 451) === Match.COARSE_SIZE_WIDE);
check('an ordinary mark keeps the cheap profile',
  Match.coarseSizeFor(200, 200) === Match.COARSE_SIZE);
check('and so does a mildly oblong one',
  Match.coarseSizeFor(200, 90) === Match.COARSE_SIZE);
check('a degenerate size does not throw',
  Match.coarseSizeFor(0, 0) === Match.COARSE_SIZE);

// The point of the profile is the short side, so measure that and not the
// constant. Seven rows is what the cheap profile gave the logo that went
// missing; the wide profile has to do materially better than that.
(() => {
  const wide = Match.coarseSizeFor(451, 44);
  const rows = Math.round(44 * Match.workingScale(451, 44, wide));
  check('a wordmark keeps enough rows to nominate from', rows >= 12, rows + ' rows');
  const wasRows = Math.round(44 * Match.workingScale(451, 44, Match.COARSE_SIZE));
  check('which is more than the profile that lost it', rows > wasRows, rows + ' vs ' + wasRows);
  // The cost of those rows is bounded, or every wide mark becomes a full
  // resolution sweep and the search stops finishing.
  const cols = Math.round(451 * Match.workingScale(451, 44, wide));
  check('without letting the coarse pass grow without limit',
    cols <= Match.COARSE_SIZE_WIDE.maxLong, cols + ' columns');
})();

// A template may carry its own threshold, because not every template
// deserves the same bar. A logo cut from the document is matched against a
// copy of itself; a word drawn here in Helvetica is a guess at whatever
// typeface the document was really set in, and never scores as well. On a
// real deck the two true occurrences of a word scored 0.735 and 0.598 while
// the best thing that was not the word scored 0.465 — reachable only if the
// word can be given a lower bar than the logos in the same sweep.
(() => {
  const page = new Float32Array(40 * 40);
  for (let i = 0; i < page.length; i++) page[i] = (i * 37 % 251) / 251;
  const cut = ImageSearch.templateFromGray
    ? null
    : { gray: Match.crop(page, 40, 40, { x: 8, y: 8, w: 12, h: 12 }), width: 12, height: 12 };
  const ready = ImageSearch.prepareTemplate(cut, {});
  if (!ready) { check('per-template threshold fixture builds', false); return; }
  const strict = ImageSearch.searchPage(page, 40, 40, { ...ready, threshold: 0.99 },
    { threshold: 0.1 });
  const loose = ImageSearch.searchPage(page, 40, 40, { ...ready, threshold: 0.1 },
    { threshold: 0.99 });
  // Without this the assertion below is vacuous: an empty match list passes
  // .every() trivially, so a threshold that let nothing through at all would
  // look like a threshold that worked.
  check('the per-threshold fixture actually matches something',
    loose.matches.length > 0, JSON.stringify(loose.matches.length));
  check('a template threshold overrides the sweep it runs in, upwards',
    strict.matches.every(m => m.score >= 0.99),
    JSON.stringify(strict.matches.map(m => +m.score.toFixed(2))));
  check('and downwards, so one sweep can hold two different bars',
    loose.matches.length >= strict.matches.length,
    loose.matches.length + ' vs ' + strict.matches.length);
})();

// A square mark must be untouched by all of this: it was never broken, and
// the wide profile costs about three times the nominating work.
check('an ordinary mark is sized exactly as before',
  Match.workingScale(200, 200, Match.coarseSizeFor(200, 200))
    === Match.workingScale(200, 200, Match.COARSE_SIZE));

// Candidates are chosen round-robin across scales, never by pooling coarse
// scores. Coarse scores come from differently resampled pages and are not
// comparable, and ranking them against each other dropped real matches that
// scored 0.83 to 0.95 once refinement looked at them properly.
check('interleaving takes the best of every scale before the second of any', (() => {
  const byScale = [
    [{ id: 'a1', score: 0.9 }, { id: 'a2', score: 0.8 }],
    [{ id: 'b1', score: 0.5 }, { id: 'b2', score: 0.4 }],
    [{ id: 'c1', score: 0.7 }],
  ];
  const picked = ImageSearch.interleave(byScale, 4).map(x => x.id);
  return picked.join(',') === 'a1,b1,c1,a2';
})());
check('interleaving honours its limit',
  ImageSearch.interleave([[{ id: 1 }, { id: 2 }], [{ id: 3 }]], 2).length === 2);
check('interleaving an empty nomination set yields nothing',
  ImageSearch.interleave([], 10).length === 0);
check('interleaving copes with scales that found nothing',
  ImageSearch.interleave([[], [{ id: 1 }], []], 5).length === 1);

// Trimming a sloppy pick down to its ink.
{
  const W = 60, H = 50;
  const pick = new Float32Array(W * H).fill(238);
  stamp(pick, W, 20, 16, 16, 1);
  const box = Match.trimToContent(pick, W, H);
  check('a hand-drawn pick is trimmed to the mark inside it',
    box.x >= 18 && box.x <= 20 && box.y >= 14 && box.y <= 16, JSON.stringify(box));
  check('and the trim keeps the whole mark',
    box.x + box.w >= 36 && box.y + box.h >= 32, JSON.stringify(box));
  check('trimming never grows the pick',
    box.w <= W && box.h <= H && box.x >= 0 && box.y >= 0);
}
check('a pick with nothing in it is left alone rather than trimmed to nothing', (() => {
  const flat = new Float32Array(40 * 40).fill(200);
  const box = Match.trimToContent(flat, 40, 40);
  return box.w === 40 && box.h === 40;
})());
check('trimming works against a dark background too', (() => {
  const W = 50, H = 40;
  const dark = new Float32Array(W * H).fill(20);
  for (let y = 12; y < 28; y++) for (let x = 15; x < 33; x++) dark[y * W + x] = 230;
  const box = Match.trimToContent(dark, W, H);
  return box.x >= 13 && box.x <= 15 && box.w <= 22;
})(), JSON.stringify(Match.trimToContent(
  (() => { const W = 50, H = 40; const d = new Float32Array(W * H).fill(20);
    for (let y = 12; y < 28; y++) for (let x = 15; x < 33; x++) d[y * W + x] = 230; return d; })(), 50, 40)));

check('cropping lifts out exactly the requested rectangle', (() => {
  const g = new Float32Array(25);
  for (let i = 0; i < 25; i++) g[i] = i;
  const c = Match.crop(g, 5, 5, { x: 1, y: 1, w: 2, h: 2 });
  return c[0] === 6 && c[1] === 7 && c[2] === 11 && c[3] === 12;
})());

// A small logo makes a small coarse template, and a small template is exactly
// where sampling shortcuts break. This pins the failure that shipped: at the
// true position the correlation peaked at 0.765, but stepping two pixels at a
// time saw only 0.374 — below the nomination threshold, so the document came
// back with nothing found at all.
{
  const W = 240, H = 180, S = 11;
  const page = blankPage(W, H);
  stamp(page, W, 40, 30, S, 1);
  stamp(page, W, 150, 100, S, 1);
  const tiny = markTemplate(S);

  const hits = Match.suppress(Match.correlate(page, W, H, tiny));
  check('a small mark is still found when the template is small',
    hits.length === 2, hits.length + ' found with an ' + S + 'px template');
  check('and scores well at the position it really is',
    hits.every(h => h.score > 0.9), JSON.stringify(hits.map(h => +h.score.toFixed(3))));
  check('correlation steps one pixel at a time, with no sampling shortcut', (() => {
    // Counting positions does not work as a check: featureless patches are
    // skipped, so most of a mostly-blank page never appears. What does
    // distinguish a stride is whether neighbouring positions are both tested —
    // stepping by two can never return two x-coordinates differing by one.
    const all = Match.correlate(page, W, H, tiny, { threshold: -2 });
    const xs = new Set(all.map(h => h.x));
    return [...xs].some(x => xs.has(x + 1));
  })(), 'no adjacent positions were tested');
}

// The sensitivity slider's default and the matcher's threshold are the same
// number written in two files, and they had drifted: the slider shipped at
// 0.82 while the matcher was tuned to 0.75, so the app searched stricter than
// anything tested and quietly dropped real matches scoring in between. Held
// together here, since nothing else can notice.
{
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const slider = html.match(/id="sens"[^>]*value="(\d+)"/);
  check('the sensitivity slider declares a default', Boolean(slider), 'not found in index.html');
  if (slider) {
    check('and it matches the matcher\'s own threshold',
      Number(slider[1]) / 100 === Match.THRESHOLD,
      'slider ' + (Number(slider[1]) / 100) + ' vs threshold ' + Match.THRESHOLD);
  }
  const shown = html.match(/id="sensvalue">([\d.]+)</);
  check('the read-out beside it starts at the same value',
    shown && Number(shown[1]) === Match.THRESHOLD,
    shown ? shown[1] : 'not found');
  const bounds = html.match(/id="sens"[^>]*min="(\d+)"[^>]*max="(\d+)"/);
  check('the slider can reach below the default, to find more',
    bounds && Number(bounds[1]) / 100 < Match.THRESHOLD, bounds ? bounds[1] : 'no min');
  check('and above it, to find only near-certain matches',
    bounds && Number(bounds[2]) / 100 > Match.THRESHOLD, bounds ? bounds[2] : 'no max');
}

// ---------- placeholder labels ----------
//
// The property that makes labels worth having is consistency: the same value
// gets the same placeholder everywhere, so a reader can tell that the person
// in paragraph two is the person in paragraph nine.

{
  const items = [
    { id: 'a', kind: 'term', term: 'Jane Doe', text: 'Jane Doe' },
    { id: 'b', kind: 'email', text: 'jane.doe@example.com' },
    { id: 'c', kind: 'term', term: 'Jane Doe', text: 'JANE DOE' },
    { id: 'd', kind: 'term', term: 'Jane Doe', text: 'jane doe' },
    { id: 'e', kind: 'email', text: 'JANE.DOE@EXAMPLE.COM' },
    { id: 'f', kind: 'term', term: 'Account 4471', text: 'Account 4471' },
    { id: 'g', kind: 'image', templateId: 'tpl1' },
    { id: 'h', kind: 'image', templateId: 'tpl1' },
    { id: 'i', kind: 'image', templateId: 'tpl2' },
    { id: 'j', kind: 'manual' },
    { id: 'k', kind: 'manual' },
    { id: 'l', kind: 'phone', text: '(415) 555-0132' },
  ];
  const { byId, entries } = Labels.assign(items, {});

  check('a name typed once is one placeholder however it is cased',
    byId.a === byId.c && byId.c === byId.d, JSON.stringify([byId.a, byId.c, byId.d]));
  check('and that placeholder says it is a person', byId.a === 'P1', byId.a);
  check('an email is one placeholder regardless of case',
    byId.b === byId.e && byId.b === 'E1', byId.b + ' vs ' + byId.e);
  check('a typed term full of digits is not guessed to be a person',
    byId.f === 'T1', byId.f);
  check('every match of one picked logo shares a placeholder',
    byId.g === byId.h && byId.g === 'L1', byId.g + ' vs ' + byId.h);
  check('a different logo gets a different one', byId.i === 'L2', byId.i);
  check('hand-drawn boxes are numbered separately',
    byId.j === 'R1' && byId.k === 'R2', byId.j + ' ' + byId.k);
  check('a detector kind gets its own prefix', byId.l === 'PH1', byId.l);
  check('numbering follows first appearance in the document',
    entries.map(e => e.label).join(',') === 'P1,E1,T1,L1,L2,R1,R2,PH1',
    entries.map(e => e.label).join(','));

  // A placeholder has to fit inside the bar it labels, and bars are only as
  // wide as what they cover. render.js shrinks a label until it fits, so the
  // cost of a long one is a smaller, harder-to-read label rather than a
  // missing one — until it hits the floor, below which nothing is drawn.
  check('every suggested placeholder is short enough for a narrow bar',
    entries.every(e => e.label.length <= 4),
    entries.map(e => e.label).join(','));
  check('a suggested placeholder is at most twice the width of a bare number',
    entries.every(e => e.label.replace(/\d+$/, '').length <= 2),
    entries.map(e => e.label).join(','));
  check('an entry counts every occurrence',
    entries[0].count === 3 && entries[1].count === 2,
    entries[0].count + ',' + entries[1].count);

  // ---- the safety boundary ----
  //
  // The legend goes inside the redacted document; the key does not. A legend
  // that carried the originals would undo the whole redaction, so this is the
  // single most important assertion in this section.
  const legend = Labels.legend(entries);
  const legendText = JSON.stringify(legend);
  for (const secret of ['Jane Doe', 'jane.doe@example.com', 'Account 4471', '555-0132']) {
    check('the legend does not contain "' + secret + '"', !legendText.includes(secret));
  }
  check('the legend has no field that could hold an original value',
    legend.every(row => Object.keys(row).sort().join(',') === 'count,description,label'),
    JSON.stringify(Object.keys(legend[0])));
  check('the legend still says what each placeholder stands for',
    legend[0].description === "a person's name" && legend[0].label === 'P1');
  // Terse codes only work because the legend spells them out, so this is
  // load-bearing rather than decorative.
  check('every short code is explained by the legend',
    legend.every(row => row.description && row.description.length > 5),
    JSON.stringify(legend.slice(0, 2)));

  const key = Labels.key(entries);
  check('the key does map back to the originals, which is its whole purpose',
    key[0].original === 'Jane Doe' && key[1].original === 'jane.doe@example.com',
    JSON.stringify(key.slice(0, 2)));
  check('the key records the reviewer\'s own wording, not the document\'s casing',
    key[0].original === 'Jane Doe');

  // ---- reviewer edits ----
  const overrides = {};
  overrides[entries[0].identity] = 'CLAIMANT';
  const edited = Labels.assign(items, overrides);
  check('an edited placeholder replaces every occurrence',
    edited.byId.a === 'CLAIMANT' && edited.byId.c === 'CLAIMANT' && edited.byId.d === 'CLAIMANT');
  check('and leaves the others alone', edited.byId.b === 'E1');
  check('an edited entry is marked as edited', edited.entries[0].edited === true);
  check('an unedited entry is not', edited.entries[1].edited === false);
}

check('no two categories share a prefix', (() => {
  const prefixes = Object.values(Labels.CATEGORIES).map(c => c.prefix);
  return new Set(prefixes).size === prefixes.length;
})(), Object.values(Labels.CATEGORIES).map(c => c.prefix).join(','));
check('every prefix is letters only, so a code splits cleanly from its number',
  Object.values(Labels.CATEGORIES).every(c => /^[A-Z]{1,2}$/.test(c.prefix)),
  Object.values(Labels.CATEGORIES).map(c => c.prefix).join(','));

check('a label is normalised into something a machine can read', (() => {
  return Labels.normalise("Jane's employer") === 'JANE_S_EMPLOYER'
    && Labels.normalise('  spaced  out  ') === 'SPACED_OUT'
    && Labels.normalise('a--b__c!') === 'A_B_C';
})());
check('an empty label normalises to nothing rather than to brackets',
  Labels.normalise('') === '' && Labels.normalise('!!!') === '');
check('a very long label is cut to something printable',
  Labels.normalise('x'.repeat(200)).length === 40);
check('a placeholder is rendered in brackets', Labels.render('PERSON_1') === '[PERSON_1]');

check('a name is recognised as one', Labels.looksLikeName('Jane Doe'));
check('a hyphenated or apostrophised name still is', Labels.looksLikeName("O'Brien"));
// An acronym is not a person, and saying it is puts a false claim into the
// legend — the part of the document a later reader actually trusts. Found by
// typing a real company's initials into the terms box and being told they were
// somebody's name.
check('an acronym is not assumed to be a person', !Labels.looksLikeName('KAG'));
check('nor is a longer one', !Labels.looksLikeName('NHS'));
check('nor is a name shouted in capitals', !Labels.looksLikeName('JANE DOE'));
check('a lower-case word is not assumed to be a name', !Labels.looksLikeName('invoice'));
check('anything with digits is not assumed to be a name', !Labels.looksLikeName('Account 4471'));
check('a whole sentence is not assumed to be a name',
  !Labels.looksLikeName('The Quick Brown Fox Jumped Over'));

// Placeholders in a redacted text file.
{
  const sample = 'Call Jane on (415) 555-0132 about jane@example.com.';
  const spans = Detect.findAll(sample, { terms: ['Jane'] });
  const assigned = Labels.assign(
    spans.map(s => ({ id: s.id, kind: s.kind, text: s.text, term: s.term })), {});
  const out = Detect.applyToText(sample, spans.map(s => ({
    ...s, replacement: Labels.render(assigned.byId[s.id]),
  })), 'replacement');

  check('placeholders replace the values in a text export',
    !out.includes('Jane') && !out.includes('555-0132') && !out.includes('jane@example.com'), out);
  check('and the sentence still reads as a sentence',
    /^Call \[P1\] on \[PH1\] about \[E1\]\.$/.test(out), out);
  check('an unlabelled span in replacement mode removes rather than inventing',
    Detect.applyToText('a b', [{ start: 0, end: 1 }], 'replacement') === ' b');
}

// ---------- keeping going in a background tab ----------
//
// A hidden tab gets no animation frames at all, and pdf.js continues a page
// render from one. The wrapper substitutes a task the browser will still run.
// Tested against the functions it wraps rather than by waiting for a real
// browser to decide to throttle something.

{
  let hidden = false;
  let realCalls = 0;
  let cancelled = [];
  const wrapper = Schedule.wrapAnimationFrame(
    callback => { realCalls++; callback(0); return 42; },
    id => cancelled.push(id),
    () => hidden,
    () => 123);

  // Visible: the real thing, untouched.
  let ran = 0;
  const visibleId = wrapper.request(() => { ran++; });
  check('a visible page uses real animation frames', realCalls === 1 && ran === 1);
  check('and hands back the real identifier', visibleId === 42);
  wrapper.cancel(visibleId);
  check('cancelling a real frame goes to the real canceller',
    cancelled.length === 1 && cancelled[0] === 42);

  // Hidden: never touches rAF, still runs the callback.
  hidden = true;
  realCalls = 0;
  let hiddenRan = 0;
  let stamp = null;
  const hiddenId = wrapper.request(when => { hiddenRan++; stamp = when; });
  check('a hidden page does not ask for an animation frame', realCalls === 0);
  check('and the callback has not run synchronously', hiddenRan === 0);
  check('its identifier cannot be mistaken for a real one', hiddenId < 0);
  check('and it is outstanding until it runs', wrapper.pendingCount() === 1);

  await Schedule.nextTask();
  await Schedule.nextTask();
  check('the callback runs anyway, without a frame', hiddenRan === 1, String(hiddenRan));
  check('and is handed a timestamp, as a frame callback expects', stamp === 123);
  check('nothing is left outstanding', wrapper.pendingCount() === 0);

  // Cancelling before it runs.
  cancelled = [];
  let neverRan = 0;
  const doomed = wrapper.request(() => { neverRan++; });
  wrapper.cancel(doomed);
  check('cancelling a hidden request drops it', wrapper.pendingCount() === 0);
  check('and does not reach the real canceller, which knows nothing of it',
    cancelled.length === 0);
  await Schedule.nextTask();
  await Schedule.nextTask();
  check('a cancelled callback never runs', neverRan === 0, String(neverRan));
}

check('yielding resolves rather than hanging', await (async () => {
  await Schedule.nextTask();
  return true;
})());

// ---------- pdf writer ----------

const image = {
  bytes: new Uint8Array(deflateSync(Buffer.alloc(8 * 6 * 3, 0x20))),
  width: 8, height: 6, filter: 'FlateDecode',
};
const written = PdfWrite.build([
  { widthPt: 612, heightPt: 792, image },
  { widthPt: 200.5, heightPt: 100, image },
]);
const raw = Buffer.from(written).toString('latin1');
// pdf.js takes ownership of the buffer it is handed and detaches it, so
// anything measured from `written` has to be measured before it is parsed.
const writtenBytes = written.length;

check('the file starts with a PDF header', raw.startsWith('%PDF-1.'));
check('the file ends with EOF', raw.trimEnd().endsWith('%%EOF'));
check('a binary marker follows the header', /^%PDF-1\.\d\n%[\x80-\xff]{4}/.test(raw));
check('the declared page count matches', /\/Type \/Pages \/Count 2/.test(raw));
check('a fractional page size is not written in exponential form', raw.includes('0 0 200.5 100'));

const declared = Number(raw.match(/xref\n0 (\d+)/)[1]);
// Catalog, page tree, info and the shared font, then three objects per page,
// plus one for the free-list entry at index 0.
check('the xref covers every object that was written',
  declared === 5 + 2 * 3, 'declared ' + declared);
check('the highest object id written is inside /Size', (() => {
  const ids = [...raw.matchAll(/^(\d+) 0 obj$/gm)].map(m => Number(m[1]));
  return Math.max(...ids) === declared - 1;
})());
const xrefAt = Number(raw.match(/startxref\n(\d+)/)[1]);
check('startxref points at the table', raw.startsWith('xref', xrefAt));
const rows = raw.slice(xrefAt).split('\n').slice(2, 2 + declared);
check('the free-list head is present', rows[0].startsWith('0000000000 65535 f'));
let misplaced = 0;
for (let id = 1; id < declared; id++) {
  if (!raw.startsWith(id + ' 0 obj', Number(rows[id].slice(0, 10)))) misplaced++;
}
check('every xref offset lands on its object', misplaced === 0, misplaced + ' wrong');
check('every xref row is exactly twenty bytes',
  rows.slice(0, declared).every(r => r.length === 19));
check('the writer refuses an empty document', (() => {
  try { PdfWrite.build([]); return false; } catch { return true; }
})());
check('the writer refuses a non-finite page size', (() => {
  try { PdfWrite.build([{ widthPt: NaN, heightPt: 100, image }]); return false; } catch { return true; }
})());

// ---------- the output really has no text ----------

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const fixture = buildTextPdf();
const before = await pdfjs.getDocument({ data: new Uint8Array(fixture) }).promise;
const beforePage = await before.getPage(1);
const beforeText = (await beforePage.getTextContent()).items.map(i => i.str).join(' ');
check('the fixture contains extractable text', beforeText.includes('jane.doe@example.com'), beforeText.slice(0, 80));
check('the fixture detectors fire on that text',
  Detect.findAll(beforeText, { terms: ['Jane Doe'] }).length >= 5);

const after = await pdfjs.getDocument({ data: written }).promise;
check('the written PDF opens', after.numPages === 2);
let leaked = 0;
for (let n = 1; n <= after.numPages; n++) {
  const page = await after.getPage(n);
  if ((await page.getTextContent()).items.length !== 0) leaked++;
}
check('no page of the written PDF has any text object', leaked === 0, leaked + ' page(s) still had text');

// Every page must actually paint its image. A page whose XObject cannot be
// resolved still opens, still reports a size, and still has no text — it is
// simply blank, which no other assertion here would notice.
let unpainted = 0;
for (let n = 1; n <= after.numPages; n++) {
  const ops = await (await after.getPage(n)).getOperatorList();
  if (!ops.fnArray.includes(pdfjs.OPS.paintImageXObject)) unpainted++;
}
check('every page of the written PDF paints its image', unpainted === 0,
  unpainted + ' blank page(s)');

const firstViewport = (await after.getPage(1)).getViewport({ scale: 1 });
check('page size survives the rebuild', firstViewport.width === 612 && firstViewport.height === 792);
const secondViewport = (await after.getPage(2)).getViewport({ scale: 1 });
check('a second, differently sized page survives too',
  secondViewport.width === 200.5 && secondViewport.height === 100);

// ---------- a word the document tracked apart ----------
//
// The unit tests above prove the pattern tolerates whitespace. This proves the
// case that actually reached a user: a heading whose letters are tracked apart
// with a TJ array comes back from pdf.js with spaces standing in for the gaps,
// and the term has to survive that and still produce a box wide enough to
// cover the whole word.

const trackedDoc = await pdfjs.getDocument({ data: new Uint8Array(buildTrackedPdf('KAG')) }).promise;
const trackedPdfPage = await trackedDoc.getPage(1);
const trackedViewport = trackedPdfPage.getViewport({ scale: 1 });
// The same normalisation lib/pdfread.js does in the browser: place each item
// in viewport space so the boxes come out in the coordinates the app draws in.
const trackedItems = (await trackedPdfPage.getTextContent()).items
  .filter(item => typeof item.str === 'string' && item.transform)
  .map(item => {
    const tx = pdfjs.Util.transform(trackedViewport.transform, item.transform);
    return {
      str: item.str,
      x: tx[4],
      y: tx[5],
      w: item.width * trackedViewport.scale,
      h: Math.hypot(tx[2], tx[3]) || item.height * trackedViewport.scale,
      hasEOL: Boolean(item.hasEOL),
    };
  });

const trackedPage = Boxes.buildPageText(trackedItems);

// The precondition. If pdf.js ever stops reporting the tracked gaps as
// whitespace, this fixture no longer exercises the bug and everything below
// would pass for the wrong reason — so fail loudly here rather than quietly
// there.
check('the tracked heading reaches us with its letters spaced apart',
  /K\s+A\s+G/.test(trackedPage.text), JSON.stringify(trackedPage.text));
check('while the plain occurrences arrive unspaced',
  (trackedPage.text.match(/KAG/g) || []).length === 2, JSON.stringify(trackedPage.text));

const trackedSpans = Detect.findAll(trackedPage.text, { terms: ['KAG'] });
check('all three occurrences are found, the tracked one included',
  trackedSpans.length === 3, trackedSpans.length + ' found in ' + JSON.stringify(trackedPage.text));
check('and the tracked match covers the gaps, not just the first letter',
  trackedSpans.some(s => s.text === 'K A G'),
  JSON.stringify(trackedSpans.map(s => s.text)));

const trackedBoxes = Boxes.boxesForSpans(trackedPage.items, trackedSpans);
check('each occurrence gets a box', trackedBoxes.length === 3, trackedBoxes.length + ' box(es)');

// The tracked heading is physically wider than the plain word, so its box has
// to be wider too. A box sized to the plain word would sit over "K A" and
// leave the G showing, which is the visible half of the original bug.
const trackedWidths = trackedBoxes.map(b => b.w).sort((a, b) => a - b);
check('the tracked occurrence gets the widest box, covering the whole word',
  trackedWidths[2] > trackedWidths[1] * 1.3, JSON.stringify(trackedWidths));

const meta = await after.getMetadata();
check('the rebuilt file names Blinded as producer', meta.info.Producer === 'Blinded');
check('no author is carried into the output', !meta.info.Author);
check('no title is carried into the output', !meta.info.Title);
check('no creation date is carried into the output', !meta.info.CreationDate);

// ---------- report ----------

console.log('\nBlinded self-test');
console.log('  fixture lines    : ' + FIXTURE_LINES.length);
console.log('  written PDF      : ' + writtenBytes + ' bytes, ' + after.numPages + ' pages\n');

if (failures.length) {
  console.error('  ' + failures.length + ' FAILED:');
  for (const f of failures) console.error('    - ' + f);
  console.error('\n  ' + passed + ' checks passed');
  process.exit(1);
}
console.log('  ' + passed + ' checks passed');
