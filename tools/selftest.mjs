// Unit pass over everything that does not need a browser.
//
// The browser-side modules are written as classic scripts attached to a global
// so that they can be loaded here without a bundler, the same way the page
// loads them. tools/uitest.mjs covers the parts that need a real canvas.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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

for (const file of ['schedule.js', 'detect.js', 'boxes.js', 'pdfwrite.js', 'match.js',
  'textimage.js', 'pageprep.js', 'pagerole.js', 'imagesearch.js', 'labels.js', 'ocr.js']) {
  runInThisContext(readFileSync(join(root, 'lib', file), 'utf8'), { filename: file });
}
const Detect = globalThis.BlindedDetect;
const Boxes = globalThis.BlindedBoxes;
const PdfWrite = globalThis.BlindedPdfWrite;
const Match = globalThis.BlindedMatch;
const ImageSearch = globalThis.BlindedImageSearch;
const Labels = globalThis.BlindedLabels;
const TextImage = globalThis.BlindedTextImage;
const Ocr = globalThis.BlindedOcr;
const Schedule = globalThis.BlindedSchedule;
const PagePrep = globalThis.BlindedPagePrep;
const PageRole = globalThis.BlindedPageRole;

// ---------- detectors ----------

const kindsIn = (text, options) => Detect.findAll(text, options).map(f => f.kind);
const textsOf = (text, kind, options) =>
  Detect.findAll(text, options).filter(f => f.kind === kind).map(f => f.text);

check('finds an email', kindsIn('write to a.b+c@sub.example.co.uk now').includes('email'));
check('email keeps its whole domain',
  textsOf('write to a.b+c@sub.example.co.uk now', 'email')[0] === 'a.b+c@sub.example.co.uk');

for (const phone of ['+44 20 7946 0958', '+1 (415) 555-0132', '+84 28 3821 9930', '+65 6123 4567']) {
  check('finds phone ' + phone, kindsIn('call ' + phone + ' today').includes('phone'), phone);
}
// Local forms without a + country code are deliberately not phones. OCR of
// headcount charts stitches four-digit labels into 3-3-4 shapes, and a
// deal document that needs a bare local number can type it into terms.
check('a bare North American number is not a phone without +',
  !kindsIn('call (415) 555-0132 today').includes('phone'));
check('nor is a dashed local form',
  !kindsIn('call 415-555-0132 today').includes('phone'));
check('nor a spaced 3-3-4 group from a chart',
  !kindsIn('headcount 849 536 5216 workers').includes('phone'));
check('a +country number is high confidence', (() => {
  const found = Detect.findAll('call +1 (415) 555-0132').filter(f => f.kind === 'phone');
  return found.length === 1 && found[0].confidence === 'high';
})());

// Card numbers, bank accounts and IP addresses were removed: they are consumer
// and engineering data in a tool pointed at deal documents, and their patterns
// only lengthened a list that has to stay short enough to read.
for (const [gone, sample] of [['card', 'card 4242 4242 4242 4242 ok'],
  ['iban', 'pay GB82 WEST 1234 5698 7654 32 today'],
  ['ip', 'host 192.168.1.44 up']]) {
  check('no detector claims to find ' + gone,
    !Detect.DETECTORS.some(d => d.kind === gone), Detect.DETECTORS.map(d => d.kind).join(', '));
  check('and nothing in "' + sample + '" is picked up as one',
    !kindsIn(sample).includes(gone), kindsIn(sample).join(','));
}
check('while a typed term still covers a card number for anyone who wants it',
  Detect.findAll('card 4242 4242 4242 4242 ok',
    { terms: ['4242 4242 4242 4242'] }).length === 1);
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
check('finds a URL', kindsIn('see https://example.com/a?token=abc for more').includes('url'));
check('a URL drops the sentence full stop',
  textsOf('see https://example.com/a.', 'url')[0] === 'https://example.com/a');
check('finds a street address with a postal code',
  kindsIn('at 1600 Amphitheatre Parkway, Mountain View, CA 94043 today').includes('address'));
check('but not a street without a postal code',
  !kindsIn('at 1600 Amphitheatre Parkway today').includes('address'),
  JSON.stringify(textsOf('at 1600 Amphitheatre Parkway today', 'address')));
check('but not a year beside a capitalised noun',
  !kindsIn('revenue in 2020 Park rose').includes('address'),
  JSON.stringify(textsOf('revenue in 2020 Park rose', 'address')));

// ---------- addresses: generic global / Asia, postal required ----------
//
// Country-specific seeds (Jalan, Lorong, Đường, ward/district alone) were
// removed. A hit needs a street-type line and a postal code after it.
const addr = text => textsOf(text, 'address');
check('finds a US street with ZIP',
  addr('1600 Amphitheatre Parkway, Mountain View, CA 94043').some(t => t.includes('94043')),
  JSON.stringify(addr('1600 Amphitheatre Parkway, Mountain View, CA 94043')));
check('finds a Singapore street with postcode',
  addr('1 Raffles Place, Singapore 048616').some(t => t.includes('048616')),
  JSON.stringify(addr('1 Raffles Place, Singapore 048616')));
check('and pulls a unit marker before the street when the postcode follows',
  addr('1 Raffles Place #44-02, Singapore 048616').some(t => t.includes('#44-02') && t.includes('048616')),
  JSON.stringify(addr('1 Raffles Place #44-02, Singapore 048616')));
check('finds a UK street with postcode',
  addr('10 Downing Street, London SW1A 2AA').some(t => /SW1A\s*2AA/.test(t)),
  JSON.stringify(addr('10 Downing Street, London SW1A 2AA')));
check('finds an Asian quay form when a postcode follows',
  addr('8 Marina Quay, Singapore 018960').some(t => t.includes('8 Marina Quay')),
  JSON.stringify(addr('8 Marina Quay, Singapore 018960')));
check('a street alone is not enough',
  addr('8 Marina Quay').length === 0,
  JSON.stringify(addr('8 Marina Quay')));
check('a Singapore block without street and postcode is not an address',
  addr('Blk 123A Toa Payoh').length === 0);
check('Jalan without a postal code is not an address',
  addr('15 Jalan Besar, Singapore').length === 0);
check('Vietnamese Duong without a postal code is not an address',
  addr('12 Đường Lê Lợi, Quận 1').length === 0);
check('and the brand Chuong Duong is not an address',
  addr('Water, Crystal, and Chuong Duong Drinks').length === 0);
check('a floor or building alone is not an address',
  addr('17th Floor, Sun Wah Tower').length === 0);
check('a Hong Kong floor line without a postal code is not an address',
  addr('Suite 2701, 27/F, Two IFC').length === 0);
check('a contact slide without a postal code yields no street address', (() => {
  const slide = 'KIM-LAN-DANG\nVice President, Principal Investments\n'
    + 'T: +84 28 3821 9930 (Ext. 288)\n17th Floor, Sun Wah Tower,\n'
    + '115 Nguyen Hue, Sai Gon Ward, HCMC, Vietnam\nvinacapital.com';
  return addr(slide).length === 0;
})());
check('the same slide with a postcode covers the street through the code', (() => {
  const slide = '17th Floor, Sun Wah Tower,\n'
    + '115 Nguyen Hue Street, Sai Gon Ward, HCMC 700000, Vietnam';
  const lines = addr(slide);
  return lines.some(t => t.includes('115 Nguyen Hue Street') && t.includes('700000'));
})(), JSON.stringify(addr('17th Floor, Sun Wah Tower,\n115 Nguyen Hue Street, Sai Gon Ward, HCMC 700000, Vietnam')));
check('a Singapore address line with postcode is taken through the code',
  addr('10 Marina Boulevard, Singapore 018983')
    .some(t => t.includes('10 Marina Boulevard') && t.includes('018983')),
  JSON.stringify(addr('10 Marina Boulevard, Singapore 018983')));

// What must still stay quiet.
check('a sentence with a floor in it is not an address',
  addr('Revenue, EBITDA and Margin all rose in the 3rd Floor refurbishment programme')
    .length === 0,
  JSON.stringify(addr('Revenue, EBITDA and Margin all rose in the 3rd Floor refurbishment programme')));
check('nor is a list of buildings that were bought',
  addr('Acquired Sun Wah Tower, Bitexco, Landmark 81, and other assets in 2023').length === 0,
  JSON.stringify(addr('Acquired Sun Wah Tower, Bitexco, Landmark 81, and other assets in 2023')));
check('nor a District mentioned in prose',
  addr('The Company, the Purchaser, and the Vendor each agreed District 1 terms').length === 0,
  JSON.stringify(addr('The Company, the Purchaser, and the Vendor each agreed District 1 terms')));
check('and a street mid-sentence without a postal code stays uncovered',
  addr('at 1600 Amphitheatre Parkway today').length === 0,
  JSON.stringify(addr('at 1600 Amphitheatre Parkway today')));

