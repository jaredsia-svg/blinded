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
      hint: 'A street line with a postal code after it — global and Asian street types, not country-specific spellings.',
      find(text) {
        const out = [];

        // Street types used worldwide and across Asia (ex-British forms included).
        // Country-specific seeds (Jalan, Lorong, Đường/Duong, Phường, Quận) were
        // removed: they false-positived on brand names ("Chuong Duong") and on
        // ward-only fragments with no deliverable address.
        const types = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr'
          + '|Court|Ct|Place|Pl|Terrace|Ter|Way|Circle|Cir|Parkway|Pkwy|Highway|Hwy'
          + '|Crescent|Cres|Quay|Rise|Walk|Link|Close|Loop|Path|Green|Gate|Hill|View';

        // House/building number + capitalised name + street type.
        // At least one name word between number and type so "2020 Park" is not
        // an address.
        const streetRe = new RegExp(
          '\\b\\d{1,6}[A-Za-z]?\\s+(?:[A-Z][A-Za-z.\\\'-]*\\s+){1,5}(?:' + types + ')\\b\\.?', 'g');

        // Postal / ZIP forms that commonly follow a street line. Alphanumeric
        // UK/CA first; then ZIP+4 / JP; then 5–6 digit (US, SG, MY, CN, …);
        // then 4-digit (AU and similar) that is not a 19xx/20xx year.
        const postalRe = /\b(?:[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|[A-Z]\d[A-Z]\s*\d[A-Z]\d|\d{5}(?:-\d{4})?|\d{3}-\d{4}|\d{6}|(?!19\d{2}|20\d{2})\d{4})\b/g;

        // Optional Asia unit / floor markers that often sit before the street
        // on the same line (#12-34, 27/F). Not enough alone — they only widen
        // a span that already has street + postal.
        const unitLead = /(?:#\s?[A-Z]{0,2}\d{1,3}-\d{1,4}[A-Za-z]?|(?:\d{1,3}\/F)|(?:(?:UG|LG|G|B\d?)\/F)|(?:(?:Floor|Level)\s\d{1,3})|(?:\d{1,3}\s?(?:st|nd|rd|th)?\s?(?:Floor|Level)))\b/i;

        for (const m of scan(text, streetRe)) {
          const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
          let lineEnd = text.indexOf('\n', m.index);
          if (lineEnd === -1) lineEnd = text.length;
          const afterStreet = text.slice(m.index + m[0].length, lineEnd);

          postalRe.lastIndex = 0;
          let postal = null;
          let pm;
          while ((pm = postalRe.exec(afterStreet)) !== null) {
            // Prefer the last postal-like token on the line (city, then code).
            postal = pm;
          }
          if (!postal) continue;

          let start = m.index;
          let end = m.index + m[0].length + postal.index + postal[0].length;

          // Pull optional unit/floor markers on this line that sit before the
          // street number, so "#44-02, 1 Raffles Place … 048616" is one span.
          const before = text.slice(lineStart, m.index);
          const lead = before.match(new RegExp(unitLead.source + '[\\s,]*$', unitLead.flags));
          if (lead) start = lineStart + before.length - lead[0].length;

          // Trim leading/trailing separators.
          while (start < end && /[\s,]/.test(text[start])) start++;
          while (end > start && /[\s,]/.test(text[end - 1])) end--;
          if (end - start > 200) continue;

          out.push({ start, end, confidence: 'high' });
        }

        return out;
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
  // Build a term regex body.
  //
  // opts.fromOcr: OCR often glues words ("FraserandNeave") or spells "&" as
  // "and" / the reverse. Allow zero spaces between words, and treat "&" and
  // the word "and" as the same connector. Text-layer matching stays strict
  // about needing real whitespace between words so "JaneDoe" does not match
  // a typed "Jane Doe".
  function termPattern(term, opts) {
    const fromOcr = opts && opts.fromOcr;
    // OCR often inserts a hyphen, bullet, or slash where a designer put a
    // space ("Middle-East", "Charles / Keith"). Allow those as glue; keep
    // text-layer matching on real whitespace so "JaneDoe" stays unmatched.
    const betweenWords = fromOcr ? '[\\s\\-–—·•|/]*' : '\\s+';
    let out = '';
    for (let i = 0; i < term.length; i++) {
      if (/\s/.test(term[i])) {
        // A spaced "and" in the term is a connector: on OCR it may also appear
        // as "&". Keep at least the flexible gap; do not demand letters of
        // "and" when the document used an ampersand.
        let j = i;
        while (j + 1 < term.length && /\s/.test(term[j + 1])) j++;
        const rest = term.slice(j + 1);
        if (/^and\b/i.test(rest)) {
          out += '(?:' + betweenWords + 'and' + betweenWords + '|' + betweenWords + '&' + betweenWords + ')';
          i = j + 3; // consumed "and"
          while (i + 1 < term.length && /\s/.test(term[i + 1])) i++;
          continue;
        }
        out += betweenWords;
        i = j;
        continue;
      }
      if (term[i] === '&') {
        out += '(?:&|' + betweenWords + 'and' + betweenWords + ')';
        if (i + 1 < term.length && !/\s/.test(term[i + 1])) out += '\\s*';
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
  function findTerms(text, terms, opts) {
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
      const re = new RegExp(head + termPattern(term, opts) + tail, 'gi');
      for (const m of scan(text, re)) {
        // The boundary group is always capture 1. Connector alternatives
        // inside termPattern use non-capturing groups so they do not shift it.
        const lead = m[1] ? m[1].length : 0;
        out.push({ kind: 'term', label: 'Terms you listed', hint: 'Matched "' + term + '".', start: m.index + lead, end: m.index + m[0].length, confidence: 'high', term });
      }
    }
    // OCR phrase recovery: content-word chains when the full phrase misses.
    if (opts && opts.fromOcr && !opts._skipPhraseParts) {
      for (const term of cleaned) {
        if (phraseContentParts(term).length < 2) continue;
        for (const hit of findOcrPhraseByParts(text, term)) {
          if (out.some(o => o.term === term && o.start < hit.end && hit.start < o.end)) continue;
          out.push(hit);
        }
      }
    }
    return out;
  }

  // Content words of a typed phrase (OCR + the second check). Drop connectors
  // so "Fraser and Neave" becomes Fraser + Neave — OCR may garble the "and"
  // or drop a digit crumb between the names without killing the phrase.
  const PHRASE_STOP = new Set(['and', 'or', 'of', 'the', 'a', 'an', '&', '+']);

  function phraseContentParts(term) {
    return String(term || '').trim().split(/\s+/)
      .filter(w => w && !PHRASE_STOP.has(w.toLowerCase()) && /[A-Za-z0-9]/.test(w));
  }

  function skippedConnectorsBetween(term, leftPart, rightPart) {
    const tokens = String(term || '').trim().split(/\s+/);
    const li = tokens.findIndex(t => t.toLowerCase() === leftPart.toLowerCase());
    const ri = tokens.findIndex((t, i) => i > li && t.toLowerCase() === rightPart.toLowerCase());
    if (li < 0 || ri < 0) return 0;
    return Math.max(0, ri - li - 1);
  }

  // Gap between two content-word hits that still counts as one phrase.
  // Whitespace / designer punctuation, the expected connector words, and a
  // short digit crumb (OCR often dumps a slide number into a line) are fine;
  // any other real word means a different neighbourhood.
  function ocrPhraseGapOk(gap, maxConnectors) {
    const cleaned = String(gap || '')
      .replace(/[\s\-–—·•|/\\.,;:'"()\[\]{}]+/g, ' ')
      .trim();
    if (!cleaned) return true;
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    let connectors = 0;
    for (const raw of tokens) {
      const low = raw.toLowerCase().replace(/^[^a-z0-9&]+|[^a-z0-9&]+$/g, '');
      if (!low) continue;
      if (PHRASE_STOP.has(low) || low === '&') {
        connectors++;
        if (connectors > (maxConnectors || 0)) return false;
        continue;
      }
      if (/^\d{1,3}$/.test(low)) continue;
      return false;
    }
    return connectors <= (maxConnectors || 0);
  }

  // OCR often swaps one letter in a longer word ("Midale"/"Widdle" for
  // "Middle") while the neighbour ("East") is read cleanly. Allow a tight
  // fuzzy match on long content parts only, and only inside a phrase chain
  // that still has at least one exact part — never promote bare "East" to
  // "Middle East", and never fuzz short tokens like "east"/"kas".
  const OCR_FUZZ_MIN_LEN = 5;

  function levenshtein(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (s === t) return 0;
    if (!s.length) return t.length;
    if (!t.length) return s.length;
    const prev = new Array(t.length + 1);
    const cur = new Array(t.length + 1);
    for (let j = 0; j <= t.length; j++) prev[j] = j;
    for (let i = 1; i <= s.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= t.length; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= t.length; j++) prev[j] = cur[j];
    }
    return prev[t.length];
  }

  // True when `token` is a near-miss of typed phrase part `part` under OCR.
  function ocrFuzzyPartMatch(token, part) {
    const a = lettersOf(token).toLowerCase();
    const b = lettersOf(part).toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    if (b.length < OCR_FUZZ_MIN_LEN) return false;
    if (Math.abs(a.length - b.length) > 1) return false;
    // One edit only. Keeps Midale/Widdle≈Middle; blocks South≈Middle.
    return levenshtein(a, b) <= 1;
  }

  function ocrWordTokens(text) {
    const out = [];
    const re = /[A-Za-z0-9]+/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  // Exact findTerms hits, plus fuzzy OCR near-misses for long parts.
  function findOcrPartHits(text, part) {
    const exact = findTerms(text, [part], { fromOcr: true, _skipPhraseParts: true })
      .map(h => ({ ...h, fuzzy: false }));
    const seen = new Set(exact.map(h => h.start + ':' + h.end));
    const fuzz = [];
    if (lettersOf(part).length >= OCR_FUZZ_MIN_LEN) {
      for (const tok of ocrWordTokens(text)) {
        if (!ocrFuzzyPartMatch(tok.text, part)) continue;
        // Skip exact equals — already in exact list (or identical).
        if (lettersOf(tok.text).toLowerCase() === lettersOf(part).toLowerCase()) continue;
        const key = tok.start + ':' + tok.end;
        if (seen.has(key)) continue;
        // Do not fuzzy-hit a token that is already an exact hit for this part.
        if (exact.some(h => h.start < tok.end && tok.start < h.end)) continue;
        seen.add(key);
        fuzz.push({
          kind: 'term',
          label: 'Terms you listed',
          hint: 'Matched "' + part + '".',
          start: tok.start,
          end: tok.end,
          confidence: 'medium',
          term: part,
          fuzzy: true,
        });
      }
    }
    return exact.concat(fuzz);
  }

  // When the full phrase regex misses — OCR glued junk between words, or
  // mangled only the connector — recover by matching each content word and
  // chaining left-to-right with a tolerant gap. Unpaired part hits are not
  // reported as the phrase (precision: "East" alone is not "Middle East").
  //
  // At most one fuzzy part per chain; every other part must be exact. That
  // way a single OCR typo next to a clean neighbour can recover "Middle East",
  // but two guesses cannot invent a phrase from unrelated words.
  function findOcrPhraseByParts(text, term) {
    const parts = phraseContentParts(term);
    if (parts.length < 2) return [];
    const pools = parts.map(part => findOcrPartHits(text, part));
    const used = pools.map(() => new Set());
    const out = [];
    for (let i = 0; i < pools[0].length; i++) {
      if (used[0].has(i)) continue;
      const chain = [pools[0][i]];
      const usedIdx = [i];
      let fuzzCount = pools[0][i].fuzzy ? 1 : 0;
      let ok = true;
      for (let p = 1; p < parts.length; p++) {
        const prev = chain[chain.length - 1];
        const skipped = skippedConnectorsBetween(term, parts[p - 1], parts[p]);
        let bestJ = -1;
        let bestStart = Infinity;
        let bestFuzzy = false;
        for (let j = 0; j < pools[p].length; j++) {
          if (used[p].has(j)) continue;
          const cand = pools[p][j];
          if (cand.start < prev.end) continue;
          if (cand.fuzzy && fuzzCount >= 1) continue;
          if (!ocrPhraseGapOk(text.slice(prev.end, cand.start), skipped)) continue;
          // Prefer exact over fuzzy at the same place; then earlier start.
          const better = bestJ < 0
            || cand.start < bestStart
            || (cand.start === bestStart && !cand.fuzzy && bestFuzzy);
          if (!better) continue;
          bestStart = cand.start;
          bestJ = j;
          bestFuzzy = !!cand.fuzzy;
        }
        if (bestJ < 0) { ok = false; break; }
        chain.push(pools[p][bestJ]);
        usedIdx.push(bestJ);
        if (pools[p][bestJ].fuzzy) fuzzCount++;
      }
      if (!ok) continue;
      // Need at least one exact part so the chain is anchored in a real read.
      if (!chain.some(h => !h.fuzzy)) continue;
      used[0].add(usedIdx[0]);
      for (let p = 1; p < parts.length; p++) used[p].add(usedIdx[p]);
      out.push({
        kind: 'term',
        label: 'Terms you listed',
        hint: 'Matched "' + term + '".',
        start: chain[0].start,
        end: chain[chain.length - 1].end,
        confidence: fuzzCount ? 'medium' : 'high',
        term,
      });
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
      // A term swallowed by something else is still found.
      //
      // Whatever swallowed it keeps its own kind — an email that happens to
      // contain a typed name is an email address, and the legend must not
      // call it a person — but the span records the words it carries, so a
      // reviewer who typed "Amphitheatre" is not told it was found nowhere
      // because an address grew around it. The wider span is what gets
      // covered either way: more ink, not less.
      if (f.kind === 'term' && f.term && over.start <= f.start && f.end <= over.end) {
        if (!over.holds) over.holds = [];
        if (!over.holds.includes(f.term)) over.holds.push(f.term);
      }
      // And a guess gives up its name altogether: a medium-confidence span is
      // a proposal, and the reviewer's own word outranks it.
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


  // Letters/digits only, for comparing a typed term to a host word the reader
  // already named (TEXAS vs KAS) without punctuation noise.
  function lettersOf(s) {
    return String(s || '').replace(/[^A-Za-z0-9]+/g, '');
  }

  // Should a second-check shape hit for `term` be refused because it sits
  // inside host word `hostText` that the text layer or OCR already read?
  //
  // Measured on a logo collage looking for "KAS": shape matched the XAS in
  // TEXAS INSTRUMENTS. When the reader has the longer host, that mark is not
  // a second opinion — it is a mid-word false positive on a short acronym.
  // If the host really contains the term as a whole word (findTerms), keep it.
  function hostContradictsShapeTerm(hostText, term) {
    const host = String(hostText || '').trim();
    const needle = String(term || '').trim();
    if (!host || !needle) return false;
    if (findTerms(host, [needle]).length > 0) return false;
    const h = lettersOf(host);
    const n = lettersOf(needle);
    if (!h || !n) return false;
    return h.toLowerCase() !== n.toLowerCase();
  }

  root.BlindedDetect = {
    findAll, findTerms, termPattern, phraseContentParts, findOcrPhraseByParts, ocrFuzzyPartMatch, levenshtein, hostContradictsShapeTerm, lettersOf, applyToText, resolveOverlaps,
    DETECTORS,
    KINDS: DETECTORS.map(d => ({ kind: d.kind, label: d.label, hint: d.hint })),
  };
})(typeof window !== 'undefined' ? window : globalThis);
