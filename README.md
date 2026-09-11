# Blinded

Redact a document properly, in your browser. Nothing is uploaded.

Cover names, numbers, logos and faces — and have them *actually gone* from the
file, not hidden under a black rectangle that anyone can select the text out
of. Open a PDF, an image or a text file, review every mark before it is
applied, and export a copy with the approved parts removed. There is no server,
no build step and no network request once the page has loaded.

> The repository is still called `blackbar`, which is what this was called
> before. Only the name of the application changed; the clone URL did not.

```
npm install     # only needed to run the tests
npm start       # serves the folder at http://localhost:8017
```

The app itself is `index.html`, `app.js`, `app.css`, `lib/` and `vendor/` — a
static folder. It cannot be opened straight off the disk with `file://`,
because ES modules and pdf.js's worker are blocked there; any static server
will do, and `npm start` is one.

## What it does

- **Gone, not covered.** Each page is rebuilt from pixels, so there is nothing
  underneath the bars — no text, no fonts, no annotations, and none of the
  original author, title or history.
- **It finds them for you.** Emails, cards and IBANs, validated against real
  checksums rather than guessed at. Type any name or
  word and every occurrence is caught.
- **Logos and pictures too.** Pick a logo, signature or stamp and every other
  copy is found across the document, at any size and in any colours. Typed
  words can be hunted for as pictures as well, for scans and screenshots.
- **You approve every mark.** Everything is outlined in red and still readable
  until you press Redact. Click a mark to drop it, drag to add your own, undo
  anything.
- **Placeholders, not blanks.** Optionally label each redaction `[P1]`, `[E2]`,
  so a later reader — or a model — can still follow the sentence.
- **Nothing is uploaded.** No server, no account, no analytics.

## Why not just draw a black rectangle

Because that does not remove anything. A rectangle drawn over text in a PDF
editor is one more object painted on top of text that is still in the file,
still selectable, and still recoverable with `pdftotext` or a copy and paste.
Redacted court filings, intelligence reports and corporate disclosures have all
been un-redacted this way by readers who simply selected the text.

Blinded never edits the input document. It rasterises each page, paints the
approved boxes onto those pixels, and builds a **new** PDF out of the resulting
images. The output contains no text objects, no fonts, no annotations, no
embedded files, no JavaScript, and none of the original's metadata — no author,
title, timestamps or revision history. There is nothing underneath the black
bars because there is no underneath.

`tools/selftest.mjs` asserts this rather than assuming it: it opens the
exported file with a real PDF parser and fails if a single text object survives.

## What it costs

- **The exported PDF is images.** It is no longer searchable or selectable, and
  it is larger than the original. That is the trade being made deliberately.
- **Original metadata is dropped, not preserved.** Usually what you want from a
  redactor, but worth knowing if you needed it.

## How it decides what to propose

Everything Blinded finds is a *proposal*. Nothing is covered that you have not
seen, and every proposal can be switched off by clicking it on the page.

Detection is rule-based and runs locally. Where a value can check itself it
must: card numbers are validated with Luhn, IBANs with mod-97, and US Social
Security numbers against the ranges that have never been issued. Detectors that
match on shape alone — postcodes, street addresses, bare ten-digit numbers — are
marked lower-confidence and are off until you ask for them.

The bias is towards precision, because recall has a backstop and precision does
not: you can catch a missed value by eye during review, but a list padded with
hundreds of false positives trains you to approve everything, which loses both.

| Detector | Validated by |
| --- | --- |
| Email addresses | structure |
| Payment card numbers | Luhn checksum |
| Bank accounts (IBAN) | mod-97 checksum |
| Phone numbers | E.164 and NANP shapes |
| IP addresses | octet range |
| Web addresses | scheme and host |
| Street addresses | house number + street type *(lower confidence)* |
| Postal codes | US ZIP, UK postcode *(lower confidence)* |
| Dates of birth | requires a birth-date keyword |

**Names are not on that list, and cannot be.** No rule finds a name reliably.

## Typing what to redact

The **Text to redact** box takes anything you want covered, one per line —
names, an account number, a project codename. Every occurrence is matched,
ignoring case, longest first, so "Jane Doe" wins over "Jane".

Each term is listed underneath with how many times it was found, and a term
that matched **nothing** is called out in amber. That feedback is the point: a
mistyped name and a name that genuinely does not appear look identical
otherwise, and the failure is silent until the document is already out.

