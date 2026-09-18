// The pages somebody lands on when they search for the thing this does.
//
// Not "redact PDF". Anybody typing that is shopping, and the answer they get
// is Adobe. The searches worth answering are the ones with a job in them --
// "redact a CIM without uploading it", "why is my redacted text still
// selectable" -- because the person typing those has already hit the problem
// and is looking for the specific way out.
//
// Content lives here rather than in six near-identical HTML files, so the
// shell, the structured data and the cross-links cannot drift apart between
// them. tools/pages.mjs renders it; the self-test checks the rendering is
// current and that every page is a real page rather than a keyword with a
// heading on it.

export const SITE = 'https://blinded.dev';

export const pages = [
  {
    slug: 'redact-cim',
    title: 'Redact a CIM without uploading it',
    h1: 'Redact a CIM without uploading it',
    description: 'Strip names, logos and signatures out of a confidential '
      + 'information memorandum in your browser. The file never leaves your '
      + 'machine, so nothing goes to a server you would have to explain.',
    keywords: ['redact CIM', 'redact CIM without uploading',
      'confidential information memorandum redaction', 'teaser redaction',
      'redact a deal document', 'diligence pack redaction'],
    shot: { slide: 4, alt: 'A deal slide before and after: the two company '
      + 'names in the headline and the logos beside them are gone.' },
    lede: 'A CIM goes out to twenty parties before anybody signs. Most of it '
      + 'is meant to go; the company name, the sponsor, the management team '
      + 'and the logos in the footer are not. Doing that with a tool that '
      + 'uploads the file first is a problem you have to explain to a client, '
      + 'and often cannot.',
    sections: [
      { h: 'The part that makes this hard is not the text',
        p: ['Search-and-redact handles a name that is typed as text. A CIM is '
          + 'not mostly typed text. It is a deck: the company name is set in '
          + 'the master slide as part of an image, the sponsor logo is a PNG '
          + 'in the corner of every page, the management photographs carry '
          + 'names underneath them in a graphic, and the org chart is one flat '
          + 'picture of everything you are trying to remove.',
          'Nothing in an ordinary search reaches any of that. Which is why the '
          + 'usual answer is an analyst with a rectangle tool and four hours, '
          + 'and why the usual failure is page 47.'] },
      { h: 'What this does instead',
        p: ['Type the name once. It is found in the text, in the lettering of '
          + 'a screenshot, and inside a logo, on every page. Draw a box round '
          + 'the sponsor mark once and every other copy of it is found too, at '
          + 'whatever size it has been dropped in at and whatever colour it has '
          + 'been recast in for the dark slides.',
          'The export is not the original file with rectangles laid over it. '
          + 'Each page is rebuilt from pixels, so the words under a bar are '
          + 'not in the file any more -- there is nothing left to select, copy '
          + 'or recover.'] },
      { h: 'And it runs in the tab',
        p: ['There is no server to upload to. The whole thing -- opening the '
          + 'PDF, reading it, matching the logo, writing the new file -- '
          + 'happens on your own machine. Open your browser’s network '
          + 'panel and watch: nothing leaves. Pull the network cable out and '
          + 'it carries on working.',
          'That is enforced rather than promised. The page carries a content '
          + 'security policy the browser applies whatever the code asks for, '
          + 'and the line that matters says the page may not send anything '
          + 'anywhere.'] },
    ],
    steps: [
      'Open the CIM. It is read in the tab; nothing is sent anywhere.',
      'Type the names: the company, the sponsor, the management, the adviser. '
        + 'Each one is counted before you commit to it, so you can see whether '
        + 'a name is on four pages or four hundred.',
      'Draw a box round each logo that has no text to search for. Every other '
        + 'copy in the document is found at any size.',
      'Press Redact, check the marks, and export. The pages are rebuilt, so '
        + 'what was covered is gone rather than hidden.',
    ],
    who: 'Bankers and advisers sending a teaser to a buyer list, sponsors '
      + 'preparing a data room, and anybody who has to hand a deal document '
      + 'to somebody who is not allowed to know whose it is.',
    faq: [
      { q: 'Does the file get uploaded?',
        a: 'No. There is no server to upload it to, and the page is not '
          + 'permitted by the browser to send anything anywhere. You can '
          + 'confirm both in the network panel, or by disconnecting.' },
      { q: 'Will it find the name inside a logo?',
        a: 'Yes. Words are searched for three ways: in the text layer, in the '
          + 'lettering of pictures and scans, and by shape where the reading '
          + 'was defeated by an unusual typeface. A picked logo is matched by '
          + 'shape at any size or colour.' },
      { q: 'Can the redacted text be recovered from the exported file?',
        a: 'No. Each page is rebuilt from pixels rather than covered with a '
          + 'rectangle, so the removed words are not in the file to recover. '
          + 'That is the difference between this and a black box drawn in a '
          + 'PDF editor.' },
      { q: 'How long does a 200-page CIM take?',
        a: 'The first pass over a deck of that size is a few minutes, and it '
          + 'reports its progress along the foot while you read the document. '
          + 'The optional second check, which looks for words that exist only '
          + 'as pictures, states the wait before it starts so you can decide.' },
    ],
  },

  {
    slug: 'redact-logos-pitch-deck',
    title: 'Redact logos in a pitch deck',
    h1: 'Redact logos in a pitch deck',
    description: 'Remove a customer logo wall, a sponsor mark or a partner '
      + 'badge from every slide at once. Pick one, and every other copy is '
      + 'found at any size or colour, in the browser.',
    keywords: ['redact logos in a pitch deck', 'logo redaction without upload',
      'remove logos from a presentation', 'customer logo wall redaction',
      'anonymise a deck'],
    shot: { slide: 5, alt: 'A logo wall before and after: two of the ten '
      + 'brand marks are replaced with labelled black bars.' },
    lede: 'The logo wall is the slide nobody can redact. It is one row of '
      + 'twenty customer marks, each a different picture, none of them text, '
      + 'and two of them belong to companies that have not agreed to be named '
      + 'as customers.',
    sections: [
      { h: 'Why search cannot touch it',
        p: ['A logo is a picture. It has no letters a search can find, no text '
          + 'layer entry, and often no name anywhere near it on the slide. The '
          + 'only handle on it is what it looks like -- and what it looks like '
          + 'changes: the same mark is 40 pixels wide in the footer, 200 wide '
          + 'on the customer slide, full colour on white and knocked back to '
          + 'one flat grey on the dark section divider.',
          'So the work is manual, and manual work on a forty-slide deck misses '
          + 'the appendix.'] },
      { h: 'Pick it once',
        p: ['Draw a box round the mark on any slide. Every other copy in the '
          + 'deck is found -- at any size, and whatever colour it has been '
          + 'recast in, because the match is on shape rather than on pixels '
          + 'being equal.',
          'Each picked image gets its own sensitivity, offered as the two or '
          + 'three settings the scores on your actual document point at, with '
          + 'what each one would find. A clean wordmark and a scanned stamp do '
          + 'not want the same number, and you should not have to guess either '
          + 'of them.'] },
      { h: 'What it will not do for you',
        p: ['It proposes; you decide. Nothing is covered until you press '
          + 'Redact, and every match is listed with the slide it is on so you '
          + 'can walk the list rather than trust it. That is deliberate: a '
          + 'shape match on a small, low-contrast mark is a judgement, and a '
          + 'tool that made that judgement silently would be wrong on a deck '
          + 'you had already sent.',
          'It will not find a logo that appears only once, redrawn by hand, in '
          + 'a style the original does not share -- that is a different '
          + 'picture, not a copy. And it does not read the deck for meaning: '
          + 'if a customer is named in the body text as well as shown in the '
          + 'wall, the name is a word to type, separately from the mark you '
          + 'picked.',
          'What it is good at is the failure that actually happens, which is '
          + 'not missing the logo on the customer slide. It is missing the '
          + 'fourth copy of it, 40 pixels wide, in the footer of the '
          + 'appendix.'] },
      { h: 'Placeholders, when the slide stops making sense',
        p: ['Take four logos out of a row of ten and the sentence under it '
          + '-- "our customers include" -- is suddenly about nothing. Turn on '
          + 'labels and each bar carries [L1], [L2], consistently, so the same '
          + 'company is the same label everywhere in the deck. A reader, or a '
          + 'model, can still follow which one is which without knowing who '
          + 'they are.'] },
    ],
    steps: [
      'Open the deck. Every page is rendered in the tab.',
      'Press the pick button and draw a box round one copy of the logo.',
      'Let it search. Every other copy is proposed, with a count per slide '
        + 'and a way to say no to any one of them.',
      'Repeat for each mark, then Redact and export a deck with the pages '
        + 'rebuilt.',
    ],
    who: 'Founders sending a deck to an investor who competes with a customer, '
      + 'agencies reusing a case study, and anybody who needs the numbers on '
      + 'the slide without the names around them.',
    faq: [
      { q: 'Does it find the logo at a different size?',
        a: 'Yes. The match is on shape and runs over a range of scales, so a '
          + 'footer mark and a full-width one on the title slide are the same '
          + 'find.' },
      { q: 'What about a logo recoloured for a dark slide?',
        a: 'Also found. Matching is done on the greyscale structure rather '
          + 'than on colour, so a white knockout of a mark matches the full '
          + 'colour original.' },
      { q: 'Can I keep some of the logos and remove others?',
        a: 'Yes. Every proposed match is shown before anything is covered, '
          + 'with a page reference and an x to dismiss it. Nothing is redacted '
          + 'until you press Redact.' },
      { q: 'Are the logos really gone from the exported file?',
        a: 'Yes. The page is rebuilt from pixels, so the original image is not '
          + 'in the exported PDF underneath a black rectangle.' },
    ],
  },

  {
    slug: 'foia-redaction',
    title: 'FOIA redaction without sending the records anywhere',
    h1: 'FOIA redaction without sending the records anywhere',
    description: 'Redact a FOIA or public-records release on your own machine. '
      + 'No upload, no account, no third party holding the file while you '
      + 'work on it.',
    keywords: ['local FOIA redaction', 'FOIA redaction software',
      'public records redaction', 'redact records without uploading',
      'discovery production redaction', 'offline redaction tool'],
    shot: { slide: 2, alt: 'A page of people before and after: the names and '
      + 'titles under each photograph are replaced with labelled bars.' },
    lede: 'A public-records release is the one document where sending the file '
      + 'to a third party to redact it is the most obviously wrong thing you '
      + 'could do. The whole exercise is about controlling what leaves; the '
      + 'first step should not be making a copy somewhere you do not run.',
    sections: [
      { h: 'The exemption is in the pages, not the metadata',
        p: ['A release is usually a pile of scans: printed emails, forms with '
          + 'handwriting on them, faxed letters, signature pages. The names, '
          + 'the direct lines, the home addresses and the signatures are in '
          + 'the pixels. A text search finds none of it, because there is no '
          + 'text.',
          'So the work is done a page at a time with a rectangle tool, and the '
          + 'reason releases get re-issued is that somewhere in nine hundred '
          + 'pages a name went through.'] },
      { h: 'Read the pages, then search them',
        p: ['Scanned pages are read in the tab, so a name typed once is found '
          + 'in the lettering of every scan as well as in any real text. A '
          + 'signature, a letterhead or a stamp is picked out with a box and '
          + 'found everywhere else it appears.',
          'There are detectors for the things that leak and that nobody thinks '
          + 'to type: email addresses, phone numbers, web addresses, street '
          + 'addresses and postal codes, and dates of birth. Each says how '
          + 'many it can see before you switch it on.'] },
      { h: 'Checked before it is committed, and again afterwards',
        p: ['Every proposal is on screen before anything is covered, with the '
          + 'page it is on and a count per term, so a release is reviewed as a '
          + 'list rather than by scrolling nine hundred pages hoping to notice '
          + 'something. Marks the tool is least sure of are put back to you as '
          + 'questions rather than quietly applied.',
          'Words that exist only as pictures -- a name in a letterhead, a '
          + 'stamp with type in it -- get an optional second pass that looks '
          + 'for them by shape. It states the wait before it starts, because '
          + 'on a long release it is minutes, and it is your decision whether '
          + 'this document needs it.',
          'When the export is done, check it the way a recipient would: open '
          + 'it, select across a bar, and paste. Nothing comes out, because '
          + 'the page was rebuilt rather than covered. Do the same test on '
          + 'whatever you use today.'] },
      { h: 'A record you can defend',
        p: ['The exported file has each page rebuilt from pixels. What is '
          + 'under a bar is not in the file -- not selectable, not copyable, '
          + 'not recoverable by pulling the content stream apart. That is the '
          + 'property a release has to have, and the one that a rectangle '
          + 'drawn in a PDF editor does not.',
          'Labels can be turned on so each bar carries a consistent code, '
          + 'which is how you show that four bars on four pages are the same '
          + 'withheld individual without naming them.'] },
    ],
    steps: [
      'Open the release. Nothing is uploaded; the pages are read on your '
        + 'machine.',
      'Type the names and numbers to withhold, and tick the detectors for '
        + 'addresses, phone numbers and the rest.',
      'Pick out signatures, stamps and letterheads with a box; every other '
        + 'copy is found.',
      'Review every proposal, dismiss the ones that should stay, then Redact '
        + 'and export.',
    ],
    who: 'Records officers, FOIA and public-records teams, litigation support '
      + 'preparing a production, and journalists redacting a source document '
      + 'before publishing it.',
    faq: [
      { q: 'Does anything leave my machine?',
        a: 'No. There is no server. The browser is prevented from sending '
          + 'anything anywhere by a content security policy on the page, and '
          + 'the tool works with the network disconnected.' },
      { q: 'Can it handle scans with no text layer?',
        a: 'Yes. The pages are read in the tab, and words are also matched by '
          + 'shape where the reading was defeated by a poor scan or an unusual '
          + 'typeface.' },
      { q: 'Can I prove nothing was uploaded?',
        a: 'Open the network panel and redact a document: nothing leaves. The '
          + 'source is published, so the claim is checkable rather than a '
          + 'promise.' },
      { q: 'Is there an audit trail?',
        a: 'A draft can be saved: your marks, the words you typed and what was '
          + 'found, as a file on your own machine to reopen and edit later. It '
          + 'holds the same sensitive material as the document, so keep it as '
          + 'carefully.' },
    ],
  },

  {
    slug: 'de-identify-scanned-records',
    title: 'De-identify scanned records',
    h1: 'De-identify scanned records',
    description: 'Remove names, dates of birth, addresses and signatures from '
      + 'scanned medical or personnel records, in the browser, with nothing '
      + 'sent to a server.',
    keywords: ['de-identify scanned records', 'de-identify medical records',
      'redact scanned documents', 'PHI redaction without upload',
      'anonymise scanned files', 'redact a scan'],
    shot: { slide: 1, alt: 'A scanned page before and after: names, a date '
      + 'and a signature block are gone.' },
    lede: 'De-identification is not a search problem, it is a reading problem. '
      + 'The record is a scan. There is no text to search, the handwriting is '
      + 'somebody else’s, and the name appears eleven different ways '
      + 'across ninety pages.',
    sections: [
      { h: 'Why a text search finds nothing',
        p: ['A scanned record has no text layer, or a bad one. Every identifier '
          + '-- the patient name in the header of each page, the date of birth '
          + 'on the form, the clinician’s signature, the address on the '
          + 'referral letter -- exists only as pixels. Search finds nothing, '
          + 'and nothing is exactly as many matches as a tool with no reader '
          + 'can offer.'] },
      { h: 'Three ways at the same word',
        p: ['Each page is read in the tab, so a name typed once is found in the '
          + 'lettering of the scan. Where the reading is defeated -- a stamp, a '
          + 'poor fax, an unusual typeface -- the word is looked for by shape '
          + 'instead, which is an optional second pass that says how long it '
          + 'will take before it starts.',
          'Repeating furniture is picked out with a box: the letterhead, the '
          + 'signature, the hospital stamp. One pick finds every copy in the '
          + 'file.',
          'Dates of birth, phone numbers, addresses and email addresses have '
          + 'detectors of their own, and names are found by reading the layout '
          + 'around them -- a title under a name, a "Name:" before it, a '
          + 'sign-off above it -- rather than by guessing which capitalised '
          + 'words are people.'] },
      { h: 'What it does not do, and why that matters here',
        p: ['It does not decide what counts as an identifier. De-identification '
          + 'standards differ, a study protocol is not a records request, and '
          + 'the judgement about whether a rare diagnosis on a specific date '
          + 'is itself identifying is yours. The tool finds and removes what '
          + 'you ask for, and shows you everything it proposes before anything '
          + 'is covered.',
          'It does not read handwriting, and it does not claim to. It does not '
          + 'verify its own work -- after exporting, open the file and read '
          + 'it, which on a de-identification job is the step nobody should '
          + 'skip.',
          'And it has no memory. Nothing is stored, nothing is sent, and '
          + 'closing the tab ends it. If you want to come back to a part-done '
          + 'record, save a draft -- a file on your own machine holding your '
          + 'marks and the words you typed, which is as sensitive as the '
          + 'record itself and should be kept the same way.'] },
      { h: 'Consistent labels for a study set',
        p: ['Switch labels on and every removed identifier carries a stable '
          + 'code: the same person is the same label on every page. A record '
          + 'stays followable -- this result belongs to that patient -- '
          + 'without the record saying who they are.'] },
    ],
    steps: [
      'Open the record. It is read in the tab, page by page.',
      'Type the identifiers you know, and tick the detectors for dates of '
        + 'birth, addresses and phone numbers.',
      'Pick out the signature, the letterhead and any stamp with a box.',
      'Turn on labels if the set has to stay followable, then Redact and '
        + 'export.',
    ],
    who: 'Research teams preparing a study set, clinicians sharing a case, HR '
      + 'handling a personnel file, and anybody who has to hand over a record '
      + 'without handing over the person.',
    faq: [
      { q: 'Is anything sent to a server?',
        a: 'No. There is no server, and the browser is not permitted to send '
          + 'the file anywhere. It works offline.' },
      { q: 'Does it read handwriting?',
        a: 'No. Handwriting is not read, which is why a handwritten signature '
          + 'is picked out as a picture instead -- one pick finds every other '
          + 'copy of it in the file.' },
      { q: 'How are names found without a list?',
        a: 'By the layout around them rather than by their capitalisation: a '
          + 'job title under a name, a phone number or email under it, a '
          + '"Name:" label, or a sign-off above it. That is where names '
          + 'actually sit, and it works the same for names that are not '
          + 'English.' },
      { q: 'Can the identifiers be recovered from the export?',
        a: 'No. Each page is rebuilt from pixels, so what was covered is not '
          + 'in the file.' },
    ],
  },

  {
    slug: 'redacted-text-still-extractable',
    title: 'Redacted text is still extractable. Here is why',
    h1: 'Your redacted text is still extractable. Here is why',
    description: 'A black rectangle drawn over a PDF is a drawing on top of '
      + 'the words, not a removal of them. What went wrong, how to check your '
      + 'own file, and what actually works.',
    keywords: ['redacted text still selectable', 'black box PDF still copyable',
      'Acrobat redaction still extractable', 'redaction failure PDF',
      'how to properly redact a PDF', 'recover redacted text'],
    shot: { slide: 3, alt: 'A page before and after redaction, with the '
      + 'covered words absent from the rebuilt page rather than hidden.' },
    lede: 'Every few months a redacted document is published, somebody selects '
      + 'the text under the black bars, and the whole thing is in the open by '
      + 'lunchtime. It is almost never carelessness. It is a tool doing '
      + 'exactly what it said it would.',
    sections: [
      { h: 'What a black rectangle actually is',
        p: ['A PDF is a list of drawing instructions. "Put this text here in '
          + 'this font" is one instruction; "fill this rectangle with black" '
          + 'is another. Drawing the rectangle adds an instruction -- it does '
          + 'not remove the one before it. Both are still in the file, and the '
          + 'order they are drawn in is the only reason you cannot see the '
          + 'first.',
          'So selecting across the bar copies the text. So does any PDF '
          + 'library, in about four lines. The same is true of a white '
          + 'rectangle, a highlight set to opaque, an image pasted over the '
          + 'area, and a shape added in a word processor before printing to '
          + 'PDF.'] },
      { h: 'The other two ways it leaks',
        p: ['Even when the text is genuinely removed, the thumbnail embedded '
          + 'in the file may still show the original page, and the document '
          + 'metadata -- title, author, the original filename -- routinely '
          + 'carries the name that was removed from the body.',
          'And a cropped image is not a cut image: cropping in most tools '
          + 'stores the whole picture with a smaller window onto it.'] },
      { h: 'How to check the file you already have',
        p: ['Open the exported PDF, select across a redacted area, and paste '
          + 'somewhere. If anything comes out, the text is still in there. '
          + 'Search the file for a name you removed. Look at the document '
          + 'properties.',
          'That is a two-minute test, and it is worth doing on whatever you '
          + 'use now before you need the answer.'] },
      { h: 'What removal actually requires',
        p: ['The page has to be rebuilt. Blinded renders each page, draws the '
          + 'bars into the pixels, and writes a new file out of the result: '
          + 'there is no text layer under the bar because there is no text '
          + 'layer at all, until you ask for a fresh one to be read back from '
          + 'the visible page.',
          'That costs the original’s selectable text, which is a real '
          + 'trade. It buys a document where what is covered is gone, which is '
          + 'the only property that matters once the file is out of your '
          + 'hands.'] },
    ],
    steps: [
      'Open the document that needs redacting -- in the tab; nothing is '
        + 'uploaded.',
      'Mark what has to go, by typing it, by picking it out, or by drawing on '
        + 'the page.',
      'Press Redact and check the marks against the pages.',
      'Export. The pages are rebuilt, so select-and-paste under a bar returns '
        + 'nothing, because there is nothing there.',
    ],
    who: 'Anybody who has been handed a redacted PDF and wondered whether it '
      + 'is really redacted, and anybody about to send one.',
    faq: [
      { q: 'Does Acrobat’s redaction tool work properly?',
        a: 'Its dedicated redaction tool does remove content when the redaction '
          + 'is applied. The failures happen when a shape, highlight or image '
          + 'is drawn over the text instead, which looks identical on screen '
          + 'and removes nothing.' },
      { q: 'Can I recover text from a badly redacted PDF?',
        a: 'Usually, yes -- selecting and copying across the bar is often '
          + 'enough. That is the point: if you can do it in a minute, so can '
          + 'the recipient.' },
      { q: 'Is the exported file still searchable?',
        a: 'Not by default, since the page is a picture. There is an option to '
          + 'read the redacted pages back so the remaining text can be found '
          + 'and copied -- which reads only what is visible, so the removed '
          + 'words cannot come back.' },
      { q: 'What about the metadata and the thumbnail?',
        a: 'The exported file is written fresh from the rebuilt pages rather '
          + 'than edited, so it does not inherit the original’s embedded '
          + 'thumbnails. You can also rename the file on export, since a '
          + 'filename is often the last place a name survives.' },
    ],
  },

  {
    slug: 'redact-before-ai',
    title: 'Redact a PDF before you paste it into ChatGPT or Claude',
    h1: 'Redact a PDF before you paste it into ChatGPT or Claude',
    description: 'Strip names, logos and personal data out of a document '
      + 'before it goes to a model, with labels that keep the sentence '
      + 'readable. Done in your browser, so the unredacted file never leaves.',
    keywords: ['redact PDF before ChatGPT', 'redact document before AI',
      'anonymise a document for an LLM', 'remove PII before uploading to AI',
      'safe to paste into ChatGPT', 'redact before Claude'],
    shot: { slide: 4, alt: 'A deal slide before and after, with the removed '
      + 'names replaced by consistent labels rather than blank bars.' },
    lede: 'You want the model to summarise the contract, not to be told who '
      + 'the counterparty is. The obvious move -- redact it first -- runs into '
      + 'an obvious problem: most redaction tools upload the file to redact '
      + 'it, so the unredacted document has already gone somewhere before the '
      + 'model ever sees the safe version.',
    sections: [
      { h: 'Redact first, in a tab that cannot send anything',
        p: ['This runs entirely in your browser. There is no server, and the '
          + 'page is prevented by the browser itself from sending anything '
          + 'anywhere. The unredacted document does not leave your machine, '
          + 'which is the whole point of redacting it.',
          'What you then paste into a model is the exported file: pages '
          + 'rebuilt from pixels, with the removed words genuinely absent '
          + 'rather than covered.'] },
      { h: 'Blank bars break the sentence. Labels do not',
        p: ['A contract with forty black bars in it is not a document a model '
          + 'can reason about: every party is the same nothing, and "the '
          + 'obligations of [blank] to [blank]" has lost the structure that '
          + 'made it a sentence.',
          'Turn labels on and each removed thing carries a stable code -- '
          + '[P1], [E2] -- with the same thing always getting the same label. '
          + 'The model can follow who owes what to whom, which clause refers '
          + 'back to which party, and which email address appeared twice, '
          + 'without any of them being identifiable.',
          'Export with searchable text on, and the file arrives as text the '
          + 'model can actually read rather than a stack of pictures.'] },
      { h: 'Check it before you paste it',
        p: ['Open the exported file and read it as the model will. Select '
          + 'across a bar and paste somewhere: nothing comes out, because the '
          + 'page was rebuilt rather than covered. Search it for one of the '
          + 'names you removed. Look at the filename, which is often the last '
          + 'place a name survives -- you can change it on export, and the '
          + 'name you type is checked against what you redacted.',
          'Then read it for sense. If the labels have made a clause '
          + 'unreadable, you have removed something structural rather than '
          + 'something identifying, and it is better to find that out now than '
          + 'in an answer that quietly guessed.',
          'None of this is advice about what your employer permits. It is the '
          + 'mechanics of making a file safe to send; whether it may be sent '
          + 'is a different question with a different answer at every '
          + 'company.'] },
      { h: 'What to take out',
        p: ['Type the names you know. Tick the detectors for email addresses, '
          + 'phone numbers, web addresses and street addresses, which catch '
          + 'the identifiers nobody thinks to list. Pick out the letterhead '
          + 'and the signature, which are pictures and which no search will '
          + 'reach.',
          'Every proposal is shown before anything is covered, with a count '
          + 'per page, so you decide what goes rather than discovering it '
          + 'afterwards.'] },
    ],
    steps: [
      'Open the document here first. Nothing is uploaded.',
      'Type the names, tick the detectors, and pick out any letterhead or '
        + 'signature.',
      'Turn on labels so the redacted document still reads as a document.',
      'Export with searchable text on, and give that file to the model.',
    ],
    who: 'Anybody using a model on work documents: lawyers summarising '
      + 'contracts, analysts pulling numbers out of a deck, support teams '
      + 'running tickets through a model, and anyone whose employer has a '
      + 'rule about what may be pasted where.',
    faq: [
      { q: 'Why not just upload it and ask the model to ignore the names?',
        a: 'Because by then the document has been sent. Redaction is about '
          + 'what leaves your machine, and an instruction to a model is not a '
          + 'control over that.' },
      { q: 'Will the model still understand the document?',
        a: 'With labels on, yes. Each removed thing keeps a consistent code, '
          + 'so references between parties, clauses and addresses survive even '
          + 'though the identities do not.' },
      { q: 'Does the model get a picture or text?',
        a: 'Either. The export is a rebuilt page by default; turn on '
          + 'searchable text and the redacted pages are read back so the '
          + 'remaining words can be found and copied.' },
      { q: 'Is Blinded itself an AI service?',
        a: 'No. Nothing is sent to a model, and nothing is sent anywhere at '
          + 'all. The reading and matching run in your browser.' },
    ],
  },
];
