// Builds a small PDF that actually contains text, so the tests can prove that
// the exported file no longer does.
//
// Deliberately not built with Blinded's own writer: that one only makes
// image-only PDFs, and a test whose input came from the code under test would
// prove nothing about real documents.
const LINES = [
  'CONFIDENTIAL — internal only',
  'Jane Doe can be reached at jane.doe@example.com',
  'or on (415) 555-0132 during office hours.',
  'Card on file 4242 4242 4242 4242, SSN 123-45-6789.',
  'Mailing address: 1600 Amphitheatre Parkway, 94043.',
  'Nothing else on this line is sensitive at all.',
  // A deliberately adversarial line for the box-placement test. Every
  // character before the value is unusually narrow, so estimating positions by
  // dividing the run's width evenly across its characters puts the value far
  // from where it really is. A line of average-width text would hide that
  // error; this one will not.
  'iiiiiiiiiiiiiiiiiiii 4242424242424242',
];

export function buildTextPdf(lines = LINES) {
  const chunks = [];
  let length = 0;
  const offsets = [0];
  const push = s => {
    const b = Buffer.from(s, 'latin1');
    chunks.push(b);
    length += b.length;
  };
  const begin = id => { offsets[id] = length; push(id + ' 0 obj\n'); };

  const escape = s => s.replace(/[\\()]/g, m => '\\' + m);
  const body = 'BT\n/F1 13 Tf\n14 TL\n40 740 Td\n' +
    lines.map(l => '(' + escape(l) + ') Tj T*\n').join('') + 'ET\n';

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\n'); push('endobj\n');
  begin(2); push('<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'); push('endobj\n');
  begin(3);
  push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]' +
    ' /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\n');
  push('endobj\n');
  begin(4);
  push('<< /Length ' + Buffer.byteLength(body, 'latin1') + ' >>\nstream\n' + body + 'endstream\n');
  push('endobj\n');
  begin(5);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
  push('endobj\n');

  const xrefAt = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');

  return Buffer.concat(chunks);
}

// The same text, with one filled rectangle on it.
//
// A page of nothing but text is not read at all now — it has nowhere to hide
// lettering the text layer does not already report — which is correct, and
// makes it useless for testing the reader. This is the smallest page that both
// carries real words and has to be read.
export function buildReadablePdf(lines = LINES) {
  const pdf = buildTextPdf(lines);
  const text = pdf.toString('latin1');
  const open = text.indexOf('stream\n') + 'stream\n'.length;
  const close = text.indexOf('endstream');
  const body = text.slice(open, close);
  // A small grey square, well clear of the words.
  const withMark = body + '0.6 0.6 0.6 rg\n40 60 40 40 re f\n';
  const head = text.slice(0, text.lastIndexOf('<< /Length', open));
  const rest = text.slice(close);
  const rebuilt = head + '<< /Length ' + Buffer.byteLength(withMark, 'latin1')
    + ' >>\nstream\n' + withMark + rest;
  // The xref offsets after the content stream are now wrong. pdf.js recovers
  // by rebuilding the table, which is enough for a fixture; nothing here
  // depends on the file being byte-perfect.
  return Buffer.from(rebuilt, 'latin1');
}

export const FIXTURE_LINES = LINES;


// A two-page PDF with the same vector mark drawn at four places and two sizes,
// plus one deliberately different mark. The image matcher is asked to find the
// four and leave the fifth alone.
//
// The mark is drawn with path operators rather than as an embedded image, on
// purpose: a repeated logo in a real PDF is often vector art, and matching it
// has to work off the rendered pixels rather than off any shared object in the
// file. Nothing here reuses an XObject, so a matcher that cheated by looking
// for repeated image objects would find nothing.
// The sizes are chosen to be awkward on purpose. The first version of the
// matcher swept only 0.6x to 1.75x of the picked size, so a mark at 0.45x or
// 2.2x could not be found at any threshold — which is exactly how it behaved
// on real documents. None of these sizes sits on a round multiple either, so
// the scale ladder never lands on one exactly and refinement has to do its job.
export const LOGO_PLACEMENTS = [
  { page: 1, x: 70, y: 690, size: 60 },     // the one that gets picked
  { page: 1, x: 400, y: 690, size: 64.2 },  // 1.07x — between two rungs
  { page: 1, x: 90, y: 300, size: 27 },     // 0.45x — below the old floor
  { page: 2, x: 70, y: 660, size: 132 },    // 2.2x — above the old ceiling
];