Matching tolerates the spacing a document puts inside a word. A heading set
with letter-spacing — the styled box header on a designed slide — is drawn as
separate glyphs, and the text underneath a document arrives as `K A G` rather
than `KAG`. Typing `KAG` covers all of them, and the box drawn over the tracked
one is wide enough to include the gaps. Only whitespace may come between the
letters, and the ends still have to be word boundaries, so `KAG` does not match
`MyKAG`, `KAGS`, or "a K then A then G".

### Words that are not text

Tick **Also look for these words as pictures** and each typed word is drawn in
eight common typefaces — a grotesque and a serif, each of those regular, bold,
italic and bold italic — and hunted for visually as well as read out of the
text layer.

Italic earns its place there. A slanted word is a different shape, not the same
shape drawn differently: an italic "KAG's" in a real slide's caption scored
0.386 against upright faces, which is indistinguishable from the page around
it, and 0.564 once a slanted template was among them — while the upright
occurrence on the same page was unaffected. Underlining needs nothing special:
the rule is a separate stroke below the baseline, and the letters still
dominate the match. Eight faces is twice the sweep of four, and this is the
slow half of the search; it is spent because a word the tool cannot match in
italics is a word it silently leaves in the document.

This is for the case the text layer cannot reach at all: a word inside a logo,
a scanned page, a screenshot, a chart label baked into a bitmap. On a page that
is purely ink, with an empty text layer, typing `KAG` finds every occurrence of
it — set in sans, set in bold, set in serif — and leaves the rest of the page
alone. A picture of a word shares the word's placeholder, so `[T1]` covers the
written mentions and the pictured ones alike.

**Colour does not matter — only shape does.** The correlation removes the mean
and the deviation from both sides before comparing, so brightness and contrast
were never a factor, and it ignores the sign of the result, so a polarity flip
is not one either. The word is found in black on white, white on black, white
on navy, a brand colour on white, yellow on black, red on green, grey on grey,
and a pair of colours of nearly the same brightness — eight combinations, all
scoring above 0.95, each one a test.

The one case that cannot work is two colours of genuinely identical
brightness, since the shape then has no edge to correlate at all. In practice
that does not arise: text nobody can read is text nobody typeset.

**It is not OCR, and the difference matters.** It finds the word set in
something close to one of those four faces. It will miss a stylised logotype,
an unusual face, letter-spaced capitals, and anything curved or rotated. Every
hit is proposed for review like any other, and a search that finds nothing says
so — but do not read a clean result as proof the word is absent. Treat it as a
second pair of eyes, never as a guarantee.

It costs four templates per word — one per typeface — searched in the same
single pass as everything else. It is off by default and runs only when you
press Redact.

A word that is real text *and* recognisable by its shape is found twice, once
by each route. Only one mark is kept: the one from the text layer, since it
comes from glyph positions rather than from correlating a rendering. The
duplicate is set aside rather than deleted, so removing the term brings it
back rather than leaving a hole.

### How a word inside a picture is found

**Also look for these words as pictures** is on, and reads each page rather
than matching drawn shapes against it.

It used to be off, on the reasoning that the text layer covers the ordinary
case. It does not, and the way it fails is the one this program exists to
prevent: a real slide had six visible occurrences of a name, four of them drawn
as outlines rather than text, so the text layer held two — and the panel
reported "4", which reads like the whole answer. The document came back with
the name still on it four times and nothing anywhere saying so. The reader is
fetched once and only when Redact is pressed, so nobody who does not redact
pays for it; covering a document by halves, silently, is not bounded at all. That is a different thing entirely: matching
never
knows what the letters are, which is why italic needed its own typefaces,
twelve-pixel captions needed the page resampled, and a four-letter acronym
needed a bar of its own. Reading the glyphs makes all of those ordinary.

Measured on three real documents: six of six occurrences on one page including
both italic ones, three of three on another including a caption that scored
0.314 against a template, and none at all on a deck where the same acronym had
matched 333 times. There is no threshold involved.

It costs about 6.7 MB the first time, fetched from this site and then kept by
the browser — there is nothing to install, and nothing is sent anywhere. Pages
are read a few at a time: about 0.8 seconds a page on four cores, against eight
before the WebAssembly build was pinned correctly and the reading was split
across engines.

### Checking the reading, thoroughly

OCR misreads, and it says so when it does. On a real slide the badge reading
`("KNW")` came back as `CRW)` at 41 confidence while every word around it read
at 90 or better — the reading was wrong, and the number said so.

