// Builds a small PDF that actually contains text, so the tests can prove that
// the exported file no longer does.
//
// Deliberately not built with Blackbar's own writer: that one only makes
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
export const LOGO_PLACEMENTS = [
  { page: 1, x: 70, y: 690, size: 60 },
  { page: 1, x: 400, y: 690, size: 60 },
  { page: 1, x: 90, y: 300, size: 36 },   // same mark, smaller
  { page: 2, x: 70, y: 690, size: 60 },
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