check('but not the soup',
  addr('a pho restaurant on the corner').length === 0,
  JSON.stringify(addr('a pho restaurant on the corner')));

// ---------- what is no longer offered ----------
//
// Postal codes and dates of birth went the way of card numbers, bank accounts
// and IP addresses. Every one of them is a shape made of digits, and on the
// documents this is pointed at they either do not appear or cannot be told
// from the figures around them: a postal code needed a country name or a state
// beside it before it was safe to propose at all, which is a detector asking
// the document to introduce it. Anyone who needs one types it.
for (const [gone, sample] of [['postcode', 'Mountain View, CA 94043'],
  ['postcode', 'Singapore 048616'],
  ['dob', 'DOB: 04/11/1979']]) {
  check('no detector claims to find ' + gone + ' any more',
    !Detect.DETECTORS.some(d => d.kind === gone),
    Detect.DETECTORS.map(d => d.kind).join(', '));
  check('and "' + sample + '" is left alone',
    !kindsIn(sample).includes(gone), kindsIn(sample).join(','));
}
check('while a typed term still covers one for anyone who wants it',
  Detect.findAll('DOB: 04/11/1979', { terms: ['04/11/1979'] }).length === 1);

// ---------- overlap: high-confidence detectors keep their identity ----------
//
// A medium-confidence span used to hand its identity to a typed word inside
// it. Addresses are high confidence when they carry a postal code, so they
// keep their kind — same rule as email.
{
  const found = Detect.findAll('Mailing address: 1600 Amphitheatre Parkway, CA 94043.',
    { terms: ['Amphitheatre'] });
  check('a high-confidence address keeps its own identity over a typed word inside it',
    found.length === 1 && found[0].kind === 'address'
      && found[0].text.includes('1600 Amphitheatre Parkway')
      && found[0].text.includes('94043'),
    JSON.stringify(found.map(f => ({ kind: f.kind, text: f.text }))));
}
{
  const found = Detect.findAll('Mailing address: 1600 Amphitheatre Parkway.',
    { terms: ['Amphitheatre'] });
  check('without a postal code the typed word is found on its own',
    found.length === 1 && found[0].kind === 'term' && found[0].term === 'Amphitheatre',
    JSON.stringify(found.map(f => f.kind)));
}
// Only a guess gives way like that. An email address that happens to contain a
// typed name is still an email address, and the legend must not call it a
// person.
{
  const found = Detect.findAll('write to jane@example.com', { terms: ['jane'] });
  check('a high-confidence span keeps its own identity',
    found.length === 1 && found[0].kind === 'email', JSON.stringify(found.map(f => f.kind)));
}
// ---------- names, found by where they sit ----------
//
// The detector never looks at the name itself, which is the whole point: it
// reads the anchor beside it. So these check the three layouts a name appears
// in, and then check the things that look like names and are not.
const who = (text, options) => textsOf(text, 'person', options);

check('a name over a job title is found',
  who('Jane Doe\nChief Executive Officer').includes('Jane Doe'),
  JSON.stringify(who('Jane Doe\nChief Executive Officer')));
check('including one in capitals with hyphens, which no name list would hold',
  who('KIM-LAN-DANG\nVice President, Principal Investments').includes('KIM-LAN-DANG'),
  JSON.stringify(who('KIM-LAN-DANG\nVice President, Principal Investments')));
check('and a Vietnamese name, because the name is never read',
  who('Tran Van Minh\nManaging Director').includes('Tran Van Minh'),
  JSON.stringify(who('Tran Van Minh\nManaging Director')));
check('a name over a contact line is found',
  who('Jane Doe\nT: +84 28 3821 9930').includes('Jane Doe'),
  JSON.stringify(who('Jane Doe\nT: +84 28 3821 9930')));
check('and over a bare email address',
  who('Jane Doe\njane.doe@example.com').includes('Jane Doe'),
  JSON.stringify(who('Jane Doe\njane.doe@example.com')));
check('a name under a sign-off is found',
  who('Yours sincerely,\nJane Doe').includes('Jane Doe'),
  JSON.stringify(who('Yours sincerely,\nJane Doe')));
check('a name after a Name: label is found',
  who('Name: Tran Van Minh').includes('Tran Van Minh'),
  JSON.stringify(who('Name: Tran Van Minh')));
check('and after the conformed signature a contract uses',
  who('By: /s/ Li Wei').includes('Li Wei'), JSON.stringify(who('By: /s/ Li Wei')));
check('a name beside a title on one line is found',
  who('Jane Doe, Managing Director').includes('Jane Doe'),
  JSON.stringify(who('Jane Doe, Managing Director')));
check('and the other way round',
  who('Managing Partner – Tran Van Minh').includes('Tran Van Minh'),
  JSON.stringify(who('Managing Partner – Tran Van Minh')));

// What it must not call a person. Each of these is a capitalised run of the
// right length sitting next to a real anchor, which is exactly the shape the
// detector looks for — they are separated by what the words mean, not by
// where they sit.
check('a company over its own email is not a person',
  who('VinaCapital Group\ninfo@vinacapital.com').length === 0,
  JSON.stringify(who('VinaCapital Group\ninfo@vinacapital.com')));
check('a city over a phone number is not a person',
  who('Ho Chi Minh City\nT: +84 28 3821 9930').length === 0,
  JSON.stringify(who('Ho Chi Minh City\nT: +84 28 3821 9930')));
check('a building is not a person',
  who('Sun Wah Tower\nT: +84 28 3821 9930').length === 0,
  JSON.stringify(who('Sun Wah Tower\nT: +84 28 3821 9930')));
check('a slide heading is not a person',
  who('Executive Summary\nManaging Director commentary follows').length === 0,
  JSON.stringify(who('Executive Summary\nManaging Director commentary follows')));
check('a single capitalised word is never a person',
  who('Victory\nManaging Director').length === 0,
  JSON.stringify(who('Victory\nManaging Director')));
check('and a job title on its own is not the person holding it',
  who('Chief Executive Officer\nT: +84 28 3821 9930').length === 0,
  JSON.stringify(who('Chief Executive Officer\nT: +84 28 3821 9930')));
check('a name with no anchor anywhere near it is not proposed',
  who('Jane Doe\nNothing else on this line at all').length === 0,
  JSON.stringify(who('Jane Doe\nNothing else on this line at all')));

// Brand names on a logo collage. OCR reads the lettering; without these
// guards the person detector treats "Yum China" over a junk title line as a
// contact block. fromOcr is what detectOcr passes.
check('a brand ending in China is not a person',
  who('Yum China\nFounder & Chairman').length === 0,
  JSON.stringify(who('Yum China\nFounder & Chairman')));
check('Love Bonito over a short Advisor line is not a person from OCR',
  who('Love Bonito\nAdvisor since', { fromOcr: true }).length === 0,
  JSON.stringify(who('Love Bonito\nAdvisor since', { fromOcr: true })));
check('a long OCR junk line containing Director is not a title anchor',
  who('Mead Johnson\nAccutar Biotech Tillasesece Director Avistone Oasis', { fromOcr: true }).length === 0,
  JSON.stringify(who('Mead Johnson\nAccutar Biotech Tillasesece Director Avistone Oasis', { fromOcr: true })));
// OCR of a real contact block must still work: short title under the name.
check('OCR still finds a name over a short job title',
  who('Jane Doe\nChief Executive Officer', { fromOcr: true }).includes('Jane Doe'),
  JSON.stringify(who('Jane Doe\nChief Executive Officer', { fromOcr: true })));
check('and OCR still finds a name over a contact line',
  who('Jane Doe\nT: +84 28 3821 9930', { fromOcr: true }).includes('Jane Doe'),
  JSON.stringify(who('Jane Doe\nT: +84 28 3821 9930', { fromOcr: true })));
check('OCR still finds a name over a weak title when a phone follows',
  who('Jane Doe\nAssociate\nT: +84 28 3821 9930', { fromOcr: true }).includes('Jane Doe'),
  JSON.stringify(who('Jane Doe\nAssociate\nT: +84 28 3821 9930', { fromOcr: true })));

// The whole contact slide, which is what this was built for.
{
  const slide = 'KIM-LAN-DANG\nVice President, Principal Investments – Private Equity\n'
    + 'T: +84 28 3821 9930 (Ext. 288)\nM: +84 902 307 325\n'
    + '17th Floor, Sun Wah Tower,\n115 Nguyen Hue, Sai Gon Ward, HCMC, Vietnam';
  const kinds = kindsIn(slide);
  for (const want of ['person', 'phone']) {
    check('the contact slide gives up its ' + want, kinds.includes(want), kinds.join(','));
  }
  check('and no street address without a postal code',
    !kinds.includes('address'), kinds.join(','));
  check('and the building beside the name is not a second person',
    who(slide).length === 1, JSON.stringify(who(slide)));
}


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