The tool used to act on that directly, outlining every poorly-read spot that
could plausibly be one of the terms. Three rounds of narrowing went into making
that list short: the reading had to be about the right length once a badge's
punctuation was stripped, about the size of the other words on the page rather
than a speck, and in a box the word could actually fill at that size. It was
still 583 spots across 96 pages on a real deck.

That is not a warning. At that volume it is a texture a reviewer learns to
scroll past, and worse, it asks them to adjudicate something they have no way
to judge: nothing on the page tells a human whether `ae` at 18 confidence was
once a name. The feature was removed.

What replaced it is a button, offered once a redaction has been done, that
searches every page for the *shape* of each word in all eight typefaces —
the method the reader replaced, run in full as a second opinion. Anything it
turns up that the reading missed becomes an ordinary mark, drawn in **amber**
so it is obvious which ones are new. A found word is a fact a reviewer can
check at a glance; a doubtful spot was a question they could not answer.

Spots already marked are not proposed again, or the handful of genuine
additions would be buried in hundreds of duplicates — which is exactly how the
old list failed.

It is slow, which is why it is a button. Measured on pages the size of a real
slide, about two megapixels: one word in eight typefaces took 7.9 seconds on a
single dense page of text, and 3.3 seconds a page across two lighter ones, the
difference being parallelism and how much of each page survives the coarse
pass. A second word roughly doubles it. The panel states the estimate for the
document actually open, scaled by its own page size.

If the reader cannot be loaded at all, the words are hunted for by shape
instead and the panel says so. That is the older method, kept as the fallback:
it is less reliable on italic and on small lettering, and it is the only thing
that has a sensitivity control, which appears only when it is what is running.

It does not replace the image search. A logo, a signature or a stamp has no
letters in it, and those stay with the matcher.

The shape fallback has no control of its own. It used to have a **Word match**
slider; reading the pages has no threshold, so the slider governed a method the
reviewer almost never meets and asked them to tune something they had no way to
judge. It runs at the value measured across three documents, with the same
relief for long words.

## Matching a logo everywhere it appears

Click **Pick a logo to match** and drag a box around a logo, a stamp, a
signature, a face — anything visual. Blinded searches every page for it and
proposes a box over each place it finds. Removing the picked logo from the
list withdraws all of its matches at once.

The method is normalised cross-correlation on greyscale. Both the template and
the patch under test have their mean subtracted and are divided by their
standard deviation before being correlated, which is what lets it find the same
mark printed lighter, scanned at a different exposure, or photocopied onto a
darker page — cases where the absolute pixel values share nothing and the
structure is identical.

Six things make it work on real documents rather than only on tidy ones, and
every one exists because a version without it failed on a real file:

- **Your pick is trimmed to the ink inside it.** Nobody drags a tight box. The
  margin of blank page you include is noise in the correlation, and worse, it
  makes the template's size depend on how you dragged rather than on the logo,
  so every size in the sweep is measured against the wrong reference.
- **Sizes from a quarter to nearly four times the picked one are searched.**
  The original swept 0.6x to 1.75x, which meant a mark at half size or double
  size could not be found at any threshold at all. That single limit was the
  main reason it reported nothing on real files.
- **A template is never sized by its long side alone.** A 600x30 wordmark
  scaled so its long side is 14 pixels becomes a template *one pixel tall*,
  with no structure left to match. Wide marks are now kept several pixels tall
  and allowed to be longer instead.
- **A wordmark is nominated at a taller size than a monogram.** Several pixels
  turned out not to be enough. How far a mark can be shrunk before nomination
  loses it depends on where it keeps its identity: a roundel is a shape and is
  still itself at 19x20, while a wordmark is letters, and the letters live in
  its height. Squashing 451x44 of lettering to 72x7 made every letter the same
  grey smear, and a logo cut out of a real deck was then not found at the very
  pixels it had been cut from — nomination proposed its true position with an
  overlap of zero, so verification never got to score it. Forced to score that
  position by hand, the same template refined to 0.90. Four reasonable
  hand-drawn crops of one logo scored 0.38, 0.45, 0.50 and 0.51; three of them
  now match. Keeping the extra rows costs about three times the nominating
  work, so it is spent only on marks at least three times longer than they are
  tall, and an ordinary mark is sized exactly as before.
- **The size ladder contains exactly 1.0.** It used to be 0.25 × 1.25ⁿ, whose
  rungs straddle 1.0 at 0.954 and 1.192 — so the one size guaranteed to matter
  was never tried. A picked logo is at scale 1.0 by definition, and so is every
  copy printed at the same size, which on a letterhead is most of them.