function markPath(x, y, size, decoy) {
  const s = size;
  // A filled square with a notch and a bar: asymmetric in both axes, so a
  // shifted or flipped copy does not correlate with the original.
  const parts = [
    '0 0 0 rg',
    `${x} ${y} ${s} ${s * 0.28} re f`,
    `${x} ${y + s * 0.42} ${s * 0.30} ${s * 0.58} re f`,
  ];
  if (!decoy) parts.push(`${x + s * 0.52} ${y + s * 0.42} ${s * 0.48} ${s * 0.30} re f`);
  else parts.push(`${x + s * 0.30} ${y + s * 0.70} ${s * 0.70} ${s * 0.30} re f`);
  return parts.join('\n') + '\n';
}

export function buildLogoPdf() {
  const chunks = [];
  let length = 0;
  const offsets = [0];
  const push = t => { const b = Buffer.from(t, 'latin1'); chunks.push(b); length += b.length; };
  const begin = id => { offsets[id] = length; push(id + ' 0 obj\n'); };

  const bodies = [1, 2].map(pageNo => {
    let out = 'BT /F1 12 Tf 70 760 Td (Page ' + pageNo + ' of the letterhead sample) Tj ET\n';
    for (const p of LOGO_PLACEMENTS) {
      if (p.page === pageNo) out += markPath(p.x, p.y, p.size, false);
    }
    // The decoy: same ink, different shape, on page 2 only.
    if (pageNo === 2) out += markPath(400, 300, 60, true);
    return out;
  });

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\n'); push('endobj\n');
  begin(2); push('<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>\n'); push('endobj\n');
  begin(3); push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>\n'); push('endobj\n');
  begin(4); push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>\n'); push('endobj\n');
  begin(5); push('<< /Length ' + Buffer.byteLength(bodies[0], 'latin1') + ' >>\nstream\n' + bodies[0] + 'endstream\n'); push('endobj\n');
  begin(6); push('<< /Length ' + Buffer.byteLength(bodies[1], 'latin1') + ' >>\nstream\n' + bodies[1] + 'endstream\n'); push('endobj\n');
  begin(7); push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n'); push('endobj\n');

  const xrefAt = length;
  push('xref\n0 8\n0000000000 65535 f \n');
  for (let id = 1; id <= 7; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  push('trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
  return Buffer.concat(chunks);
}


// A wide wordmark, repeated at four sizes on one page.
//
// This shape is the regression that matters. Sizing a template by its long
// side alone turned a mark like this into a strip one pixel tall, and the
// search then found nothing at all on a document full of them — the single
// most likely cause of "it says 0 found" on a real file. The sizes span 0.46x
// to 1.6x of the picked one, which the original 0.6x-1.75x ladder could not
// cover either.
export const WORDMARK_PLACEMENTS = [
  { x: 70, y: 700, size: 200 },   // picked
  { x: 70, y: 600, size: 92 },    // 0.46x
  { x: 70, y: 480, size: 320 },   // 1.6x
  { x: 70, y: 380, size: 143 },   // 0.715x
];

const WORDMARK_BLOCKS = [
  [0, 0, 26, 14], [32, 4, 18, 10], [56, 0, 14, 14], [76, 4, 30, 10],
  [112, 0, 20, 14], [138, 6, 16, 8], [160, 0, 40, 12],
];
export const WORDMARK_ASPECT = 200 / 14;

export function buildWordmarkPdf() {
  const draw = (x, y, size) => {
    const u = size / 200;
    return ['0 0 0 rg'].concat(
      WORDMARK_BLOCKS.map(([bx, by, bw, bh]) =>
        `${x + bx * u} ${y + by * u} ${bw * u} ${bh * u} re f`)).join('\n') + '\n';
  };

  let body = 'BT /F1 11 Tf 70 750 Td (Wordmark repeated at four sizes) Tj ET\n';
  for (const p of WORDMARK_PLACEMENTS) body += draw(p.x, p.y, p.size);

  const chunks = [];
  let length = 0;
  const offsets = [0];
  const push = t => { const b = Buffer.from(t, 'latin1'); chunks.push(b); length += b.length; };
  const begin = id => { offsets[id] = length; push(id + ' 0 obj\n'); };

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\n'); push('endobj\n');
  begin(2); push('<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'); push('endobj\n');
  begin(3); push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\n'); push('endobj\n');
  begin(4); push('<< /Length ' + Buffer.byteLength(body, 'latin1') + ' >>\nstream\n' + body + 'endstream\n'); push('endobj\n');
  begin(5); push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n'); push('endobj\n');

  const xrefAt = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
  return Buffer.concat(chunks);
}


// A small serif wordmark in a ruled box — the shape of a real company logo on
// a letterhead, and the one that exposed three separate faults at once: a
// scale ladder that never tested 1.0, a sampling stride that stepped over the
// correlation peak of a small template, and a final score taken on a shrunken
// copy where identical marks scored anywhere from 0.74 to 0.98.
//
// All three copies are the same size, so all three sit at scale 1.0 relative
// to whichever one is picked. Anything less than three found means the search
// cannot find a logo identical to the one it was handed.
export const WORDMARK_BOX = { w: 54, h: 30 };
export const SMALL_LOGO_PLACEMENTS = [
  { x: 70, y: 700 },
  { x: 300, y: 700 },
  { x: 70, y: 500 },
];

export function buildSmallLogoPdf() {
  let body = 'BT /F1 11 Tf 70 760 Td (Letterhead with a small wordmark) Tj ET\n';
  for (const p of SMALL_LOGO_PLACEMENTS) {
    body += `0.15 0.2 0.45 rg\nBT /F2 20 Tf ${p.x} ${p.y} Td (BDA) Tj ET\n`
      + `0.15 0.2 0.45 RG 1 w\n${p.x - 5} ${p.y - 6} ${WORDMARK_BOX.w} ${WORDMARK_BOX.h} re S\n`;
  }

  const chunks = [];
  let length = 0;
  const offsets = [0];
  const push = t => { const b = Buffer.from(t, 'latin1'); chunks.push(b); length += b.length; };
  const begin = id => { offsets[id] = length; push(id + ' 0 obj\n'); };

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\n'); push('endobj\n');
  begin(2); push('<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'); push('endobj\n');
  begin(3); push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]'
    + ' /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>\n'); push('endobj\n');
  begin(4); push('<< /Length ' + Buffer.byteLength(body, 'latin1') + ' >>\nstream\n' + body + 'endstream\n'); push('endobj\n');
  begin(5); push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n'); push('endobj\n');
  begin(6); push('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>\n'); push('endobj\n');

  const xrefAt = length;
  push('xref\n0 7\n0000000000 65535 f \n');
  for (let id = 1; id <= 6; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  push('trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
  return Buffer.concat(chunks);
}


// A word set large enough as real text that the picture search recognises it
// too — which is the whole point of the fixture.
//
// At the small sizes of the other text fixture the picture search finds
// nothing, so a duplicate never arises and a test of duplicate suppression
// passes without testing anything. Set at 28pt, both routes find it and the
// duplicate is real.
export const DOUBLE_TERM = 'KAG';

export function buildDoubleFoundPdf() {
  const body = 'BT /F1 28 Tf 70 700 Td (KAG is a company) Tj ET\n'
    + 'BT /F1 28 Tf 70 640 Td (and KAG again here) Tj ET\n';

  const chunks = [];
  let length = 0;
  const offsets = [0];
  const push = t => { const b = Buffer.from(t, 'latin1'); chunks.push(b); length += b.length; };
  const begin = id => { offsets[id] = length; push(id + ' 0 obj\n'); };

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\n'); push('endobj\n');
  begin(2); push('<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'); push('endobj\n');
  begin(3); push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]'
    + ' /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\n'); push('endobj\n');
  begin(4); push('<< /Length ' + Buffer.byteLength(body, 'latin1') + ' >>\nstream\n' + body + 'endstream\n'); push('endobj\n');
  begin(5); push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n'); push('endobj\n');

  const xrefAt = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
  return Buffer.concat(chunks);
}