const sample = 'Call Jane on +1 (415) 555-0132.';
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
// The rungs are chosen for the template's size: what decides whether a copy can
// be told apart from the page is how many pixels it has. Measured on a real
// deck — see MIN_COPY_AREA in match.js — where one ladder for every template
// both flooded a small mark with junk and put a large mark's real copies out
// of reach.
{
  const small = Match.scalesFor(46, 46);
  const large = Match.scalesFor(231, 195);
  const wide = Match.scalesFor(113, 25);
  check('a small mark is not searched for at sizes with nothing left in them',
    small[0] >= 0.4, JSON.stringify(small.slice(0, 3)));
  check('while a large one is searched far below the shared floor',
    large[0] <= 0.12, JSON.stringify(large.slice(0, 3)));
  // Area, not the short side: a wordmark's short side is its x-height, and
  // half of a 113x25 lockup is still 672 pixels of shape.
  check('and a wordmark is measured by how much of it is left, not its height',
    wide[0] <= 0.4, JSON.stringify(wide.slice(0, 3)));
  check('every ladder still contains exactly 1.0',
    [small, large, wide].every(l => l.filter(s => s === 1).length === 1),
    JSON.stringify([small.includes(1), large.includes(1), wide.includes(1)]));
}

check('the scale ladder contains exactly 1.0', Match.SCALES.includes(1),
  Match.SCALES.join(','));
check('and 1.0 is not merely close to a rung',
  Match.SCALES.filter(s => s === 1).length === 1);

check('the scale ladder reaches well below half size', Match.SCALES[0] <= 0.3,
  String(Match.SCALES[0]));
check('and well above double size',
  Match.SCALES[Match.SCALES.length - 1] >= 3, String(Match.SCALES[Match.SCALES.length - 1]));
// Geometric, but at two rates: close together where the copies are, wider out
// on the tails where finding a thing at all beats scoring it precisely. Every
// step is still proportional — a fixed step that suits 0.3x is far too coarse
// at 3x — and none of them is wide enough for refinement, which probes ±12%,
// to be unable to bridge.
check('every step is proportional, and none too coarse for refinement', (() => {
  const ratios = Match.SCALES.slice(1).map((s, i) => s / Match.SCALES[i]);
  return ratios.every(r => r > 1.02 && r < 1.3);
})(), JSON.stringify(Match.SCALES));
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

// ---------- stitching what OCR read ----------
//
// lib/boxes.js has to guess where the spaces are, because pdf.js hands it runs
// of glyphs and a gap that may or may not be a word break. OCR needs no
// guessing: every item is one word. Guessing anyway cost real matches — small
// footnote text stitched as "veryyearwithKAG", and a search for the name found
// nothing there, because the word boundary it needs had gone.
(() => {
  const word = (str, x, y, hasEOL) => ({ str, x, y, w: str.length * 6, h: 12, hasEOL });
  const items = [
    word('every', 10, 100, false), word('year', 50, 100, false),
    word('with', 80, 100, false), word('KAG', 110, 100, true),
    word('Since', 10, 120, false), word('then', 50, 120, true),
  ];
  const out = Ocr.stitch(items);
  check('every word is separated from the next',
    out.text === 'every year with KAG\nSince then', JSON.stringify(out.text));
  check('so the term is findable in what was read',
    Detect.findAll(out.text, { terms: ['KAG'] }).length === 1);
  check('a line end becomes a line break, not a space',
    out.text.includes('KAG\nSince'), JSON.stringify(out.text));
  check('each word knows where it landed in the text',
    out.items[3].start === out.text.indexOf('KAG')
      && out.items[3].end === out.text.indexOf('KAG') + 3,
    JSON.stringify(out.items[3]));
  check('the words themselves are carried through',
    out.items.length === items.length && out.items[0].str === 'every');
  check('stitching nothing is harmless',
    Ocr.stitch([]).text === '' && Ocr.stitch([]).items.length === 0);
  // The geometric rule this replaced produced the failure above. Prove the
  // separator does not depend on the gap between words at all: these two sit
  // flush against each other and must still be two words.
  const flush = Ocr.stitch([word('with', 0, 10, false), word('KAG', 24, 10, true)]);
  check('words that touch are still separated',
    flush.text === 'with KAG', JSON.stringify(flush.text));
})();

// The SIMD probe has to fail only when SIMD is missing, never because it is
// malformed. The first one was written from memory, did not validate anywhere,
// and every browser quietly got the slower build: measured afterwards, the
// SIMD core reads a page in about two seconds against about eight. The control
// is the same module with the SIMD instruction removed, so it must validate on
// any engine at all; if it does not, the probe is broken rather than reporting
// a browser without SIMD.
check('the probe control is a valid module anywhere',
  WebAssembly.validate(Ocr.PROBE_CONTROL));
check('and the probe itself is well formed on an engine that has SIMD',
  WebAssembly.validate(Ocr.SIMD_PROBE));
check('the two differ only by the SIMD instruction',
  Ocr.SIMD_PROBE.length === Ocr.PROBE_CONTROL.length + 2,
  Ocr.SIMD_PROBE.length + ' vs ' + Ocr.PROBE_CONTROL.length);

// Engines hold a copy of the model each, so this is bounded by memory rather
// than by cores, and never exceeds the work available.
check('one page needs one engine', Ocr.engineCount(1) === 1);
check('no more engines than pages', Ocr.engineCount(2) <= 2);
check('and never more than the ceiling',
  Ocr.engineCount(500) <= Ocr.MAX_ENGINES, String(Ocr.engineCount(500)));
check('there is always at least one', Ocr.engineCount(0) >= 1);

// The build of the engine is pinned rather than left to the engine to choose:
// it picks between six, each about four megabytes, and only the pinned ones
// are shipped.
check('the OCR core is pinned to a vendored build',
  /vendor\/tesseract\/tesseract-core-(simd-)?lstm\.wasm\.js$/.test(Ocr.corePath()),
  Ocr.corePath());
check('and it is served from this origin, never a CDN',
  Ocr.BASE.startsWith('vendor/') && !/^https?:/.test(Ocr.BASE), Ocr.BASE);

// How much of the bar a word earns back for being long, measured on three real
// documents rather than reasoned about. Short words resemble a great deal of a
// page; long ones resemble much less, but they also score lower, so the bar has
// to come down with them or they are never found.
check('a short word gets no relief at all', TextImage.shapeRelief('KAG') === 0);
check('nor does a four-letter acronym', TextImage.shapeRelief('TDTC') === 0);
check('a long word gets some', TextImage.shapeRelief('proprietary') > 0);
check('and a longer word gets more',
  TextImage.shapeRelief('proprietaryness') > TextImage.shapeRelief('proprietary'));
check('the relief is capped', TextImage.shapeRelief('a'.repeat(200)) === TextImage.RELIEF_MAX);
// The numbers that made this worth doing: on one page "KAG" was true from
// 0.679 up with the best false at 0.554, while "proprietary" was true at 0.639
// with its best false at 0.587. A bar of 0.66 serves the first and misses the
// second; 0.66 less this relief serves both.
check('at the default bar a short word is held at 0.66',
  Math.abs((0.66 - TextImage.shapeRelief('KAG')) - 0.66) < 1e-9);
check('and a long word is let down far enough to catch it, but not its noise',
  (() => {
    const bar = 0.66 - TextImage.shapeRelief('proprietary');
    return bar < 0.639 && bar > 0.587;
  })(), String(0.66 - TextImage.shapeRelief('proprietary')));

// A phrase is matched as one picture, and the space in the template is rarely
// the width of the space in the document, so the second word lands misaligned.
// Measured: "proprietary innovation" scores 0.455 where it really appears,
// below four things on that page which are not it. Relief there would admit
// those four and still miss the real one.
check('a phrase gets no relief, however long',
  TextImage.shapeRelief('proprietary innovation') === 0);
check('nor does a two-word name', TextImage.shapeRelief('KA Group') === 0);
check('leading and trailing space does not make a word a phrase',
  TextImage.shapeRelief('  proprietary  ') === TextImage.shapeRelief('proprietary'));
check('an empty term is harmless', TextImage.shapeRelief('') === 0
  && TextImage.shapeRelief(null) === 0);



