// Rule-based detectors that propose spans of a document for redaction.
//
// Every detector here is a *proposal*. Nothing in this file removes anything;
// it hands the reviewer a list of candidate spans and the reviewer decides.
// That division is deliberate. A redactor that silently trusts a regex is a
// redactor that silently misses things, and the failure is invisible until the
// document is already public.
//
// Two rules govern what may live in this file:
//
//   1. A detector must stand on its own. Everything it proposes is acted on
//      the moment its box is ticked, so there is no low-confidence tier to
//      hide a loose pattern behind. A rule that needs a shrug next to it does
//      not belong here; it belongs in the terms box, typed by the reviewer.
//   2. Precision beats recall, because recall has a backstop and precision
//      does not. A missed span can still be caught by eye in the review pass;
//      a list padded with hundreds of false positives trains the reviewer to
//      approve everything, which loses both.
//
// Confidence is 'high' when a detector anchored on something structural — a
// keyword, a country name, a notation that means nothing else — and 'medium'
// when it matched shape alone. It no longer gates anything; it orders
// overlaps, so that the better-founded of two competing spans wins.
//
// Anything genuinely shaped like a number and nothing else — a card number, a
// bank account, an IP address — was taken out. Those are engineering data and
// consumer data; this tool is pointed at deal documents, where they do not
// appear and their patterns only added noise to a list that has to stay short
// enough to read.
(function (root) {
  'use strict';

  // ---------- helpers ----------

  // Runs a regex over the text and yields matches with absolute offsets. The
  // regex must be global; it is cloned so a detector table can be reused
  // across documents without lastIndex leaking between runs.
  function* scan(text, re) {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (m[0] === '') { rx.lastIndex++; continue; }
      yield m;
    }
  }

  // ---------- detectors ----------
  //
  // Each entry: { kind, label, hint, find(text) -> [{start, end, confidence}] }
  // `hint` is what the review UI shows to explain why a span was proposed.

  const DETECTORS = [
    {
      kind: 'email',
      label: 'Email addresses',
      hint: 'A local part, an @, and a domain with a dotted suffix.',
      find(text) {
        const out = [];
        for (const m of scan(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        return out;
      },
    },
    {
      kind: 'phone',
      label: 'Phone numbers',
      hint: 'A dialable number: E.164, or a North American number with separators.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){1,4}\b/g)) {
          const digits = m[0].replace(/\D/g, '');
          if (digits.length >= 8 && digits.length <= 15) {
            out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
          }
        }
        // A parenthesised area code cannot be anchored with \b — the paren is
        // not a word character, so there is no boundary in front of it.
        for (const m of scan(text, /(?:\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4})\b/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        // Ten bare digits, or a 3-3-4 spaced group, are shape-only.
        for (const m of scan(text, /\b\d{3}\s\d{3}\s\d{4}\b/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'medium' });
        }
        return out;
      },
    },
    {
      kind: 'url',
      label: 'Web addresses',
      hint: 'An http(s) URL. Query strings often carry tokens and identifiers.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\bhttps?:\/\/[^\s<>"')\]]+/g)) {
          // Trailing punctuation belongs to the sentence, not the URL.
          const trimmed = m[0].replace(/[.,;:!?]+$/, '');
          out.push({ start: m.index, end: m.index + trimmed.length, confidence: 'high' });
        }
        return out;
      },
    },
    {
      kind: 'address',
      label: 'Street addresses',
      hint: 'A street line: a numbered street, a Singapore or Malaysian unit, a Hong Kong floor, or a Vietnamese street or ward.',
      find(text) {
        const out = [];
        const add = (m, confidence) => out.push({
          start: m.index, end: m.index + m[0].length, confidence,
        });
        // For patterns that have to consume the character in front of a word
        // to know where the word begins: group 1 is that character, and the
        // span starts after it.
        const after = (m, confidence) => out.push({
          start: m.index + m[1].length, end: m.index + m[0].length, confidence,
        });

        // The anglophone shape: a house number, a street name, a street type.
        //
        // The last dozen types are the ones that make this work in Singapore,
        // Hong Kong and Malaysia — Robinson Quay, Anson Rise, Marina Link,
        // Cairnhill Circle. They cost nothing in a London or New York document
        // and are the difference between finding a Singapore address and not.
        //
        // At least one capitalised word is required between the number and the
        // type. Without it "2020 Park" is an address, and a deal document is
        // full of years next to capitalised nouns.
        const types = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr'
          + '|Court|Ct|Place|Pl|Terrace|Ter|Way|Circle|Cir|Parkway|Pkwy|Highway|Hwy'
          + '|Crescent|Cres|Quay|Rise|Walk|Link|Close|Loop|Path|Green|Gate|Hill|View';
        const re = new RegExp(
          '\\b\\d{1,6}[A-Za-z]?\\s+(?:[A-Z][A-Za-z.\'-]*\\s+){1,4}(?:' + types + ')\\b\\.?', 'g');
        for (const m of scan(text, re)) add(m, 'medium');

        // Singapore and Malaysia write the unit as #floor-unit, and nothing
        // else in a document looks like that. #12-34, #B1-07, #03-115A.
        for (const m of scan(text, /#\s?[A-Z]{0,2}\d{1,3}-\d{1,4}[A-Za-z]?\b/g)) {
          add(m, 'high');
        }

        // The block number that usually precedes it. "Blk" is unambiguous;
        // "Block" is an ordinary English word, so it is only taken when a
        // letter-suffixed or four-digit block number follows, which prose
        // does not produce.
        for (const m of scan(text, /\bBlk\.?\s?\d{1,4}[A-Za-z]?\b/gi)) add(m, 'high');
        for (const m of scan(text, /\bBlock\s\d{1,4}[A-Za-z]\b/g)) add(m, 'medium');

        // Jalan, Lorong and their abbreviations put the street type first, so
        // the anglophone pattern above cannot see them at all.
        for (const m of scan(text,
          /\b(?:Jalan|Jln\.?|Lorong|Lrg\.?)\s+[A-Z0-9][\w'-]*(?:\s+[A-Z0-9][\w'-]*){0,3}/g)) {
          add(m, 'high');
        }

        // Hong Kong has no postcodes; the floor does the work instead, and
        // "12/F" or "G/F" means one thing only. Room and Flat numbers are
        // taken with it so the whole unit goes, not half of it.
        //
        // The lettered floors are matched case-sensitively and the list is
        // short on purpose. Written loosely it also matches "M/F", which in a
        // document with a headcount table is male and female, not a mezzanine.
        const unit = '(?:(?:Room|Rm\\.?|Flat|Unit|Suite|Ste\\.?)\\s+[A-Z0-9][A-Z0-9-]{0,6},?\\s*)?';
        for (const m of scan(text, new RegExp(unit + '\\d{1,3}\\/F\\b', 'gi'))) add(m, 'high');
        for (const m of scan(text, new RegExp(unit + '(?:UG|LG|G|B\\d?)\\/F\\b', 'g'))) add(m, 'high');

        // Vietnamese addresses lead with the street word — Đường Lê Lợi — and
        // end with the ward and district. Both accented and unaccented
        // spellings appear, sometimes in the same document; each is only taken
        // when a capitalised name or a number follows, which is what keeps
        // "pho" the soup out of it.
        //
        // \b cannot see the edge of a word that starts with Đ or Ph — it only
        // knows ASCII letters, so there is no boundary between a space and a
        // "Đ" at all. The character in front is consumed instead and stepped
        // over, the same trick findTerms uses, and for the same reason.
        const vnName = "(?:\\p{Lu}[\\p{L}\\p{M}'-]*|\\d{1,4})";
        const edge = '(^|[^\\p{L}\\p{M}])';
        for (const m of scan(text, new RegExp(
          edge + '(?:Đường|Duong|Phố|Ngõ|Ngách|Ngach|Hẻm|Hem)\\s+'
          + vnName + '(?:\\s+' + vnName + '){0,3}', 'gu'))) {
          after(m, 'high');
        }
        for (const m of scan(text, new RegExp(
          edge + '(?:Quận|Quan|Phường|Phuong|Huyện|Huyen|Thị trấn|Thi tran|Xã|Xa)\\s+'
          + vnName + '(?:\\s+' + vnName + '){0,2}', 'gu'))) {
          after(m, 'high');
        }

        return out;
      },
    },
    {
      kind: 'postcode',
      label: 'Postal codes',
      hint: 'A postal code anchored on something: a US state, a UK format, or the name of the country.',
      find(text) {
        const out = [];
        const add = (m, confidence) => out.push({
          start: m.index, end: m.index + m[0].length, confidence,
        });
        // Several of these need a word in front to know what they are looking
        // at, but the word itself is context, not a secret — covering "ZIP" or
        // "Singapore" tells a later reader nothing and costs them the sentence.
        // So the anchor is matched in group 1 and then stepped over.
        const after = (m, confidence) => out.push({
          start: m.index + m[1].length, end: m.index + m[0].length, confidence,
        });

        // A bare five-digit number is not a ZIP code. It is a headcount, a
        // unit price, a year-to-date figure — a deal document is made of
        // them. So the US forms are only taken when something says so: a
        // state abbreviation in front, the word ZIP, or the ZIP+4 shape,
        // which nothing else uses.
        //
        // The state has to arrive the way a state arrives — after a comma or
        // at the start of a line, as in "Mountain View, CA 94043". Half of
        // these abbreviations are also English words in capitals (IN, OR, OK,
        // HI, ME, LA), and a slide heading is capitals all the way across:
        // "REVENUE IN 12345" is not an address.
        const STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD'
          + '|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX'
          + '|UT|VT|VA|WA|WV|WI|WY|DC|PR';
        for (const m of scan(text, new RegExp(
          '((?:^|[,\\n])\\s*(?:' + STATES + ')\\s+)\\d{5}(?:-\\d{4})?\\b', 'g'))) {
          after(m, 'high');
        }
        for (const m of scan(text, /\b(ZIP(?:\s+code)?\s*:?\s*)\d{5}(?:-\d{4})?\b/gi)) after(m, 'high');
        for (const m of scan(text, /\b\d{5}-\d{4}\b/g)) add(m, 'medium');

        // The UK format carries its own structure and needs no anchor.
        for (const m of scan(text, /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g)) add(m, 'medium');

        // Singapore's is six digits, which on its own is just a number, so it
        // is taken from the two places it is actually written: after the
        // country name, or in the S(......) form.
        for (const m of scan(text, /\b(Singapore\s*\(?S?\)?[\s,]*)\d{6}\b/gi)) after(m, 'high');
        for (const m of scan(text, /\bS\s?\(\s?(\d{6})\s?\)/g)) {
          out.push({ start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + m[1].length, confidence: 'high' });
        }

        // Vietnam's is five or six digits and sits next to the country name,
        // on one side of it or the other.
        for (const m of scan(text, /\b(?:Vi[eệ]t\s?Nam|Vietnam)[\s,]*(\d{5,6})\b/gi)) {
          out.push({ start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].length, confidence: 'high' });
        }
        for (const m of scan(text, /\b(\d{5,6})[\s,]+(?:Vi[eệ]t\s?Nam|Vietnam)\b/gi)) {
          out.push({ start: m.index, end: m.index + m[1].length, confidence: 'high' });
        }

        // Hong Kong has no postal code at all — nothing to look for. Its
        // addresses are caught by the floor and unit notation instead, in the
        // street-address detector above.

        return out;
      },
    },
    {
      kind: 'dob',
      label: 'Dates of birth',
      hint: 'A date introduced by a birth-date keyword.',
      find(text) {
        const out = [];
        const re = /\b(?:d\.?o\.?b\.?|date of birth|born(?:\s+on)?)\b\s*[:.]?\s*(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})/gi;
        for (const m of scan(text, re)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        return out;
      },
    },
  ];

  // ---------- custom terms ----------

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // A term, as a pattern that survives however the document was typeset.
  //
  // Whitespace is allowed between the characters of a word, because a PDF is
  // free to draw a word as separate positioned glyphs and frequently does. A
  // heading set with letter-spacing — the styled box header on a slide, say —
  // reaches us from pdf.js as the items "K", " ", "A", " ", "G": the spaces are
  // not in the document, they are pdf.js's rendering of the gaps. Matching
  // "KAG" literally then finds the word everywhere it is set plainly and
  // misses it wherever a designer touched it, which is the least helpful
  // possible failure and a silent one.
  //
  // Where the term itself has a space, at least one space is required, so
  // "Jane Doe" cannot match "JaneDoe".
  function termPattern(term) {
    let out = '';
    for (let i = 0; i < term.length; i++) {
      if (/\s/.test(term[i])) {
        out += '\\s+';
        while (i + 1 < term.length && /\s/.test(term[i + 1])) i++;
        continue;
      }
      out += escapeRegex(term[i]);
      // Optional whitespace before the next character, unless that character
      // is itself a space, which has already been handled.
      if (i + 1 < term.length && !/\s/.test(term[i + 1])) out += '\\s*';
    }
    return out;
  }

  // Literal terms the reviewer typed — usually names, which no rule can find
  // reliably. Matched whole-word and case-insensitively, longest first so
  // "Jane Doe" wins over "Jane".
  function findTerms(text, terms) {
    const out = [];
    const cleaned = terms.map(t => t.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const term of cleaned) {
      // A word boundary that understands what a PDF's text layer looks like.
      //
      // \b treats letters and digits as one class, so a word with a stray
      // number stuck to its front is not at a boundary at all. Measured on a
      // deck whose only text was "54Tokenomics Digital Tech Co." — the 54 is
      // a slide number the exporter ran into the next run — where typing the
      // company's name found nothing, on a page that plainly says it.
      //
      // So the rule is per class rather than per word character: a term that
      // starts with a letter may not follow a letter, and one that starts
      // with a digit may not follow a digit. "art" still does not match
      // inside "start"; "Tokenomics" now matches inside "54Tokenomics".
      //
      // The leading side consumes a character rather than looking behind,
      // because lookbehind is a recent arrival in some browsers and a regex
      // that throws would take the whole search down with it.
      const head = /^[A-Za-z]/.test(term) ? '(^|[^A-Za-z])'
        : /^[0-9]/.test(term) ? '(^|[^0-9])' : '()';
      const tail = /[A-Za-z]$/.test(term) ? '(?![A-Za-z])'
        : /[0-9]$/.test(term) ? '(?![0-9])' : '';
      const re = new RegExp(head + termPattern(term) + tail, 'gi');
      for (const m of scan(text, re)) {
        // termPattern has no groups of its own, so the character the boundary
        // ate is always the first one, and the span starts after it.
        const lead = m[1] ? m[1].length : 0;
        out.push({ kind: 'term', label: 'Terms you listed', hint: 'Matched "' + term + '".', start: m.index + lead, end: m.index + m[0].length, confidence: 'high', term });
      }
    }
    return out;
  }

  // ---------- overlap ----------

  // Findings can overlap: a URL containing an email, an address containing a
  // postcode. Keeping both would let the reviewer reject one and believe the
  // text was covered, so overlapping spans collapse to a single winner —
  // longest first, then higher confidence, then earlier.
  //
  // The one exception is a word the reviewer typed inside a span that was only
  // ever a guess. Measured on "1600 Amphitheatre Parkway" with "Amphitheatre"
  // typed: the address is longer, so it won, and the word the reviewer had
  // explicitly asked for was reported nowhere. The wider span still wins — it
  // covers more ink, which is the point — but it takes the term's identity
  // with it, so the tally counts it and the placeholder names it.
  //
  // Only a medium-confidence span gives way like that. A detector that
  // anchored on something structural knows what it is holding: "jane" inside
  // "jane@example.com" is a name, but the span is an email address, and
  // calling it a person's name in the legend would be simply wrong.
  function resolveOverlaps(findings) {
    const order = { high: 0, medium: 1 };
    const sorted = findings.slice().sort((a, b) => {
      const lenDiff = (b.end - b.start) - (a.end - a.start);
      if (lenDiff !== 0) return lenDiff;
      const confDiff = order[a.confidence] - order[b.confidence];
      if (confDiff !== 0) return confDiff;
      return a.start - b.start;
    });
    const kept = [];
    for (const f of sorted) {
      const over = kept.find(k => f.start < k.end && k.start < f.end);
      if (!over) { kept.push(f); continue; }
      // A swallowed term hands its name to whatever swallowed it, unless that
      // is already a term of its own.
      if (f.kind === 'term' && over.kind !== 'term' && over.confidence === 'medium'
        && over.start <= f.start && f.end <= over.end) {
        over.kind = 'term';
        over.label = f.label;
        over.hint = f.hint;
        over.term = f.term;
        over.confidence = 'high';
      }
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  // ---------- entry point ----------

  // Returns findings sorted by position, each with a stable id so the review
  // UI can keep a decision attached to a span across a re-scan.
  function findAll(text, options) {
    const opts = options || {};
    const enabled = opts.kinds || null;
    const found = [];

    for (const d of DETECTORS) {
      if (enabled && !enabled.includes(d.kind)) continue;
      for (const hit of d.find(text)) {
        found.push({ kind: d.kind, label: d.label, hint: d.hint, ...hit });
      }
    }
    if (opts.terms && opts.terms.length) found.push(...findTerms(text, opts.terms));

    // Anything the caller is going to throw away is thrown away first.
    //
    // Overlaps collapse to a single winner, longest first — so a medium
    // confidence address containing a word the reviewer typed beat the word,
    // and then the caller dropped the address for being medium. Both were
    // gone, and a word somebody had explicitly asked for went uncovered. The
    // count was wrong too, but that was the smaller half of it: a span that
    // will not survive must not be allowed to suppress one that would.
    const keep = typeof opts.accept === 'function' ? opts.accept : null;
    const surviving = keep ? found.filter(keep) : found;

    return resolveOverlaps(surviving).map(f => ({
      ...f,
      id: f.kind + ':' + f.start + ':' + f.end,
      text: text.slice(f.start, f.end),
    }));
  }

  // Applies accepted spans to a string. `style` decides what replaces them:
  //
  //   'block'       keeps the shape with █
  //   'label'       names the kind, e.g. [EMAIL]
  //   'replacement' uses each span's own `replacement`, which is how numbered
  //                 placeholders get in — [PERSON_1] rather than [PERSON]
  //   'remove'      deletes outright
  function applyToText(text, spans, style) {
    const ordered = spans.slice().sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const s of ordered) {
      if (s.start < cursor) continue;
      out += text.slice(cursor, s.start);
      if (style === 'replacement') out += s.replacement === undefined ? '' : String(s.replacement);
      else if (style === 'label') out += '[' + String(s.kind || 'redacted').toUpperCase() + ']';
      else if (style === 'remove') out += '';
      else out += '█'.repeat(Math.max(1, s.end - s.start));
      cursor = s.end;
    }
    return out + text.slice(cursor);
  }

  root.BlindedDetect = {
    findAll, findTerms, termPattern, applyToText, resolveOverlaps,
    DETECTORS,
    KINDS: DETECTORS.map(d => ({ kind: d.kind, label: d.label, hint: d.hint })),
  };
})(typeof window !== 'undefined' ? window : globalThis);
