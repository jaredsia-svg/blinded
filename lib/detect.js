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
// bank account, an IP address, a postal code, a date of birth — was taken
// out. Those are engineering data and
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

  // An address is a line, not a word.
  //
  // Measured on a contact slide: "115 Nguyen Hue, Sai Gon Ward, HCMC,
  // Vietnam". Every pattern above found nothing in it — there is no street
  // type after "Nguyen Hue", because Vietnamese addresses often omit the word
  // for "street" altogether, and "HCMC" and "Vietnam" are not addresses on
  // their own. One piece of that line is recognisable ("Sai Gon Ward"), and
  // covering only that piece would have left the street and the city in plain
  // sight, which is worse than useless: it looks like the address was handled.
  //
  // So a recognised piece reaches out along its own line, taking in the
  // comma-separated fragments either side of it for as long as they look like
  // the rest of an address. Three things keep that from running away:
  //
  //   - the line must be short. An address line is; a sentence is not.
  //   - each fragment must be short, start with a capital or a digit, and
  //     carry none of the punctuation that belongs to prose.
  //   - the whole thing is bounded, so one bad fragment cannot swallow a
  //     paragraph.
  const LINE_WORDS = 14;
  const PART_WORDS = 6;
  const PART_CHARS = 40;
  const SPAN_CHARS = 160;

  function addressPart(piece) {
    const t = piece.trim();
    if (!t || t.length > PART_CHARS) return false;
    if (/[:;()[\]]/.test(t)) return false;
    if (t.split(/\s+/).length > PART_WORDS) return false;
    return /^[\p{Lu}\d#]/u.test(t);
  }

  // Which line an offset falls on, counted by newlines before it.
  function lineOf(text, at) {
    let line = 0;
    for (let i = 0; i < at && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
  }

  // Drops the pieces that are only addresses in company. Measured on the
  // sentence "Acquired Sun Wah Tower, Bitexco, Landmark 81, and other assets
  // in 2023": "Acquired Sun Wah Tower" fills its fragment, because the verb in
  // front of it is capitalised like a name, and the whole line came back as an
  // address. Nothing else on it or beside it is an address, and that is the
  // difference — on the contact slide the line above the building carries a
  // street and a ward.
  function keepAccompanied(text, spans) {
    const strong = spans.filter(s => !s.weak).map(s => lineOf(text, s.start));
    if (!strong.length) return spans.filter(s => !s.weak);
    return spans.filter(s => {
      if (!s.weak) return true;
      const line = lineOf(text, s.start);
      return strong.some(other => Math.abs(other - line) <= 1);
    }).map(({ weak, ...rest }) => rest);
  }

  function stretchAcrossLine(text, span) {
    const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
    let lineEnd = text.indexOf('\n', span.end);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    if (line.trim().split(/\s+/).length > LINE_WORDS) return span;

    const parts = [];
    let at = 0;
    for (const piece of line.split(',')) {
      parts.push({ start: lineStart + at, end: lineStart + at + piece.length, piece });
      at += piece.length + 1;
    }

    let first = parts.findIndex(p => p.end > span.start);
    let last = parts.findIndex(p => p.start >= span.end);
    last = last === -1 ? parts.length - 1 : Math.max(first, last - 1);
    if (first < 0) return span;
    // The fragment the match sits in has to look like part of an address
    // before anything is added to it. Without this the seed drags its own
    // sentence along: "Revenue, EBITDA and Margin all rose in the 3rd Floor
    // refurbishment programme" is a short enough line, and "3rd Floor" is a
    // real pattern, but the fragment around it is prose and the whole line
    // came back as an address.
    for (let i = first; i <= last; i++) if (!addressPart(parts[i].piece)) return span;

    while (first > 0 && addressPart(parts[first - 1].piece)) first--;
    while (last < parts.length - 1 && addressPart(parts[last + 1].piece)) last++;

    let start = Math.min(span.start, parts[first].start);
    let end = Math.max(span.end, parts[last].end);
    // Leading and trailing space belongs to the line, not to the address, and
    // a bar drawn over it is a bar that starts in the wrong place.
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /[\s,]/.test(text[end - 1])) end--;
    if (end - start > SPAN_CHARS) return span;
    return { ...span, start, end };
  }

  // ---------- names, found by where they sit ----------
  //
  // No rule finds a name by looking at it. A name is capitalised words, and a
  // deal document is capitalised words: companies, funds, cities, products,
  // deal codenames, the months. A dictionary of common first names does no
  // better and fails in both directions at once — measured against a real
  // contact slide, a first-name list misses "KIM-LAN-DANG" (all capitals,
  // hyphenated, not a Western given name) while flagging "Sun Wah Tower" two
  // lines below it, because Sun is a common given name. It would also only
  // ever catch the given name, and half a redacted name is not redacted.
  //
  // What identifies a name is not the word but the company it keeps. Names
  // appear in three layouts, and all three have hard anchors:
  //
  //   a signature block   Yours sincerely, / Name: / By: / /s/
  //   a contact block     the line above a job title, or above T: / E:
  //   a team page         "Jane Doe, Managing Director", either way round
  //
  // So the anchor is the role, the sign-off or the contact line — each of
  // which is unmistakable — and the name is read off its position relative to
  // that. This finds names in Vietnamese, Chinese and English equally, because
  // it never looks at the name itself.

  const ROLE = new RegExp('(?:^|[,\\-–—|(]\\s*|\\s)(?:'
    // Every C-something-O, rather than a hand-picked list of them. Written as
    // a character class it silently omitted CCO, which is how a real chief
    // commercial officer on a real management page went unfound.
    + 'Chief\\s+[A-Za-z]+(?:\\s+[A-Za-z]+)?\\s+Officer|C[A-Z]{1,3}O'
    + '|Chair(?:man|woman|person)?|Vice\\s+Chair(?:man|woman|person)?'
    + '|Vice\\s+President|President|[SEAV]VP|VP'
    + '|(?:Managing|Executive|Finance|Investment|Non-?Executive)\\s+Director|Director'
    + '|(?:Managing|General|Founding)\\s+Partner|Partner'
    + '|Head\\s+of\\s+[A-Z][A-Za-z]*|Global\\s+Head|Group\\s+Head'
    + '|Co-?Founder|Founder|Principal|Associate|Analyst|Manager'
    + '|Company\\s+Secretary|Secretary|Treasurer'
    + '|General\\s+Counsel|Counsel|Solicitor|Barrister|Attorney'
    + '|Advis[eo]r|Consultant|Controller|Trustee'
    + ')(?=$|[,.\\-–—|)]|\\s)', 'i');

  const SIGN_OFF = /\b(?:Yours\s+(?:sincerely|faithfully|truly)|(?:Best|Kind|Warm)\s+regards|Sincerely|Regards)\b/i;
  // "/s/" is the conformed signature a contract carries where a wet signature
  // would go, and it turns up both on its own and after a "By:" label, so the
  // label takes it with it when it is there.
  const SIGN_LABEL = /(?:^|\s)(?:Name|Signed\s+by|Signature|Printed\s+name|By)\s*:(?:\s*\/s\/)?|\/s\//i;
  const CONTACT_LABEL = /^(?:T|M|E|D|F|P|Tel|Mob|Mobile|Cell|Email|E-?mail|Phone|Fax|Direct|DID|Office)\s*[:.]/i;
  const CONTACT_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+\d[\d\s().-]{7,}/;

  // Words that make a line an organisation rather than a person. Without this,
  // "VinaCapital Group" above an email address is a person's name, and the
  // legend then states something that is simply false.
  const NOT_A_PERSON = new RegExp('\\b(?:Ltd|Limited|LLC|LLP|L\\.?P|Inc|Incorporated|Corp'
    + '|Corporation|Pte|Pty|PLC|GmbH|AG|NV|BV|SA|SAS|Co|Company|Group|Holdings?'
    + '|Partners|Capital|Ventures?|Fund|Funds|Advisors?|Advisers?|Associates'
    + '|Bank|Securities|Asset|Management|Investments?|Equity|Trust|Foundation'
    + '|Institute|University|College|School|Committee|Board|Team|Department'
    + '|Division|Office|Branch|Tower|Building|Plaza|Centre|Center|Confidential'
    // Places. "Ho Chi Minh City" over a phone line is a contact block, but the
    // line above the phone is the city, not the person.
    + '|City|Province|District|Ward|Town|Village|Street|Road|Avenue|Lane|Floor'
    + '|Level|Vietnam|Singapore|Malaysia|Indonesia|Thailand|Kong|Kowloon'
    // Countries and markets that brand names glue on ("Yum China"). A person
    // is almost never named that way; a logo page often is.
    + '|China|Chinese|Pacific|Asia|Asian|America|American|Europe|European'
    + '|Japan|Japanese|Korea|Korean|India|Indian|Australia|Australian'
    // Sector and product words that turn up in portfolio logo grids.
    + '|Insurance|Nutrition|Pharmacy|Biotech|Medical|Hospital|Healthcare'
    + '|Consumer|FinTech|Education|Online|Review|Travel|Experiences?'
    + '|Portfolio|Membership|Services|Restaurant|Savings|Postal|Exchange'
    + '|Technology|Technologies|Software|Platform|Solutions?|Provider|Brand'
    // Headings, which are capitalised runs of the right length sitting above
    // whatever comes next on the slide.
    + '|Summary|Overview|Highlights|Introduction|Appendix|Agenda|Contents'
    + '|Disclaimer|Background|Conclusion|Recommendations?|Transaction'
    + '|Financials|Valuation|Projections|Structure|Process|Timetable'
    + ')\\b', 'i');

  const NAME_TOKEN = "\\p{Lu}[\\p{Lu}\\p{Ll}\\p{M}'’.\\-]*";
  const NAME_ONLY = new RegExp('^' + NAME_TOKEN + '(?:\\s+' + NAME_TOKEN + '){0,4}$', 'u');

  // A run of capitalised words, of a length a name comes in, that is not an
  // organisation and not a job title. Two parts at least: one capitalised word
  // is as likely to be a product or a company, and "KIM-LAN-DANG" counts
  // because its parts are joined by hyphens rather than spaces.
  function looksLikeAName(piece) {
    const t = String(piece || '').trim().replace(/[,.;:]+$/, '');
    if (!t || t.length > 48) return false;
    if (!NAME_ONLY.test(t)) return false;
    if (t.split(/[\s\-–]+/).filter(Boolean).length < 2) return false;
    if (NOT_A_PERSON.test(t)) return false;
    if (ROLE.test(t)) return false;
    return true;
  }

  // Splits a line into its comma- and dash-separated pieces, with offsets.
  // "Jane Doe, Managing Director" and "Managing Director – Jane Doe" are the
  // same layout read from either end, so both are handled by looking at the
  // pieces rather than at the order.
  function piecesOf(line, base) {
    const out = [];
    const re = /[^,|–—]+(?:\s-\s[^,|–—]*)?/g;
    let m;
    const parts = line.split(/(,|\||–|—|\s-\s)/);
    let at = 0;
    for (const part of parts) {
      if (!/^(,|\||–|—|\s-\s)$/.test(part)) out.push({ start: base + at, text: part });
      at += part.length;
    }
    return out;
    void re; void m;
  }

  // A job-title line that is short and led by the title.
  //
  // OCR of a logo collage invents long junk lines that happen to contain
  // "Director" or "Advisor". Trusting those as anchors is what marked brand
  // names as people on a portfolio slide. A real title line on a contact
  // block starts with the role and stays short.
  function roleLineIsPlausible(line) {
    const t = String(line || '').trim();
    if (!t || looksLikeAName(t)) return false;
    const m = t.match(ROLE);
    if (!m) return false;
    // Optional bullets / numbering only — anything else before the role is
    // logo-page OCR noise, not a title line.
    const lead = t.slice(0, m.index).replace(/^[\s•\-–—*·\d.]+/, '');
    if (lead.length) return false;
    if (t.length > 60) return false;
    if (t.split(/\s+/).filter(Boolean).length > 6) return false;
    return true;
  }

  // Roles that are enough on their own under OCR. Weaker ones ("Advisor",
  // "Associate") need a contact line nearby, because logo OCR invents them.
  const STRONG_ROLE = /Chief\s+|\bC[A-Z]{1,3}O\b|Chair|President|\b[SEAV]?VP\b|Director|Partner|Founder|Head\s+of/i;

  function findNames(text, options) {
    const opts = options || {};
    // OCR of lettering is noisier than a PDF text layer. The same layouts are
    // accepted, but a job-title anchor has to look like a real title line —
    // not a long OCR dump that happens to include one of the role words.
    const fromOcr = !!opts.fromOcr;
    const out = [];
    const lines = [];
    let at = 0;
    for (const line of text.split('\n')) {
      // Blank lines are not lines.
      //
      // A PDF often gives every run of text its own line, with an empty one
      // between: measured on a real contact page, the layer read "Simon
      // Kavanagh", "", "Partner", "", "skavanagh@…". Looking at the line
      // immediately below a name found nothing but the gap, so not one of the
      // six people on that page was found — every anchor was there, one row
      // further away than the code was looking.
      if (line.trim()) lines.push({ text: line, start: at });
      at += line.length + 1;
    }

    const seen = new Set();
    const take = (piece, start) => {
      const trimmed = String(piece);
      const lead = trimmed.length - trimmed.replace(/^\s+/, '').length;
      const body = trimmed.trim().replace(/[,.;:]+$/, '');
      if (!body) return;
      const from = start + lead;
      const key = from + ':' + body.length;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ start: from, end: from + body.length, confidence: 'high' });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const body = line.text.trim();
      if (!body) continue;

      // A signature label, with the name after it on the same line.
      const label = body.match(SIGN_LABEL);
      if (label) {
        const rest = body.slice(label.index + label[0].length);
        if (looksLikeAName(rest)) {
          take(rest, line.start + line.text.indexOf(body) + label.index + label[0].length);
          continue;
        }
      }

      if (!looksLikeAName(body) && piecesOf(body, 0).every(p => !looksLikeAName(p.text))) continue;

      const above = i > 0 ? lines[i - 1].text.trim() : '';
      const below = i + 1 < lines.length ? lines[i + 1].text.trim() : '';

      // The line under a sign-off or a "Name:" label.
      const signedAbove = SIGN_OFF.test(above) || SIGN_LABEL.test(above);
      // The line over a job title, or over a contact line. This is the contact
      // block on a slide and the entry on a team page alike.
      const contactAt = (line) => CONTACT_LABEL.test(line) || CONTACT_VALUE.test(line);
      const contactBelow = contactAt(below);
      // Under OCR, a weak title ("Advisor") alone is not enough — logo pages
      // invent those words. Strong titles still count; weak ones need a
      // contact line in the next couple of rows, the way a real block reads.
      let roleBelow = fromOcr
        ? roleLineIsPlausible(below)
        : (ROLE.test(below) && !looksLikeAName(below));
      if (fromOcr && roleBelow && !STRONG_ROLE.test(below)) {
        const next = i + 2 < lines.length ? lines[i + 2].text.trim() : '';
        const next2 = i + 3 < lines.length ? lines[i + 3].text.trim() : '';
        roleBelow = contactAt(next) || contactAt(next2);
      }

      if (looksLikeAName(body) && (signedAbove || roleBelow || contactBelow)) {
        take(line.text, line.start);
        continue;
      }

      // "Jane Doe, Managing Director" — one line carrying both, either order.
      const pieces = piecesOf(line.text, line.start);
      if (pieces.length < 2) continue;
      const hasRole = pieces.some(p => {
        if (looksLikeAName(p.text)) return false;
        return fromOcr ? roleLineIsPlausible(p.text) : ROLE.test(p.text);
      });
      if (!hasRole) continue;
      for (const piece of pieces) if (looksLikeAName(piece.text)) take(piece.text, piece.start);
    }

    return out;
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
      hint: 'A number that starts with a + country code (E.164). Local forms without + are skipped — chart labels and bare digit runs look too much like them.',
      find(text) {
        const out = [];
        // Only +country-code forms. North American (415)… / 415-555-… and bare
        // 3-3-4 groups were dropped: OCR of headcount charts and currency+year
        // blobs invented those shapes constantly, and a deal document that
        // wants a local number without + can type it into terms.
        for (const m of scan(text, /\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){1,4}\b/g)) {
          const digits = m[0].replace(/\D/g, '');
          if (digits.length >= 8 && digits.length <= 15) {
            out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
          }
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
        // A building and a floor are not addresses on their own — they are
        // addresses when they sit beside one. Held apart here and kept below
        // only if something unmistakable turned up on the same line or the one
        // either side of it, which is how an address block is laid out.
        const soft = (m, confidence) => out.push({
          start: m.index, end: m.index + m[0].length, confidence, weak: true,
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

        // Some of these patterns name a thing that is part of an address when
        // it is written as one, and part of a sentence otherwise. A building
        // and a floor are both: "17th Floor, Sun Wah Tower," is an address
        // line; "the 3rd Floor refurbishment programme" and "Acquired Sun Wah
        // Tower, Bitexco, Landmark 81" are not, and the second of those is
        // exactly the sentence a deal document is full of.
        //
        // What separates them is not the words but the layout. In an address
        // the piece stands alone between commas; in a sentence it has other
        // words pressed against it. So these patterns are only taken when they
        // fill their whole comma-separated fragment.
        const alone = m => {
          const from = text.lastIndexOf(',', m.index - 1) + 1;
          let to = text.indexOf(',', m.index + m[0].length);
          const stop = text.indexOf('\n', m.index + m[0].length);
          if (to === -1 || (stop !== -1 && stop < to)) to = stop === -1 ? text.length : stop;
          const head = text.lastIndexOf('\n', m.index - 1) + 1;
          return text.slice(Math.max(from, head), to).trim() === m[0].trim();
        };

        // A floor written in words rather than in the Hong Kong notation.
        // "17th Floor" is the commonest way an address in the region names
        // one, and the ordinal is optional because a PDF that sets the "th"
        // as a superscript may or may not put a space in front of it.
        for (const m of scan(text, /\b\d{1,3}\s?(?:st|nd|rd|th)?\s?(?:Floor|Flr\.?|Level)\b/gi)) {
          if (alone(m)) soft(m, 'high');
        }
        for (const m of scan(text, /\b(?:Floor|Level)\s\d{1,3}\b/gi)) { if (alone(m)) soft(m, 'high'); }

        // The building, which in this region is how the reader actually finds
        // the place: Sun Wah Tower, Bitexco Financial Tower, Suntec City.
        for (const m of scan(text,
          /\b(?:[A-Z][\w'-]*\s+){1,3}(?:Tower|Towers|Building|Bldg\.?|Plaza|Centre|Center|Complex|Mansion)\b/g)) {
          if (alone(m)) soft(m, 'medium');
        }

        // Vietnamese administrative divisions written in English, which is how
        // a document in English writes them: "Sai Gon Ward", "District 1".
        for (const m of scan(text,
          /\b(?:[A-Z][\w'-]*\s+){1,3}(?:Ward|District|Commune|Township)\b/g)) {
          if (alone(m)) add(m, 'high');
        }
        for (const m of scan(text, /\b(?:Ward|District)\s\d{1,2}\b/g)) { if (alone(m)) add(m, 'high'); }

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

        return keepAccompanied(text, out).map(span => stretchAcrossLine(text, span));
      },
    },
    {
      kind: 'person',
      label: 'Names of people',
      hint: 'A name read off its position: under a sign-off, over a job title, or beside one.',
      find: findNames,
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
      // Person names take fromOcr so OCR of a logo page can demand a cleaner
      // job-title anchor than a real PDF text layer needs.
      for (const hit of d.find(text, opts)) {
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