// Typed terms: OCR-tolerant connectors and Comprehensive settlement cues.
(() => {
  check('F&N matches itself',
    Detect.findTerms('F&N is leading', ['F&N']).length === 1);
  check('F&N matches F and N',
    Detect.findTerms('F and N is leading', ['F&N']).some(h => h.term === 'F&N'));
  check('F&N matches inside F&N\'s',
    Detect.findTerms("F&N's Financials", ['F&N']).length === 1);
  check('OCR may glue FraserandNeave',
    Detect.findTerms('segment and FraserandNeave', ['Fraser and Neave'], { fromOcr: true })
      .some(h => h.term === 'Fraser and Neave'));
  check('but the text layer still demands real spaces between words',
    Detect.findTerms('FraserandNeave', ['Fraser and Neave']).length === 0);
  check('Fraser and Neave matches Fraser & Neave under OCR rules',
    Detect.findTerms('Fraser & Neave, Limited', ['Fraser and Neave'], { fromOcr: true })
      .length === 1);
  check('Fan is not silently accepted as F&N',
    Detect.findTerms('Fan is leading', ['F&N'], { fromOcr: true }).length === 0);
})();





// OCR phrase soft-fuzz: longer parts only, ≤1 edit, ≤1 fuzzy, need an exact anchor.
(() => {
  check('Widdle East recovers middle east under OCR fuzz',
    Detect.findTerms('Widdle East (88 stores)', ['middle east'], { fromOcr: true })
      .some(h => h.term === 'middle east'));
  check('Midale East recovers middle east',
    Detect.findTerms('region Midale East table', ['Middle East'], { fromOcr: true })
      .some(h => h.term === 'Middle East'));
  check('East alone is still not middle east',
    Detect.findTerms('East (88 stores)', ['middle east'], { fromOcr: true })
      .filter(h => h.term === 'middle east').length === 0);
  check('South East is not middle east',
    Detect.findTerms('South East region', ['middle east'], { fromOcr: true })
      .filter(h => h.term === 'middle east').length === 0);
  check('short parts are not fuzzed (east ≉ cast)',
    Detect.ocrFuzzyPartMatch('cast', 'east') === false);
  check('Middle fuzz allows one edit',
    Detect.ocrFuzzyPartMatch('Widdle', 'Middle') === true
    && Detect.ocrFuzzyPartMatch('Midale', 'Middle') === true);
  check('South is too far from Middle',
    Detect.ocrFuzzyPartMatch('South', 'Middle') === false);
  check('two fuzzy parts cannot invent Fraser and Neave',
    Detect.findTerms('Frasor Neavo limited', ['Fraser and Neave'], { fromOcr: true })
      .filter(h => h.term === 'Fraser and Neave').length === 0);
  check('one fuzzy + one exact still recovers Fraser and Neave',
    Detect.findTerms('Frasor and Neave limited', ['Fraser and Neave'], { fromOcr: true })
      .some(h => h.term === 'Fraser and Neave'));
})();

// OCR phrase recovery: content-word chains + hyphen/bullet glue.
(() => {
  check('OCR recovers Middle East across a digit crumb',
    Detect.findTerms('Middle 12 East region', ['Middle East'], { fromOcr: true })
      .some(h => h.term === 'Middle East'));
  check('OCR matches Middle-East as Middle East',
    Detect.findTerms('sales in Middle-East grew', ['Middle East'], { fromOcr: true })
      .some(h => h.term === 'Middle East'));
  check('OCR recovers Fraser and Neave when and is a bullet',
    Detect.findTerms('Fraser · Neave limited', ['Fraser and Neave'], { fromOcr: true })
      .some(h => h.term === 'Fraser and Neave'));
  check('unpaired East is not Middle East',
    Detect.findTerms('Looking East for growth', ['Middle East'], { fromOcr: true })
      .filter(h => h.term === 'Middle East').length === 0);
  check('a foreign word between parts blocks the chain',
    Detect.findTerms('Middle Kingdom East', ['Middle East'], { fromOcr: true })
      .filter(h => h.term === 'Middle East').length === 0);
  check('text layer still rejects hyphen glue for phrases',
    Detect.findTerms('Middle-East', ['Middle East']).length === 0);
})();



// Short acronym shape hits inside logo grids (KAS⊂TEXAS).
(() => {
  const logoRoles = {
    pageHint: 'logo_grid',
    regions: [{ role: 'logo_grid', score: 0.7, rect: { x: 0, y: 0, w: 400, h: 200 }, n: 8 }],
  };
  const bodyRoles = {
    pageHint: 'body',
    regions: [{ role: 'body', score: 0.7, rect: { x: 0, y: 0, w: 400, h: 200 }, n: 8 }],
  };
  const hit = { x: 40, y: 40, w: 30, h: 14 };
  check('KAS shape refused in logo_grid region',
    PageRole.allowShortAcronymShape(logoRoles, 'KAS', hit) === false);
  check('KAS shape allowed in body text',
    PageRole.allowShortAcronymShape(bodyRoles, 'KAS', hit) === true);
  check('longer terms still allowed in logo_grid',
    PageRole.allowShortAcronymShape(logoRoles, 'TEXAS', hit) === true);
  check('pageHint logo_grid refuses short shape without a region hit',
    PageRole.allowShortAcronymShape({ pageHint: 'logo_grid', regions: [] }, 'KNW', hit) === false);
})();

// Mid-word short-acronym shape FPs (KAS inside TEXAS).
(() => {
  check('TEXAS contradicts a KAS shape hit',
    Detect.hostContradictsShapeTerm('TEXAS', 'KAS') === true);
  check('TEXAS INSTRUMENTS host still contradicts KAS',
    Detect.hostContradictsShapeTerm('TEXAS', 'KAS') === true);
  check('a real KAS host does not contradict',
    Detect.hostContradictsShapeTerm('KAS', 'KAS') === false);
  check("KAS's still counts as the term",
    Detect.hostContradictsShapeTerm("KAS's", 'KAS') === false);
  check('offered contradicts jared',
    Detect.hostContradictsShapeTerm('offered', 'jared') === true);
  check('empty host is harmless',
    Detect.hostContradictsShapeTerm('', 'KAS') === false);
})();

// Comprehensive phrase sweeps: content parts + adjacent pairing.
(() => {
  check('phraseContentParts drops connectors',
    JSON.stringify(TextImage.phraseContentParts('Fraser and Neave')) === JSON.stringify(['Fraser', 'Neave']));
  check('Middle East keeps both words',
    JSON.stringify(TextImage.phraseContentParts('Middle East')) === JSON.stringify(['Middle', 'East']));
  check('a single word is one part',
    JSON.stringify(TextImage.phraseContentParts('Singapore')) === JSON.stringify(['Singapore']));

  const left = { x: 10, y: 20, w: 40, h: 12, score: 0.8 };
  const right = { x: 55, y: 21, w: 35, h: 12, score: 0.75 };
  const far = { x: 200, y: 21, w: 35, h: 12, score: 0.9 };
  check('adjacent phrase hits are accepted',
    Match.phraseHitsAdjacent(left, right, 0) === true);
  check('distant hits are not',
    Match.phraseHitsAdjacent(left, far, 0) === false);
  check('a skipped connector allows a wider gap',
    Match.phraseHitsAdjacent(left, { x: 120, y: 21, w: 35, h: 12, score: 0.7 }, 1) === true);

  const byPart = new Map([
    ['Middle', [left, { x: 300, y: 20, w: 40, h: 12, score: 0.7 }]],
    ['East', [right, far]],
  ]);
  const paired = Match.pairPhraseHits(['Middle', 'East'], byPart, [0]);
  check('pairPhraseHits returns one chained mark', paired.length === 1, JSON.stringify(paired));
  if (paired.length) {
    check('and the union spans both words',
      paired[0].x === 10 && paired[0].w >= 80);
  }
  check('skippedConnectorsBetween counts and',
    Match.skippedConnectorsBetween('Fraser and Neave', 'Fraser', 'Neave') === 1);

  // A name set over two lines is ordinary — on a slide, in a signature block,
  // under a photograph — and a phrase searched only along the line can never
  // find one. Measured: "Inderpreet Wadhwa" appears stacked on a deck and the
  // check found neither copy while finding each word on its own.
  const over = { x: 100, y: 40, w: 60, h: 14, score: 0.8 };
  const under = { x: 104, y: 56, w: 52, h: 14, score: 0.78 };
  check('a word directly under another is part of the same phrase',
    Match.phraseHitsStacked(over, under) === true);
  check('and a centred second line counts too',
    Match.phraseHitsStacked(over, { x: 108, y: 56, w: 44, h: 14 }) === true);
  // Two words on consecutive lines of a paragraph are not a phrase.
  check('but a word a line below and half a column across is not',
    Match.phraseHitsStacked(over, { x: 260, y: 56, w: 52, h: 14 }) === false);
  check('nor one three lines down',
    Match.phraseHitsStacked(over, { x: 104, y: 110, w: 52, h: 14 }) === false);

  const stackedParts = new Map([['Inderpreet', [over]], ['Wadhwa', [under]]]);
  const chained = Match.pairPhraseHits(['Inderpreet', 'Wadhwa'], stackedParts, [0]);
  check('a stacked phrase is chained into one mark',
    chained.length === 1, JSON.stringify(chained));
  if (chained.length) {
    check('and the mark covers both lines',
      chained[0].y === 40 && chained[0].h >= 30, JSON.stringify(chained[0]));
  }
  // Along the line first: a word beside is a stronger claim than one below.
  const both = new Map([
    ['Middle', [left]],
    ['East', [right, { x: 14, y: 36, w: 35, h: 12, score: 0.9 }]],
  ]);
  const preferred = Match.pairPhraseHits(['Middle', 'East'], both, [0]);
  check('and a word beside still wins over a word below',
    preferred.length === 1 && preferred[0].h <= 14, JSON.stringify(preferred));
})();