// A one-page PDF where the same word appears three times: twice set plainly,
// and once with the letters tracked apart the way a designed slide sets a
// styled header. The tracking is done with a TJ array carrying a large
// negative offset between glyphs, which is what a layout tool emits — and
// which makes pdf.js hand back "K", " ", "A", " ", "G" as separate text
// items with spaces standing in for the gaps. A redactor that matched the
// term literally covered the first two and left the third in plain sight.
export function buildTrackedPdf(word = 'KAG') {
  const chunks = [];
  let length = 0;
  const offsets = [0];
  const push = s => {
    const b = Buffer.from(s, 'latin1');
    chunks.push(b);
    length += b.length;
  };
  const begin = id => { offsets[id] = length; push(id + ' 0 obj\n'); };
  const escape = s => s.replace(/[\\()]/g, m => '\\' + m);

  // -420 thousandths of an em between glyphs: wide enough that pdf.js reads
  // the gaps as spaces, which is exactly the case that used to be missed.
  const tracked = word
    .split('')
    .map(ch => '(' + escape(ch) + ') -420')
    .join(' ');

  const body =
    'BT\n/F1 18 Tf\n40 TL\n60 700 Td\n' +
    '(' + escape(word + ' engages each account') + ') Tj T*\n' +
    '(' + escape(word + '’s value') + ') Tj T*\n' +
    '[' + tracked + ' (’s value)] TJ\n' +
    'ET\n';

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\n'); push('endobj\n');
  begin(2); push('<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'); push('endobj\n');
  begin(3);
  push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]' +
    ' /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\n');
  push('endobj\n');
  begin(4);
  push('<< /Length ' + Buffer.byteLength(body, 'latin1') + ' >>\nstream\n' + body + 'endstream\n');
  push('endobj\n');
  begin(5);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
  push('endobj\n');

  const xrefAt = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');

  return Buffer.concat(chunks);
}

