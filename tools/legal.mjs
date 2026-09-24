// Writes the three legal pages from content/legal.mjs.
//
// Generated rather than hand-written for the same reason the landing pages
// are: the header, the policy, the icons and the foot are the same on every
// page of this site, and three more hand-kept copies of them is three more
// places to forget something. The words are in content/legal.mjs; the shape
// is here.
//
//   node tools/legal.mjs          rewrite them
//   node tools/legal.mjs --check  say whether they are already current
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pages, JURISDICTION } from '../content/legal.mjs';

// Through fileURLToPath rather than .pathname, for the Windows drive letter.
const root = fileURLToPath(new URL('..', import.meta.url));
const SITE = 'https://blinded.dev';

const MARK = `<svg class="markmark" viewBox="0 0 26 15" aria-hidden="true" focusable="false">
        <g fill="currentColor">
          <rect width="26" height="6.4" rx="2"/>
          <rect y="8.6" width="14" height="6.4" rx="2"/>
          <rect x="16.6" y="8.6" width="3.6" height="6.4" rx="1.5"/>
          <rect x="22.2" y="8.6" width="2" height="6.4" rx="1"/>
        </g>
      </svg>`;

// The other two, so each page carries the ones it is not. Somebody reading
// the refund policy is often about to want the terms.
export function siblings(slug) {
  return pages.filter(one => one.slug !== slug)
    .map(one => `<a href="/${one.slug}/">${one.title}</a>`).join(' · ');
}

export function renderLegal(page) {
  const body = page.sections.map(one => `  <h2>${one.h}</h2>\n`
    + one.p.map(text => `  <p>${text}</p>`).join('\n')).join('\n\n');

  // Said once, at the top, rather than in a clause nobody reaches. A page
  // that cannot say which country's law applies should say so out loud.
  const law = JURISDICTION
    ? `  <p class="hint">These terms are governed by the law of ${JURISDICTION}.</p>\n`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Written by tools/legal.mjs from content/legal.mjs. Do not edit here. -->
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  connect-src 'self';
  frame-src 'none';
  object-src 'none';
  base-uri 'none';
  form-action 'none'">
<title>${page.title} – Blinded</title>
<meta name="description" content="${page.description}">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="canonical" href="${SITE}/${page.slug}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Blinded">
<meta property="og:title" content="${page.title} – Blinded">
<meta property="og:description" content="${page.description}">
<meta property="og:url" content="${SITE}/${page.slug}/">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A slide before and after redaction: names and logos gone from the second copy.">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/app.css">
</head>
<body class="plainpage">

<header class="top">
  <div class="wrap top-inner">
    <a class="mark" href="/">
      ${MARK} Blinded</a>
    <div class="top-actions">
      <a class="top-link" href="/premium/">License</a>
      <a class="top-link" href="/faq.html">Q&amp;A</a>
    </div>
  </div>
</header>

<main class="wrap">
<article class="view faqmain lander">

  <h1 class="faqtitle">${page.h1}</h1>
${page.slug === 'terms' ? law : ''}
${body}

  <p class="faqback"><a class="faqbackbtn" href="/">Open the tool</a></p>

  <p class="hint">${siblings(page.slug)}</p>

</article>
</main>

</body>
</html>
`;
}

const want = new Map(pages.map(one =>
  [join(one.slug, 'index.html'), renderLegal(one)]));

// Only when this is the program being run. Without this line, the self-test
// importing renderLegal to compare against the files on disk would fall
// through to the branch below and rewrite them -- so the check would repair
// the drift it exists to find, and pass. It did, until it was tried.
const run = process.argv[1] && process.argv[1].endsWith('legal.mjs');

if (!run) {
  // imported for renderLegal; nothing to do
} else if (process.argv.includes('--check')) {
  const stale = [...want].filter(([where, text]) =>
    !existsSync(resolve(root, where))
    || readFileSync(resolve(root, where), 'utf8') !== text);
  if (stale.length) {
    console.error('stale: ' + stale.map(([where]) => where).join(', '));
    process.exit(1);
  }
  console.log('the legal pages are current');
} else {
  for (const [where, text] of want) {
    mkdirSync(resolve(root, where, '..'), { recursive: true });
    writeFileSync(resolve(root, where), text);
  }
  console.log('wrote ' + want.size + ' page(s):\n  '
    + [...want.keys()].join('\n  '));
}