// Dark header bands for inverted OCR (white-on-colour titles).
(() => {
  check('darkInkRegions is exported',
    !!PagePrep && typeof PagePrep.darkInkRegions === 'function');

  const w = 800, h = 400;
  const gray = new Float32Array(w * h);
  gray.fill(245);
  // A dark red-like header bar with bright "text" pixels (~3% of page).
  for (let y = 240; y < 270; y++) {
    for (let x = 80; x < 320; x++) {
      gray[y * w + x] = 40;
      if ((x + y) % 5 === 0) gray[y * w + x] = 220;
    }
  }
  // A solid dark shadow with no bright ink — should not qualify.
  for (let y = 40; y < 70; y++) {
    for (let x = 80; x < 320; x++) gray[y * w + x] = 30;
  }
  const dark = PagePrep.darkInkRegions(gray, w, h);
  check('a dark bar with bright ink is found',
    dark.some(r => r.y >= 220 && r.y <= 260 && r.w > 100),
    JSON.stringify(dark));
  check('a solid shadow without bright ink is ignored',
    !dark.some(r => r.y < 90 && r.h > 20),
    JSON.stringify(dark));
  check('dark regions stay few', dark.length <= 6);
})();

// Page roles: chart vs contact layout for detector FP suppression.
(() => {
  check('pagerole is loaded', !!PageRole && typeof PageRole.classify === 'function');

  // Digit-heavy cluster like axis / bar labels on a chart.
  const chartItems = [];
  let x = 40;
  for (const label of ['2019', '2020', '2021', '2022', '45%', '52%', '61%', '70%']) {
    chartItems.push({ str: label, rect: { x: x, y: 80, w: 36, h: 12 } });
    x += 42;
  }
  const chart = PageRole.classify(chartItems, 600, 400);
  check('a digit cluster is labelled chart',
    chart.regions.some(r => r.role === 'chart') || chart.pageHint === 'chart',
    JSON.stringify(chart.regions.map(r => r.role)));
  const chartRegion = chart.regions.find(r => r.role === 'chart') || chart.regions[0];
  check('phones are suppressed inside a chart region',
    PageRole.allowDetector(chart, 'phone', chartRegion.rect) === false);
  check('addresses are suppressed inside a chart region',
    PageRole.allowDetector(chart, 'address', chartRegion.rect) === false);
  check('emails stay allowed in a chart region',
    PageRole.allowDetector(chart, 'email', chartRegion.rect) === true);
  check('typed terms are never suppressed',
    PageRole.allowDetector(chart, 'term', chartRegion.rect) === true);

  // Contact block: tel cue + phone + email.
  const contactItems = [
    { str: 'Jane Doe', rect: { x: 40, y: 40, w: 70, h: 12 } },
    { str: 'Director', rect: { x: 40, y: 56, w: 55, h: 12 } },
    { str: 'T:', rect: { x: 40, y: 80, w: 16, h: 12 } },
    { str: '+65 6123 4567', rect: { x: 60, y: 80, w: 90, h: 12 } },
    { str: 'E:', rect: { x: 40, y: 100, w: 16, h: 12 } },
    { str: 'jane@example.com', rect: { x: 60, y: 100, w: 110, h: 12 } },
  ];
  const contact = PageRole.classify(contactItems, 600, 400);
  check('a labelled contact block is contact',
    contact.regions.some(r => r.role === 'contact') || contact.pageHint === 'contact',
    JSON.stringify(contact.regions.map(r => r.role)));
  const contactRegion = contact.regions.find(r => r.role === 'contact') || contact.regions[0];
  check('phones stay allowed in a contact region',
    PageRole.allowDetector(contact, 'phone', contactRegion.rect) === true);
  check('person names stay allowed in a contact region',
    PageRole.allowDetector(contact, 'person', contactRegion.rect) === true);

  // Logo grid: many short fragments, no long prose.
  const logoItems = [];
  let ly = 40;
  for (let row = 0; row < 3; row++) {
    let lx = 40;
    for (const word of ['Acme', 'Inc', 'Beta', 'Co', 'Gamma', 'Ltd']) {
      logoItems.push({ str: word, rect: { x: lx, y: ly, w: 28, h: 10 } });
      lx += 50;
    }
    ly += 28;
  }
  const logos = PageRole.classify(logoItems, 600, 400);
  check('a short-fragment collage is logo_grid',
    logos.regions.some(r => r.role === 'logo_grid') || logos.pageHint === 'logo_grid',
    JSON.stringify(logos.regions.map(r => r.role)));
  const logoRegion = logos.regions.find(r => r.role === 'logo_grid') || logos.regions[0];
  check('phones are suppressed in a logo grid',
    PageRole.allowDetector(logos, 'phone', logoRegion.rect) === false);
  check('person names are suppressed in a logo grid',
    PageRole.allowDetector(logos, 'person', logoRegion.rect) === false);

  // Body prose should not suppress phones.
  const bodyItems = [
    { str: 'The company reported strong growth across the region this year.',
      rect: { x: 40, y: 40, w: 420, h: 14 } },
    { str: 'Further detail is available in the appendix.',
      rect: { x: 40, y: 60, w: 280, h: 14 } },
    { str: 'Please call +65 6123 4567 for questions.',
      rect: { x: 40, y: 80, w: 260, h: 14 } },
  ];
  const body = PageRole.classify(bodyItems, 600, 400);
  check('prose is body or other, not chart',
    !body.regions.some(r => r.role === 'chart'),
    JSON.stringify(body.regions.map(r => r.role)));
  const bodyRect = body.regions[0] ? body.regions[0].rect : { x: 40, y: 80, w: 260, h: 14 };
  check('phones stay allowed in body text',
    PageRole.allowDetector(body, 'phone', bodyRect) === true);
})();