- **Correlation tests every position.** There was a stride here, on the
  reasoning that the sweep only needs to get close. Sampling an image at a
  coarser interval than the feature you are looking for does not approximate
  the answer, it misses it: on a small logo the coarse template is around
  20 × 11, and stepping two pixels dropped the score at the true position from
  0.765 to 0.374 — under the threshold, so the page reported nothing found.
- **The final score is taken at the template's own resolution.** Scoring on a
  shrunken copy is not merely imprecise, it is unstable: three identical logos
  on one page scored 0.977, 0.845 and 0.738, and what differed between them was
  where the downsampling landed relative to their strokes, not their content.

The search runs in three passes, because locating something and deciding
whether it is really the same thing are different jobs with different
requirements. A cheap sweep over every size nominates candidates; refinement
finds where each one actually sits; and verification re-scores the plausible
ones at full resolution, choosing the size itself rather than inheriting
refinement's guess. At the picked size nothing is resampled at all, so a copy
identical to the pick correlates against it exactly and scores 1.0.

**Match sensitivity** sets the correlation threshold, defaulting to 0.75.
Moving it discards any results already found and marks the picked images as
needing another search, rather than re-sweeping the document as you drag.
Lowering it finds more and also finds things that merely resemble the logo —
the suite has a test asserting exactly that, because it is a real property of
the method rather than a caveat worth burying. If a search comes back empty it
tells you the best score it actually saw, so you can tell a threshold that is
too strict from a mark that genuinely is not there.

### How long it takes

A run shows one bar per leg of the job — reading the pages, searching them for
a picked image — both drawn from the start, and a leg with no work in it not
drawn at all. This was a single bar across the whole job for a while, on the
reasoning that two filling in sequence would read as the first having lied.
That is true of bars that appear one after the other, and not of bars that are
both there from the beginning: together they say what the job consists of
before it starts, and when a run is paused they say which part of it got how
far. "Read to 40 of 100, images not started" is a different situation from "40
per cent done", and someone deciding whether to keep waiting needs to know
which one they are in.


Everything you have marked is searched for in **one pass over the document**,
not one pass per image. That matters more than it sounds on a long file: the
first version swept all hundred pages for the first logo, then all hundred
again for the second, and four times more for each typed word, decoding every
page from its canvas again each time.

That pass is also split across cores, since no page's result depends on any
other's. Measured on a twelve-page fixture with five templates — one picked
logo and one word in the four typefaces of the time (there are eight now):

| | |
| --- | ---: |
| a sweep per template, as it was | 17.6s |
| one pass, every template together | 15.2s |
| that pass, spread across cores | **5.7s** |

Identical results in all three — the same thirty-six matches in the same
places — so the only thing that changed is the clock. The end-to-end suite
asserts that equivalence rather than assuming it.

Roughly, then: half a second per page per image on a few cores. Fewer terms
and fewer logos in one go is proportionally faster, and the progress message
names the page it is on so a long document is at least legible while it works.
Verification, the expensive stage, is spent only on candidates refinement has
already rated plausible.

What it does not do, stated plainly rather than left to be discovered:

- **It does not rotate.** A logo turned even slightly will not be found.
- **It ignores colour entirely**, including which of the two colours is the
  ink. A mark and the same mark knocked out of a dark banner are the same
  mark. For redaction that errs the safe way — one logo too many covered,
  rather than one missed.
- **It does not know what a logo is.** It matches structure. A repeated table
  rule or a column of identical bullets can score highly, which is why every
  match is proposed and clickable rather than applied.
- **A blank or near-blank pick is refused** rather than matched against every
  empty patch on the page.
- **A very wide mark repeated very small may be missed.** This one is a limit
  of the method rather than a bug: at 0.46x, a 13:1 wordmark renders about
  thirteen pixels tall, and the vertical detail that identifies it has been
  resampled below a pixel before the matcher sees it. Structure that is not in
  the image cannot be recovered by searching harder — this was measured, not
  assumed. Compact marks do not have the problem; the square-logo test finds
  every copy at 0.99. If you hit it, cover the small copies by hand.

## Undoing

Every change you make by hand can be undone, with the **Undo** button beside
the document name or with Ctrl+Z (Cmd+Z on a Mac): a box you drew, a box you
removed, a detection you dismissed or restored, a logo you picked or removed.
The button names what it will undo, so you can see what is about to happen
before it does. Undo does not cover the detectors' own findings, which rebuild
themselves from the settings whenever those change.

