// Names each redaction, so a blank becomes a placeholder.
//
// A black bar tells a later reader that something was removed. It does not
// tell them *what*, and that matters more than it sounds: "____ transferred
// the account to ____" is nearly unreadable, while "[PERSON_1] transferred the
// account to [PERSON_2]" carries the whole sentence. Anything reading the
// document afterwards — a person, or a model — can follow the argument without
// ever learning who is being discussed.
//
// The property that makes this useful rather than decorative is **consistency**:
// the same original value gets the same label every time it appears, across
// every page. That is what lets a reader tell that the person in paragraph two
// is the person in paragraph nine. Labelling each occurrence independently —
// PERSON_1, PERSON_2, PERSON_3 for three mentions of one name — would destroy
// exactly the information the labels exist to preserve.
//
// A warning that governs everything downstream: the mapping from a label back
// to its original value is as sensitive as the document was before redaction.
// It must never be written into the redacted output. This file keeps the two
// apart — `legend()` returns categories only and is safe to publish, while
// `key()` returns the originals and is not.
(function (root) {
  'use strict';

  // Prefix and prose per kind. The prose is what goes in the published legend,
  // so it describes the category without hinting at the value.
  //
  // The prefixes are deliberately terse — P1, E2, C1 — because a placeholder
  // has to fit inside the bar it labels, and a bar is only as wide as whatever
  // it covers. render.js shrinks a label until it fits, so a long one is not
  // usually dropped; it is shrunk, which is worse for being less obvious.
  //
  // Measured on the test document: over a bar covering a five-digit postcode,
  // [PC1] draws at the bar's full height of 22.8px while [POSTCODE_1] is
  // squeezed to 9.8px — legible only in principle. Over a name, [P1] holds
  // 22.8px against [PERSON_1]'s 17.8px. Below 7px render.js gives up and draws
  // nothing at all, so on a bar much narrower than a postcode the long form
  // does disappear.
  //
  // Terseness costs nothing here because the legend page carries the meaning:
  // anything reading the document reads "[P1] — a person's name" alongside it.
  // A reviewer who wants a self-describing name can type one, and often
  // should — CLAIMANT says more than P1 ever will, and on a wide bar it fits.
  //
  // Prefixes must stay distinct from one another as whole tokens: P, PH and PC
  // are three different categories and none is a prefix of another *plus a
  // digit*, which is what would make P1 and PH1 ambiguous to a reader.
  const CATEGORIES = {
    person:   { prefix: 'P',  description: "a person's name" },
    term:     { prefix: 'T',  description: 'a term chosen by the reviewer' },
    email:    { prefix: 'E',  description: 'an email address' },
    phone:    { prefix: 'PH', description: 'a telephone number' },
    card:     { prefix: 'C',  description: 'a payment card number' },
    iban:     { prefix: 'B',  description: 'a bank account number' },
    ssn:      { prefix: 'S',  description: 'a US Social Security number' },
    ip:       { prefix: 'IP', description: 'an IP address' },
    url:      { prefix: 'U',  description: 'a web address' },
    address:  { prefix: 'A',  description: 'a street address' },
    postcode: { prefix: 'PC', description: 'a postal code' },
    dob:      { prefix: 'D',  description: 'a date of birth' },
    logo:     { prefix: 'L',  description: 'a logo or other image' },
    manual:   { prefix: 'R',  description: 'a region covered by hand' },
  };

  // A typed term is usually a name, but not always — an account number or a
  // codename gets typed into the same box. Guessing PERSON for a value full of
  // digits would put a wrong claim into the document, so the guess is made
  // only for things shaped like names and is editable either way.
  function looksLikeName(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || /\d/.test(trimmed)) return false;
    const words = trimmed.split(/\s+/);
    if (words.length > 4) return false;
    // A word in all capitals is far more often an acronym or a company than a
    // person — KAG, NHS, IBM. Calling one of those "a person's name" in the
    // legend puts a claim into the document that is simply wrong, and the
    // legend is the part a later reader trusts.
    if (words.some(w => w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w))) return false;
    return words.every(w => /^[A-Z][\p{L}'’-]*$/u.test(w));
  }

  // The reviewer's own wording for a typed term, which is the canonical form:
  // every match of it is a match of what they typed, whatever case the
  // document happened to use.
  function termOf(item) {
    return item.term || item.text || '';
  }

  // Grouping happens before categorising, and the order matters.
  //
  // Deciding the category per item and then grouping by it splits a name
  // across two labels the moment the document mentions it in a different case:
  // "Jane Doe" looks like a name, "jane doe" does not, so they landed in
  // PERSON_1 and TERM_1 and the reader lost the fact that they are the same
  // person. That is precisely the information labelling exists to preserve, so
  // identity is computed without consulting the category at all.
  function identityOf(item) {
    if (item.kind === 'image') return 'logo:' + item.templateId;
    if (item.kind === 'manual') return 'manual:' + item.id;
    const normalised = String(item.kind === 'term' ? termOf(item) : (item.text || ''))
      .toLowerCase().replace(/\s+/g, ' ').trim();
    return (item.kind === 'term' ? 'term' : item.kind) + ':' + normalised;
  }

  // With the group settled, the category is decided from the whole group: if
  // any occurrence of a typed term is shaped like a name, the group is a
  // person.
  function categoryOfGroup(kind, members) {
    if (kind === 'image') return 'logo';
    if (kind === 'manual') return 'manual';
    if (kind === 'term') return members.some(m => looksLikeName(termOf(m))) ? 'person' : 'term';
    return CATEGORIES[kind] ? kind : 'manual';
  }

  // Kept for the single-item case, and because the tests read better with it.
  function categoryOf(item) {
    return categoryOfGroup(item.kind, [item]);
  }

  // What counts as "the same thing" for labelling. Case and surrounding
  // whitespace do not change who a name refers to, so "Jane Doe" and
  // "jane  doe" share a label. Images are keyed by the template they matched,
  // since every match of one picked logo is that same logo. Hand-drawn boxes
  // are keyed by themselves — the tool cannot know whether two of them cover
  // related things.
  function identityOf(item) {
    const category = categoryOf(item);
    if (category === 'logo') return 'logo:' + item.templateId;
    if (category === 'manual') return 'manual:' + item.id;
    return category + ':' + String(item.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Assigns a label to every item, numbering each category by first appearance.
   *
   * items: [{ id, kind, text, templateId }] in reading order.
   * overrides: { [identity]: 'CUSTOM_LABEL' } from the reviewer's edits.
   *
   * Returns { byId, entries } — a label for each item id, and one entry per
   * distinct thing, in the order the document first mentions it.
   */
  function assign(items, overrides) {
    const edits = overrides || {};

    // First pass: group by identity, in order of first appearance.
    const groups = new Map();
    for (const item of items) {
      const identity = identityOf(item);
      let group = groups.get(identity);
      if (!group) {
        group = { identity, kind: item.kind, members: [] };
        groups.set(identity, group);
      }
      group.members.push(item);
    }

    // Second pass: categorise each group as a whole, then number the
    // categories by the order the document first mentions them.
    const counters = {};
    const byId = {};
    const entries = [];

    for (const group of groups.values()) {
      const category = categoryOfGroup(group.kind, group.members);
      const spec = CATEGORIES[category];
      counters[category] = (counters[category] || 0) + 1;
      const suggested = spec.prefix + counters[category];
      const override = edits[group.identity];
      const label = override || suggested;

      for (const member of group.members) byId[member.id] = label;

      entries.push({
        identity: group.identity,
        category,
        description: spec.description,
        suggested,
        label,
        edited: Boolean(override) && override !== suggested,
        // The reviewer's own wording where there is one, so the legend shows
        // what they typed rather than whichever casing the document used.
        value: group.kind === 'term' ? termOf(group.members[0]) : (group.members[0].text || ''),
        count: group.members.length,
        ids: group.members.map(m => m.id),
      });
    }

    return { byId, entries };
  }

  // What may be printed inside the redacted document: the label and what kind
  // of thing it stands for. Deliberately does not carry `value`.
  function legend(entries) {
    return entries.map(entry => ({
      label: entry.label,
      description: entry.description,
      count: entry.count,
    }));
  }

  // The mapping back to the originals. This is the sensitive artefact — it
  // reconstructs everything the redaction removed — and exists so a reviewer
  // can keep their own record, never so it can travel with the document.
  function key(entries) {
    return entries.map(entry => ({
      label: entry.label,
      description: entry.description,
      original: entry.value,
      occurrences: entry.count,
    }));
  }

  // Labels are written into the document and read back by machines, so they
  // are held to a shape: upper-case words joined by underscores. A reviewer
  // typing "Jane's employer" gets JANES_EMPLOYER rather than an argument.
  function normalise(label) {
    const cleaned = String(label || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return cleaned.slice(0, 40);
  }

  // How a label appears in the document itself.
  function render(label) {
    return '[' + label + ']';
  }

  root.BlindedLabels = {
    assign, legend, key, normalise, render,
    categoryOf, categoryOfGroup, identityOf, looksLikeName, termOf, CATEGORIES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