// Page preparation: working-res cap, text regions, pyramid, OCR prep.
(() => {
  check('pageprep is loaded', !!PagePrep && typeof PagePrep.workSize === 'function');

  const big = PagePrep.workSize(4032, 3024);
  check('a 12MP page is capped on its long edge',
    big.width === 1800 && big.height === Math.round(3024 * (1800 / 4032)),
    big.width + 'x' + big.height);
  check('and reports the scale used', Math.abs(big.scale - 1800 / 4032) < 1e-9);

  const small = PagePrep.workSize(800, 600);
  check('a modest page is left alone',
    small.width === 800 && small.height === 600 && small.scale === 1);

  // A page with a dark text block on white and a flat map-like area.
  const w = 256, h = 256;
  const gray = new Float32Array(w * h);
  gray.fill(240);
  for (let y = 40; y < 100; y++) {
    for (let x = 20; x < 200; x++) {
      // Vertical strokes so local variance is high.
      gray[y * w + x] = (x % 3 === 0) ? 20 : 240;
    }
  }
  const regions = PagePrep.textRegions(gray, w, h);
  check('textRegions finds the ink block', regions.length >= 1,
    'regions=' + regions.length);
  if (regions.length) {
    const r = regions[0];
    check('and the region covers the stroke area',
      r.x <= 20 && r.y <= 40 && r.x + r.w >= 200 && r.y + r.h >= 100,
      JSON.stringify(r));
  }

  const masked = PagePrep.maskGray(gray, w, h, regions);
  check('maskGray keeps the ink and fills the rest with a mean',
    masked.length === gray.length
      && Math.abs(masked[40 * w + 20] - gray[40 * w + 20]) < 1e-6
      && Math.abs(masked[200 * w + 200] - gray[200 * w + 200]) > 1);

  const assets = PagePrep.pageAssets(gray, w, h);
  check('pageAssets builds a pyramid', assets.pyramid.length >= 2);
  check('and caches on the same grey buffer',
    PagePrep.pageAssets(gray, w, h) === assets);
  check('smallText is allowed on a modest page', assets.allowSmallText === true);

  const huge = new Float32Array(2000 * 1500);
  huge.fill(128);
  const hugeAssets = PagePrep.pageAssets(huge, 2000, 1500);
  check('a long-edge over the smallText cap disables the 1.5x pass',
    hugeAssets.allowSmallText === false);
  // The 2x pass reaches further, because a page short of pixels for what is on
  // it is exactly the page that needs it, and a slide rendered at 144 dots to
  // the inch is already past the gentler cap.
  check('but the coarse-page 2x pass still reaches it',
    hugeAssets.allowUpscale === true);
  const vast = new Float32Array(3000 * 2000);
  vast.fill(128);
  check('and stops where a page has pixels to spare',
    PagePrep.pageAssets(vast, 3000, 2000).allowUpscale === false);
  check('and the working grey is capped',
    Math.max(hugeAssets.work.width, hugeAssets.work.height) === PagePrep.WORK_LONG_EDGE,
    hugeAssets.work.width + 'x' + hugeAssets.work.height);

  // ---------- how far a page is resampled up for a second look ----------
  //
  // Three reasons, and they are not the same reason. A page short of pixels
  // for what it holds needs the most; a mark small in its own right needs the
  // same treatment whatever page it came from; small lettering on an ordinary
  // page needs the gentler pass. And a page with pixels to spare needs none,
  // because doubling it is four times the area for detail that is already
  // there.
  {
    const wordish = { template: { width: 90, height: 20 }, smallText: true };
    const logoish = { template: { width: 90, height: 60 } };
    const titchy = { template: { width: 40, height: 9 } };
    const roomy = { allowSmallText: true, allowUpscale: true };
    const big = { allowSmallText: false, allowUpscale: true };
    const vastPage = { allowSmallText: false, allowUpscale: false };

    check('a coarse page is looked at again at twice the size',
      ImageSearch.upscaleFor(logoish, roomy, { pageDpi: 96 })
        === ImageSearch.COARSE_PAGE_UPSCALE);
    check('and so is a mark too small to hold its shape',
      ImageSearch.upscaleFor(titchy, roomy, { pageDpi: 300 })
        === ImageSearch.COARSE_PAGE_UPSCALE);
    check('small lettering on an ordinary page gets the gentler pass',
      ImageSearch.upscaleFor(wordish, roomy, { pageDpi: 300 })
        === ImageSearch.SMALL_TEXT_UPSCALE);
    check('a page with pixels to spare gets neither',
      ImageSearch.upscaleFor(wordish, vastPage, { pageDpi: 96 }) === 1);
    check('and a large but coarse page still gets the 2x pass',
      ImageSearch.upscaleFor(logoish, big, { pageDpi: 96 })
        === ImageSearch.COARSE_PAGE_UPSCALE);
    check('an ordinary picked image on an ordinary page is searched once',
      ImageSearch.upscaleFor(logoish, roomy, { pageDpi: 300 }) === 1);

    // Dots per inch is measured against the paper the page was rendered from.
    // A photograph has no paper, and calling its pixels points would say 72
    // about every image ever opened.
    check('dpi is measured off the paper size',
      Math.round(ImageSearch.dpiOf({ widthPt: 612, source: { width: 1224 } })) === 144);
    check('and is unknown for an image file',
      ImageSearch.dpiOf({ fromImage: true, widthPt: 900, source: { width: 900 } }) === null
      && ImageSearch.dpiOf({ source: { width: 900 } }) === null);
  }

  const level = PagePrep.pyramidLevel(assets.pyramid, Math.round(assets.work.width / 2));
  check('pyramidLevel picks a level near the target width',
    Math.abs(level.width - assets.work.width / 2) <= assets.work.width / 4,
    level.width + ' vs ' + (assets.work.width / 2));
})();