Ctrl+Z inside the text box is left alone — there, it means the text box's undo,
which is what anyone typing would expect.

## Placeholders instead of blanks

A black bar says something was removed. It does not say *what*, and that costs
more than it sounds: "____ transferred the account to ____" is nearly
unreadable, while "[P1] transferred the account to [P2]" carries
the whole sentence. Tick **Label each redaction** and every bar gets a
placeholder written into it.

The property that makes this useful rather than decorative is **consistency**:
the same value gets the same placeholder everywhere it appears, on every page.
That is what lets a reader — or a model — tell that the person in paragraph two
is the person in paragraph nine. Casing does not break it: `Jane Doe`, `JANE
DOE` and `jane doe` are one person and one placeholder. Every match of one
picked logo shares a placeholder too, for the same reason.

Placeholders are suggested by kind and kept deliberately short — `P1` a person,
`E2` an email, `PH1` a phone number, `C1` a card, `L1` a logo, `R3` a
hand-drawn box. Terse because a placeholder has to fit inside the bar it
labels, and a bar is only as wide as whatever it covers.

A long label is not usually dropped — it is shrunk to fit, which is worse for
being less obvious. Measured on the test document: over a bar covering a
five-digit postcode, `[PC1]` draws at the bar's full height of 22.8px while
`[POSTCODE_1]` is squeezed to 9.8px. Over a name, `[P1]` holds 22.8px against
`[PERSON_1]`'s 17.8px. Below 7px nothing is drawn at all. The legend carries
the meaning instead, so the short form loses nothing.

**Every placeholder is editable.** Rename `P1` to `CLAIMANT` and all of its
occurrences change together — and a name you choose usually says more than any
code will. A longer name is only drawn where the bar is wide enough for it. A
typed term is only guessed to be a person when it is shaped like a name;
`Account 4471` becomes `T1`, not a person.

Two options come with it:

- **Machine-readable placeholders** adds an invisible text layer containing the
  placeholders *and nothing else*, so tools that extract text rather than look
  at the page read them too. The visible white label and the invisible text
  come from one list, so they cannot disagree.
- **A legend page** is appended to the export, listing each placeholder and
  what kind of thing it stands for.

### The legend and the key are not the same file

This is the part worth reading twice.

The **legend** — the one in the document — carries placeholders and categories
only: `[P1] — a person's name — appears 3 times`. It never records what
anything was. A legend inside a redacted document that mapped `[P1]` back
to a name would undo the entire redaction, which is the failure this whole
program exists to prevent.

The **key** is the mapping back to the originals. It is a separate download,
behind its own button, named `…-KEY-KEEP-PRIVATE.json`, and it carries a header
saying what it is. It reconstructs everything the redaction removed. Keep it
somewhere else, and never send it with the document.

The test suite asserts both halves: that a labelled export contains the
placeholders as extractable text, and that none of the values they replaced
appear anywhere in the finished bytes.

## Marking up, then redacting

Blinded works in two steps, and nothing happens to the document until you ask
for it.

**Mark up.** Type the text you want covered, pick the logos you want found,
drag boxes over anything else. Every mark appears as a **red outline** with the
content still readable underneath — which is the point of reviewing, and
impossible once a bar is filled in. Picking a logo does not search for it yet;
it joins the list marked *not searched yet*.

**Press Redact.** Every outstanding image search runs, then everything you
marked turns solid black — exactly what the exported file will contain. Export
becomes available only at this point, so you cannot export a document you have
not seen the result of.

Change anything afterwards — a term, a detector, the sensitivity, a box — and
the document goes back to outlines and Export switches off again. A black bar
that no longer reflects the current settings is precisely the kind of stale
reassurance this program exists to avoid.

This replaced an earlier design where everything happened live. It was wrong in
a way that only shows up on a real document: picking a logo swept every page
before you had finished saying what else to cover, and picking a second one
made you wait through it again. Searching is now something you trigger, once,
when you have finished describing the job.

## Reviewing

- Before Redact, everything marked is outlined in red and still readable.
  After it, detected values and matched images are covered with a solid black
  bar — exactly what the export will contain, since the preview and the export
  are built from the same list of boxes. The preview is never more reassuring
  than the result.
- **Click a bar** to turn that one off. It becomes a dashed amber outline, so a
  mistaken dismissal is visible, and clicking it again turns it back on.
- **Drag on the page** to add a box by hand. Click a box you drew to remove it.
  This is the only way to cover anything on a page with no text layer.

## Working in another tab