// A genuinely password-protected PDF, so the locked-file path is tested
// against real encryption rather than a mocked exception.
//
// Standard security handler, revision 2 (RC4, 40-bit). Old and weak, which is
// exactly why it is right here: it is what a document produced by an office
// suite a decade ago carries, it is the cheapest thing to implement correctly
// from the specification, and pdf.js opens it the same way it opens any other
// encrypted file. What is under test is Blinded asking for the password and
// carrying on, not the strength of the cipher.
import { createHash } from 'crypto';

// The 32-byte string every PDF password is padded with, from the spec.
const PAD = Buffer.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56,
  0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

function padded(password) {
  const bytes = Buffer.from(password, 'latin1');
  return Buffer.concat([bytes, PAD]).subarray(0, 32);
}

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

export function buildLockedPdf(password = 'letmein', lines) {
  const id = Buffer.from('0123456789abcdef', 'latin1');   // 16 bytes, fixed
  const permissions = -1;                                  // allow everything
  const owner = padded(password);                          // same as the user's

  // /O: the user password padded, RC4'd with a key from the owner password.
  const ownerKey = createHash('md5').update(owner).digest().subarray(0, 5);
  const O = rc4(ownerKey, padded(password));

  // The file key, and /U from it.
  const perm = Buffer.alloc(4);
  perm.writeInt32LE(permissions, 0);
  const fileKey = createHash('md5')
    .update(padded(password)).update(O).update(perm).update(id)
    .digest().subarray(0, 5);
  const U = rc4(fileKey, PAD);

  // Each object's string and stream data gets its own key.
  const keyFor = (num, gen) => {
    const extra = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255,
                               gen & 255, (gen >> 8) & 255]);
    return createHash('md5').update(Buffer.concat([fileKey, extra]))
      .digest().subarray(0, Math.min(16, fileKey.length + 5));
  };

  const escape = s => s.replace(/[\\()]/g, m => '\\' + m);
  const text = (lines || [
    'CONFIDENTIAL — locked document',
    'Jane Doe can be reached at jane.doe@example.com',
    'This file needed a password to open.',
  ]);
  const body = 'BT\n/F1 13 Tf\n16 TL\n40 740 Td\n'
    + text.map(l => '(' + escape(l) + ') Tj T*\n').join('') + 'ET\n';
  const stream = rc4(keyFor(4, 0), Buffer.from(body, 'latin1'));

  const chunks = [];
  let length = 0;
  const offsets = [0];
  const push = s => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
    chunks.push(b);
    length += b.length;
  };
  const begin = n => { offsets[n] = length; push(n + ' 0 obj\n'); };
  const hex = b => '<' + b.toString('hex') + '>';

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\n'); push('endobj\n');
  begin(2); push('<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'); push('endobj\n');
  begin(3);
  push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]'
    + ' /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\n');
  push('endobj\n');
  begin(4);
  push('<< /Length ' + stream.length + ' >>\nstream\n');
  push(stream);
  push('\nendstream\n');
  push('endobj\n');
  begin(5);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
  push('endobj\n');
  begin(6);
  push('<< /Filter /Standard /V 1 /R 2 /Length 40 /P ' + permissions
    + ' /O ' + hex(O) + ' /U ' + hex(U) + ' >>\n');
  push('endobj\n');

  const xrefAt = length;
  push('xref\n0 7\n0000000000 65535 f \n');
  for (let n = 1; n <= 6; n++) push(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
  push('trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [' + hex(id) + ' ' + hex(id)
    + '] >>\nstartxref\n' + xrefAt + '\n%%EOF\n');

  return Buffer.concat(chunks);
}