// The resampled copy a small-lettering sweep works on is shared between every
// template in the sweep, or four typefaces for each of several words would
// each pay to build the same thing.
(() => {
  const gray = new Float32Array(40 * 20);
  for (let i = 0; i < gray.length; i++) gray[i] = (i % 7) / 7;
  const up = ImageSearch.upscaledOf(gray, 40, 20);
  check('the resampled page is larger by the stated factor',
    up.width === Math.round(40 * ImageSearch.SMALL_TEXT_UPSCALE)
      && up.height === Math.round(20 * ImageSearch.SMALL_TEXT_UPSCALE),
    up.width + 'x' + up.height);
  check('and it holds that many samples', up.gray.length === up.width * up.height);
  check('asking twice does not build it twice',
    ImageSearch.upscaledOf(gray, 40, 20) === up);
  const other = new Float32Array(40 * 20);
  check('but a different page gets its own',
    ImageSearch.upscaledOf(other, 40, 20) !== up);
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

// The bar a picked image has to clear starts where the matcher itself is
// tuned, and the two are written in different files. They had drifted once
// before, when the control shipped at 0.82 against a matcher tuned to 0.75 —
// so the app searched stricter than anything tested and quietly dropped real
// matches scoring in between. The control is now one slider per picked image,
// built in app.js, so that is where these numbers live.
{
  const js = readFileSync(join(root, 'app.js'), 'utf8');
  check('a newly picked image starts at the matcher\'s own threshold',
    /const DEFAULT_SENS = Match\.THRESHOLD;/.test(js),
    'DEFAULT_SENS is not tied to Match.THRESHOLD');
  const bounds = js.match(/slider\.min = '(\d+)';[\s\S]{0,900}?slider\.max = '(\d+)';/);
  check('the row slider declares its range', Boolean(bounds), 'not found in app.js');
  if (bounds) {
    check('and it can reach below the default, to find more',
      Number(bounds[1]) / 100 < Match.THRESHOLD, bounds[1]);
    check('and above it, to find only near-certain matches',
      Number(bounds[2]) / 100 > Match.THRESHOLD, bounds[2]);
  }
  // Whatever a draft or a stray value says, the search is run somewhere inside
  // that range: a threshold of 0 would propose every pixel of every page.
  // The clamp and the slider are the same range written twice, so they are
  // held together here rather than left to drift.
  if (bounds) {
    const clamp = js.match(/Math\.min\((0?\.\d+), Math\.max\((0?\.\d+), n\)\)/);
    check('the clamp exists', Boolean(clamp), 'clampSens not found');
    check('and nothing outside the slider\'s own range can reach the matcher',
      clamp && Number(clamp[1]) === Number(bounds[2]) / 100
        && Number(clamp[2]) === Number(bounds[1]) / 100,
      clamp ? clamp[1] + '/' + clamp[2] + ' vs ' + bounds[2] + '/' + bounds[1] : 'none');
  }
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
  const sample = 'Call Jane on +1 (415) 555-0132 about jane@example.com.';
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

// ---------- where a typed word begins and ends ----------
//
// \b treats letters and digits as one class, so a word with a stray number
// stuck to its front is not at a word boundary at all. Measured on a deck
// whose whole text layer read "54Tokenomics Digital Tech Co." — the 54 a slide
// number the exporter ran into the next run — where typing the company's name
// found nothing on a page that plainly says it.
{
  const spans = (text, term) => Detect.findTerms(text, [term]);
  const hits = (text, term) => spans(text, term).length;

  check('a word glued to a number in front of it is still that word',
    hits('54Tokenomics Digital Tech Co.', 'Tokenomics') === 1,
    JSON.stringify(spans('54Tokenomics Digital Tech Co.', 'Tokenomics')));
  check('and the span starts at the word, not at the number',
    (spans('54Tokenomics Digital', 'Tokenomics')[0] || {}).start === 2,
    JSON.stringify(spans('54Tokenomics Digital', 'Tokenomics')));
  check('and ends at the end of it',
    (spans('54Tokenomics Digital', 'Tokenomics')[0] || {}).end === 12,
    JSON.stringify(spans('54Tokenomics Digital', 'Tokenomics')));
  check('a number glued to a word is still that number',
    hits('page7 4242424242424242', '4242424242424242') === 1);

  // What the boundary is still for. Relaxing it altogether would mean every
  // short word matching inside every longer one, which is how a redaction
  // list becomes too long to read.
  check('but a word inside a longer word is still not it',
    hits('a fresh start today', 'art') === 0,
    JSON.stringify(spans('a fresh start today', 'art')));
  check('nor at the end of one', hits('this is a cart', 'art') === 0);
  check('nor a number inside a longer number', hits('120245', '2024') === 0);

  // The ordinary cases, unchanged.
  check('a word on its own is found', hits('the Tokenomics deck', 'Tokenomics') === 1);
  check('punctuation is a boundary', hits('(Tokenomics)', 'Tokenomics') === 1);
  check('the start of the text is a boundary', hits('Tokenomics leads', 'Tokenomics') === 1);
  check('and two occurrences are two', hits('Tokenomics and Tokenomics', 'Tokenomics') === 2);
  check('including two split only by punctuation',
    hits('Tokenomics,Tokenomics', 'Tokenomics') === 2,
    JSON.stringify(spans('Tokenomics,Tokenomics', 'Tokenomics')));
}

// ---------- the gallery on the front page ----------
//
// It began as a drawing, invented end to end, then became one real page. It is
// six pages now, each shown before and after, from a published investor
// presentation — which is what makes showing the unredacted half possible at
// all, and it is the half that makes the other half mean anything.
//
// What can be held here is the shape of it: that every picture the markup
// names is in the repository, that both halves of every slide exist, that the
// set is light enough for a front page, that each is described in words, and
// that no source document was left beside them.
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // Twelve pictures: six slides, each one before and after. Both halves have
  // to be present, because a toggle with nothing on one side of it is worse
  // than no toggle.
  const wanted = [...html.matchAll(/<img class="galimg[^>]*src="(gallery\/[^"]+)"/g)]
    .map(m => m[1]);
  check('the gallery names twelve pictures', wanted.length === 12, String(wanted.length));
  const missing = wanted.filter(name => !existsSync(new URL('../' + name, import.meta.url)));
  check('and every one of them is in the repository', missing.length === 0,
    missing.join(', '));
  for (let n = 1; n <= 6; n++) {
    check('slide ' + n + ' has both halves',
      wanted.includes('gallery/slide-' + n + '-original.jpg')
      && wanted.includes('gallery/slide-' + n + '-redacted.jpg'));
  }

  // A front page that costs a megabyte before anyone has done anything is a
  // front page people leave. Only the first slide is loaded up front; the
  // rest wait until they are scrolled to, so the budget that matters is the
  // whole set rather than any one of them.
  const weight = wanted
    .filter(name => existsSync(new URL('../' + name, import.meta.url)))
    .reduce((sum, name) => sum + statSync(new URL('../' + name, import.meta.url)).size, 0);
  check('and the gallery is small enough to sit on a front page',
    weight < 1400 * 1024, Math.round(weight / 1024) + 'KB');
  const eager = [...html.matchAll(/<img class="galimg[^>]*>/g)]
    .filter(tag => !/loading="lazy"/.test(tag[0]));
  check('and only the first slide is fetched before it is scrolled to',
    eager.length === 1, String(eager.length));

  check('the confirm dialog closes with a corner X, not a Cancel button',
    html.includes('id="confirmx"') && html.includes('class="dialog-x"')
      && !html.includes('id="confirmno"'),
    'confirm close control');
  check('and offers Reset to original in markup',
    html.includes('id="confirmreset"') && html.includes('Reset to original'));
  // File input must not sit inside the drop box — nested inputs make the
  // picker open-and-close on the first tap.
  {
    const dropOpen = html.indexOf('id="drop"');
    const dropClose = html.indexOf('</div>', html.indexOf('drop-faint', dropOpen));
    const dropInner = dropOpen >= 0 && dropClose >= 0
      ? html.slice(dropOpen, dropClose) : '';
    check('the drop box markup is present for nesting checks', dropInner.includes('drop-lead'));
    check('the file input is not nested inside the drop box',
      dropInner.length > 0 && !/id="file"/.test(dropInner),
      'file input still inside #drop');
    check('the file input still exists on the front page',
      /id="file"/.test(html));
  }


  // The picture the enlargement opens on has to be one of the gallery's, or
  // the first press of it shows something that is not on the page.
  const big = html.match(/id="samplebig" src="([^"]+)"/);
  check('the enlargement opens on a picture the gallery holds',
    Boolean(big) && wanted.includes(big[1]), big ? big[1] : 'no src');

  // A picture of a document says nothing to a reader who cannot see it, and
  // here the description is doing real work: it is where the difference
  // between the two halves is said in words.
  const alts = [...html.matchAll(/<img class="galimg[^>]*alt="([^"]*)"/g)]
    .map(m => m[1].replace(/\s+/g, ' ').trim());
  check('every slide is described for a reader who cannot see it',
    alts.length === 12 && alts.every(text => text.length > 80),
    alts.map(text => text.length).join(','));

  // The source was a real deck. Only the renders belong here, and a stray PDF
  // at the root is how the other thing gets published.
  const strays = readdirSync(new URL('../', import.meta.url))
    .filter(name => /\.pdf$/i.test(name));
  check('and no PDF was left behind beside them', strays.length === 0,
    strays.join(', '));
}

// ---------- a name is found through the gaps ----------
//
// A PDF often gives every run of text its own line with an empty one between
// it and the next. Measured on a real contact page, the layer read "Simon
// Kavanagh", "", "Partner", "", "skavanagh@…" — so looking at the line
// immediately below a name found the gap, and not one of the six people on
// that page was found. Every anchor was there, one row further away than the
// code was looking.
{
  const spaced = ['Simon Kavanagh', '', 'Partner', '', 'skavanagh@example.com', '',
    'T: +852 9383 3500', '', 'Anthony Siu', '', 'Partner', '',
    'asiu@example.com'].join('\n');
  const names = Detect.findAll(spaced).filter(f => f.kind === 'person').map(f => f.text);
  check('a name is found across a blank line',
    names.includes('Simon Kavanagh') && names.includes('Anthony Siu'),
    JSON.stringify(names));

  // And the blank lines must not join things that are not next to each other:
  // a name at the foot of one block and a title at the head of the next are
  // still two blocks.
  const apart = ['Simon Kavanagh', '', '', '', 'Some paragraph of prose that runs '
    + 'on and is plainly not a job title at all', '', 'Partner'].join('\n');
  check('but not across a paragraph that happens to sit between them',
    Detect.findAll(apart).filter(f => f.kind === 'person').length === 0,
    JSON.stringify(Detect.findAll(apart).filter(f => f.kind === 'person').map(f => f.text)));
}

// ---------- one kind of dash ----------
//
// An en dash throughout, on the page and in every message the tool writes.
// Not a matter of taste once it is a rule: two kinds of dash in one interface
// is the sort of thing a reader notices without being able to say why.
//
// Comments are not the website, so the sweep left them alone, and the file
// name cleaner keeps matching both kinds on purpose — it strips whatever the
// reviewer's own file happens to carry.
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  check('the page uses one kind of dash', !html.includes('\u2014'),
    (html.match(/[^\n]{0,60}\u2014[^\n]{0,60}/) || [''])[0]);

  const js = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const shouting = js.split('\n')
    .filter(line => line.includes('\\u2014') && !line.includes('.replace('));
  check('and so does everything the tool says', shouting.length === 0,
    shouting.join(' | '));
}

// ---------- the mark ----------
//
// It is drawn twice — inline in the header, and again in icon.svg for the
// favicon — because one is a single colour that follows the text and the other
// is a self-contained tile. Two drawings of one mark drift, so their shapes
// are held together here.
//
// Solid shapes only. The fading end was opacity once, which disappears
// wherever a favicon is drawn flat and leaves the mark looking like a plain
// pair of bars.
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const icon = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8');

  const inline = html.match(/<svg class="markmark"[\s\S]*?<\/svg>/);
  check('the header carries the mark as markup, not a bare rectangle',
    Boolean(inline), 'no markmark svg in index.html');

  const boxes = s => [...s.matchAll(/<rect[^>]*>/g)].map(m => m[0]);
  const widthOf = r => Number((r.match(/width="([\d.]+)"/) || [])[1]);
  const xOf = r => Number((r.match(/x="([\d.]+)"/) || [0, 0])[1]) || 0;

  if (inline) {
    const parts = boxes(inline[0]);
    check('drawn as four shapes: a whole line and one coming apart',
      parts.length === 4, parts.length + ' rects');
    // The story the mark tells: the fragments after the break get smaller.
    const tail = parts.slice(1).sort((a, b) => xOf(a) - xOf(b)).map(widthOf);
    check('and the pieces after the break narrow as they go',
      tail.length === 3 && tail[0] > tail[1] && tail[1] > tail[2],
      JSON.stringify(tail));
    check('with nothing relying on opacity to fade',
      !/opacity/.test(inline[0]), inline[0]);
  }

  const tile = boxes(icon).filter(r => /fill="#ffffff"/.test(r) || !/fill=/.test(r));
  check('the favicon draws the same four shapes', tile.length === 4,
    tile.length + ' rects in icon.svg');
  check('and it too fades by size rather than by opacity',
    !/opacity/.test(icon), 'icon.svg uses opacity');
  // A favicon is a tile of its own, so it carries the header's own black.
  check('the favicon tile is the colour of the header',
    /fill="#0d1117"/.test(icon), 'icon.svg background is not the header black');
}

// ---------- every element the code reaches for exists ----------
//
// This is here because its absence shipped a broken build. app.js was still
// wiring a toggle the markup had replaced; el('pane-edit') returned null,
// addEventListener threw on it, and app.js never reached the line that
// assigns window.Blinded — so nothing was wired at all. Every control in the
// review was dead.
//
// A browser test does catch that, loudly, but only if it is run. This costs
// nothing, needs no browser, and fails on the exact mistake: an id in the
// code that is not in the page.
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const code = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const wanted = new Set([
    ...[...code.matchAll(/\bel\('([^']+)'\)/g)].map(m => m[1]),
    ...[...code.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
  ]);
  const missing = [...wanted].filter(id => !ids.has(id));
  check('the page has every element app.js reaches for by name',
    missing.length === 0, 'missing from index.html: ' + missing.join(', '));

  // And the same for the ids the stylesheet targets, which fail quietly
  // rather than loudly: a rule for an element that no longer exists simply
  // never applies.
  const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8')
    // Colour literals are spelled the same way as id selectors and are not
    // ids: #fff is a white, not an element.
    .replace(/#[0-9a-fA-F]{3,8}\b/g, '');
  const styled = new Set([...css.matchAll(/#([A-Za-z][\w-]*)/g)].map(m => m[1]));
  const orphans = [...styled].filter(id => !ids.has(id));
  check('and every element the stylesheet targets by id',
    orphans.length === 0, 'styled but absent: ' + orphans.join(', '));

  // The same mistake one level up. window.Blinded is built from a list of
  // bare identifiers, and renaming a function without renaming its entry
  // throws a ReferenceError on the very last statement of app.js — so the
  // object is never assigned and, again, every control in the review is dead.
  // This shipped once as el('pane-edit') and was written a second time this
  // way, by leaving `sensitivity` in the list after the function became
  // sensFor. The declarations are found by name, which is enough: what is
  // being caught is a name in the list that app.js does not define at all.
  const exported = code.match(/window\.Blinded = \{([\s\S]*?)\};\s*\n\}\)\(\);/);
  check('app.js publishes an object to hang the tests off', Boolean(exported),
    'window.Blinded assignment not found');
  if (exported) {
    const declared = new Set([
      ...[...code.matchAll(/\bfunction ([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
      ...[...code.matchAll(/\b(?:const|let|var) ([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
    ]);
    const listed = exported[1]
      .replace(/\/\/[^\n]*/g, '')
      .split(',')
      .map(part => part.trim())
      // For `alias: name` it is the value that has to exist, not the key.
      .map(part => (part.includes(':') ? part.split(':')[1].trim() : part))
      .filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
    check('and every name in that list is something app.js defines',
      listed.every(name => declared.has(name)),
      'not defined: ' + listed.filter(name => !declared.has(name)).join(', '));
  }

  // The same mistake one level down: two things at the top of the module
  // given the same name. app.js is one long IIFE, so a duplicate `const` is
  // not a local problem — it is a SyntaxError that stops the whole file
  // parsing, window.Blinded is never assigned, and every control in the
  // review is dead. Exactly the symptom as the two above, from a third cause.
  //
  // Written by adding a CREEP_EDGE for the drag that was called EDGE, next to
  // a swipe threshold three thousand lines away that was already called EDGE.
  // Neither name was wrong; they were only both there.
  //
  // Module-level declarations are the ones indented by two spaces, which is
  // everything directly inside the IIFE and nothing nested within a function.
  {
    const seen = new Map();
    const twice = [];
    for (const line of code.split('\n')) {
      const found = line.match(/^ {2}(?:const|let) ([A-Za-z_$][\w$]*)\s*=/);
      if (!found) continue;
      const name = found[1];
      if (seen.has(name)) twice.push(name); else seen.set(name, true);
    }
    check('nothing at the top of app.js is declared twice',
      twice.length === 0, 'declared more than once: ' + twice.join(', '));
  }
}

// ---------- the scale ladder ----------
//
// Measured on a real deck: the same lockup on two pages at 142x24 and 163x27,
// a scale of 1.12 that fell between the old rungs at 1.0 and 1.25. The
// nominating pass scored the true position 0.29 and 0.35 there, under the 0.4
// it takes to be proposed at all, so the copy was never offered for
// refinement and the search reported one match where there were two. These
// guard the shape of the ladder rather than the matcher's arithmetic, which
// is what broke.
{
  const scales = Match.SCALES;
  check('the ladder is built outwards from exactly 1', scales.includes(1));
  check('and rises', scales.every((s, i) => i === 0 || s > scales[i - 1]));
  check('reaching a fifth of the picked size and four times it',
    scales[0] <= 0.25 && scales[scales.length - 1] >= 3.8,
    scales[0] + ' to ' + scales[scales.length - 1]);

  // Where the copies are: same-size, or one step of a designer's hand away.
  // A step of s misplaces the far end of the template by s of its width, so a
  // wide wordmark is punished hardest — and a wordmark is the commonest logo
  // there is.
  const inBand = scales.filter(s => s >= 0.7 && s <= 1.6);
  const steps = inBand.slice(1).map((s, i) => s / inBand[i]);
  check('with rungs close together around it',
    steps.every(step => step <= 1.09), JSON.stringify(steps.map(s => s.toFixed(3))));
  check('and eight or more of them', inBand.length >= 8, String(inBand.length));

  // Out on the tails the old spacing stands: a logo at a fifth or triple the
  // size it was picked at is rare, and finding it at all matters more than
  // scoring it precisely. Without this the ladder would grow without limit.
  check('but not out on the tails, which would cost without buying anything',
    scales.length <= 26, String(scales.length));
}

// ---------- how the canonical copy is served ----------
//
// The app's promise is about one deployment now. It was served from two —
// Render and GitHub Pages — which is one program on two origins, each with
// its own response headers, and the Pages one sent Access-Control-Allow-Origin
// for everything and said nothing at all about framing. Pages is off; these
// guards are here so the remaining copy does not quietly lose the headers
// that a page cannot state about itself.
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const code = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const deploy = existsSync(join(root, 'render.yaml'))
    ? readFileSync(join(root, 'render.yaml'), 'utf8') : '';

  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/);
  check('the page says which copy is the canonical one', Boolean(canonical),
    'no rel="canonical" in index.html');
  // The refusal page offers a way out, and it has to lead to the same place.
  if (canonical) {
    check('and the frame refusal sends people to that same address',
      code.includes(canonical[1]), canonical[1]);
  }

  check('the deployment carries its own headers', deploy.length > 0,
    'render.yaml is missing');
  // frame-ancestors is the one directive a meta policy cannot carry, so it is
  // the one that can go missing without anything in the page noticing.
  check('including frame-ancestors, which a meta policy cannot express',
    /frame-ancestors 'none'/.test(deploy), 'not in render.yaml');
  check('and X-Frame-Options for browsers that do not read it',
    /X-Frame-Options[\s\S]{0,40}DENY/.test(deploy), 'not in render.yaml');
  check('and a referrer policy, since a file name can be the whole story',
    /Referrer-Policy[\s\S]{0,40}no-referrer/.test(deploy), 'not in render.yaml');

  // Two copies of one policy drift. The header's job is to add
  // frame-ancestors, not to disagree about what the page may reach.
  const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  check('the page still carries a policy of its own', Boolean(meta));
  if (meta && deploy) {
    const directives = meta[1].split(';').map(d => d.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const flat = deploy.replace(/\s+/g, ' ');
    const adrift = directives.filter(d => !flat.includes(d));
    check('and the header repeats it rather than contradicting it',
      adrift.length === 0, 'in the page but not in render.yaml: ' + adrift.join(' | '));
  }

  // The app refuses to run framed whatever the headers say, because a header
  // is a promise about a deployment and this is a promise about the program.
  check('and the program refuses to run in a frame on its own account',
    /window\.top !== window\.self/.test(code), 'no frame guard in app.js');
}

// ---------- what a draft is, said accurately ----------
//
// A draft holds no page of the document, which is the point of it. It does
// hold the words typed to be covered, the notes written on a page and the
// file's own name — which is to say a short list of the most sensitive
// strings in the document with the document taken away. The copy used to call
// that "nothing confidential".
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const code = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const overclaims = [['index.html', html], ['app.js', code], ['README.md', readme]]
    .filter(([, text]) => /carries nothing confidential|nothing confidential/.test(text))
    .map(([name]) => name);
  check('nothing claims a draft carries nothing confidential',
    overclaims.length === 0, 'still claimed in: ' + overclaims.join(', '));
  check('and the draft prompt says to keep it as carefully as the document',
    /Keep it as carefully as the document/.test(html));
}

// ---------- the licence it claims to have ----------
{
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const licence = existsSync(join(root, 'LICENSE'))
    ? readFileSync(join(root, 'LICENSE'), 'utf8') : '';
  // The FAQ calls it free and open source. Without a licence file that is a
  // claim nobody can act on: the default is all rights reserved.
  check('the page calls it open source', /free and open source/.test(html));
  check('so there is a licence to read', licence.length > 0, 'LICENSE is missing');
  check('and the README names it', /MIT, in `LICENSE`/.test(readme));
}

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