A browser starves a tab you are not looking at, and two of its economies used
to stop this program dead.

`requestAnimationFrame` does not fire in a hidden tab at all — there are no
frames to animate — and pdf.js continues a page render from an rAF callback. So
opening a document and switching tabs parked the render mid-way until you came
back. Timers are throttled too, to about one call a second and eventually one a
minute, which would have made the per-page yield during a search absurd.

Both now schedule through a message channel instead, which is an ordinary task
rather than a frame or a timer and is not throttled. Rendering and searching
continue at full speed with the tab in the background. The search itself runs
in workers, which were never throttled to begin with.

The suite tests this by simulating a hidden tab exactly — the page reports
itself hidden and `requestAnimationFrame` records the call and never fires —
and includes the control that matters: with frames equally dead but the page
claiming to be visible, rendering *does* stall. Without that control the test
would prove nothing.

What no page can decline is being **frozen** outright, which is a separate
mechanism a browser may apply to a long-idle background tab. If you leave a
very long document mid-search for a long time, come back and check it finished.

## Known limits

- **Scanned documents have no text layer.** If a PDF is a photograph of a page,
  the detectors find nothing, because there is nothing to read. There is no
  OCR. Two things still work on a scan, because both read pixels: picking a
  logo, and looking for a typed word as a picture — so a repeated letterhead, a
  signature, or a name set in an ordinary face can still be found and covered.
- **Form fields and annotations are drawn but not searched.** pdf.js reports
  page text, not annotation contents, so a value typed into a form field is
  visible on the page and will not be detected. Cover those by hand.
- **Rotated text is approximated.** Boxes are axis-aligned, so text on an angle
  gets its bounding box rather than a tight one.
- **Character positions inside a run are reconstructed, not reported.** PDF
  gives the width of a whole run, not of each glyph, so Blinded measures the
  run with the page's own font and normalises against the known total. Boxes
  are padded outward and never inward, so the worst case is covering a
  neighbouring character rather than leaving one showing.
- **Password-protected PDFs are refused.** Remove the password first.
- No DOCX, XLSX or PPTX. Those are archives of XML with their own hiding
  places, and half-supporting them would be worse than not.

## Check the output

The habit worth keeping, whatever tool you use: open the exported file, select
all, copy, and paste it somewhere. If anything you redacted comes back, the
redaction failed.

With Blinded nothing should. Without labelling there is no text to select at
all. With labelling on there is exactly one kind of text — the placeholders —
and if you can select `[P1]` but not the name it replaced, it worked.

## Tests

```
npm test        # detectors, geometry and the PDF writer, in node
npm run test:ui # the real page in a real browser, end to end
```

`npm test` builds a PDF that genuinely contains text, runs it through the
pipeline, and re-opens the result to prove the text is gone. `npm run test:ui`
drives the actual interface with Playwright: it loads that PDF, checks the
detections, clicks a bar off and back on, drags a box, exports, and then
verifies the downloaded file contains no text objects and none of the secrets
as raw bytes. It also opens a second fixture whose logo is drawn four times
across two pages, at two sizes, with path operators rather than a shared image
object — so the pixel matcher is genuinely under test rather than a shortcut
through the PDF's structure — picks one copy, and asserts the other three are
found, a fifth decoy mark is not, and the matches are painted black. It also renders a deliberately adversarial line — narrow glyphs
before a card number, where estimating character positions by even division is
badly wrong — and asserts the bar covers the value's ink from first pixel to
last.

## Layout

```
index.html        the page
app.js            the controller: load, review, export
app.css           all of the styling
lib/detect.js     rules that propose spans, and the checksums behind them
lib/labels.js     placeholder naming, and the legend/key boundary
lib/textimage.js  draws a typed word so the matcher can hunt for it
lib/boxes.js      character spans to rectangles on a page
lib/measure.js    real glyph advances, so a bar lands on its text
lib/match.js      normalised cross-correlation, trimming, on plain arrays
lib/imagesearch.js  the search: nominate widely, re-score, one pass, many cores
lib/searchworker.js one core's share of that search
lib/schedule.js   keeps work moving when the tab is in the background
lib/pdfread.js    pdf.js wrapper: page images plus positioned text
lib/pdfwrite.js   builds the image-only output PDF
lib/render.js     burns boxes into pixels and encodes them
vendor/           pdf.js, so the page never fetches code from elsewhere
tools/            the two test suites, a fixture builder, a static server
```

## Licence

pdf.js in `vendor/` is Apache-2.0; its licence is alongside it.
