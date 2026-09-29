// The landing pages, rendered from content/pages.mjs.
//
// One shell, six pages. Written as six HTML files they would drift: the
// header would be updated on five of them, the canonical would be wrong on
// one, and the structured data would end up describing a page that had been
// edited since. Here the shell exists once and the content exists once, and
// the self-test fails if what is on disk is not what this would write.
//
//   node tools/pages.mjs          rewrite the pages and the sitemap
//   node tools/pages.mjs --check  say whether they are current
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, pages, moved, GALLERY } from '../content/pages.mjs';
import { pages as legal } from '../content/legal.mjs';
import { footer } from './footer.mjs';

// Through fileURLToPath rather than .pathname. On Windows a file URL's
// pathname is "/C:/Users/..." -- with a leading slash -- and resolve() reads
// that as a path rooted at the current drive, so it hands back "C:\\C:\\Users".
// fileURLToPath is the conversion that knows about drive letters.
const root = fileURLToPath(new URL('..', import.meta.url));

const esc = text => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// The policy the tool carries, read from the tool rather than repeated, so
// two pages of one site cannot end up with two different answers to "what may
// this reach".
function policy() {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const at = html.indexOf('<meta http-equiv="Content-Security-Policy"');
  return html.slice(at, html.indexOf('">', at) + 2);
}

// The mark, likewise.
function mark() {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const at = html.indexOf('      <svg class="markmark"');
  return html.slice(at, html.indexOf('</svg>', at) + 6);
}

function words(page) {
  const all = [page.lede, ...page.sections.flatMap(s => [s.h, ...s.p]),
    ...page.steps, page.who, ...page.faq.flatMap(f => [f.q, f.a])].join(' ');
  return all.split(/\s+/).filter(Boolean).length;
}

function structured(page) {
  const url = SITE + '/' + page.slug + '/';
  return JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: page.h1,
      description: page.description,
      mainEntityOfPage: url,
      image: [SITE + '/gallery/' + GALLERY[page.shot.slide].file + '-after.webp',
        SITE + '/gallery/' + GALLERY[page.shot.slide].file + '-before.webp',
        SITE + '/og.png'],
      about: { '@type': 'WebApplication', name: 'Blinded', url: SITE + '/',
        applicationCategory: 'SecurityApplication', operatingSystem: 'Any browser' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faq.map(one => ({
        '@type': 'Question', name: one.q,
        acceptedAnswer: { '@type': 'Answer', text: one.a },
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Blinded', item: SITE + '/' },
        { '@type': 'ListItem', position: 2, name: page.h1, item: url },
      ],
    },
  ], null, 2);
}

// A comparison, in the front page's table style. The first column after the
// row heading is Blinded's, and is marked as ours the way the front page does.
function table(t) {
  return `    <div class="versus-scroll">
      <table class="versus-table">
        <caption class="sr-only">${esc(t.caption)}</caption>
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">What is being compared</span></th>
${t.head.map((name, i) => '            <th scope="col"' + (i === 0 ? ' class="us"' : '') + '>' + esc(name) + '</th>').join('\n')}
          </tr>
        </thead>
        <tbody>
${t.rows.map(row => `          <tr>
            <th scope="row">${esc(row[0])}</th>
${row.slice(1).map((cell, i) => '            <td' + (i === 0 ? ' class="us"' : '') + '>' + esc(cell) + '</td>').join('\n')}
          </tr>`).join('\n')}
        </tbody>
      </table>
    </div>`;
}

// The other five, so every page is one click from every other and none of
// them is a dead end a crawler has to leave by the way it came in.
function alsoLinks(page) {
  return pages.filter(one => one.slug !== page.slug).map(one =>
    '        <li><a href="/' + one.slug + '/">' + esc(one.h1) + '</a></li>')
    .join('\n');
}

export function renderPage(page) {
  const url = SITE + '/' + page.slug + '/';
  const shot = page.shot;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${policy()}
<title>${esc(page.title)} – Blinded</title>
<meta name="description" content="${esc(page.description)}">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Blinded">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A slide before and after redaction: names and logos gone from the second copy.">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/app.css">
<script type="application/ld+json">
${structured(page)}
</script>
</head>
<body class="plainpage">

<header class="top">
  <div class="wrap top-inner">
    <a class="mark" href="/">
${mark()} Blinded</a>
    <div class="top-actions">
      <a class="top-link" href="/license/">License</a>
      <a class="top-link" href="/faq.html">Q&amp;A</a>
    </div>
  </div>
</header>

<main class="wrap">
<article class="view faqmain lander">

  <h1 class="faqtitle">${esc(page.h1)}</h1>
  <p class="lede">${esc(page.lede)}</p>

  <p class="landgo"><a class="landcta" href="/">Open the tool</a>
    <span class="landfree">Free below twenty pages, in your browser. Nothing is uploaded.</span></p>

  <figure class="landshot">
    <div class="landpair">
      <span><b>Before</b><img src="/gallery/${GALLERY[shot.slide].file}-before.webp"
        alt="${esc(GALLERY[shot.slide].before)}" loading="lazy" width="1280" height="720"></span>
      <span><b>After</b><img src="/gallery/${GALLERY[shot.slide].file}-after.webp"
        alt="${esc(shot.alt)}" loading="lazy" width="1280" height="720"></span>
    </div>
    <figcaption>${esc(shot.alt)}</figcaption>
  </figure>

${page.sections.map(one => `  <section class="faq">
    <h2>${esc(one.h)}</h2>
${one.p.map(para => '    <p>' + esc(para) + '</p>').join('\n')}${one.table ? '\n' + table(one.table) : ''}
  </section>`).join('\n\n')}
${page.sources ? `
  <section class="faq">
    <h2>Sources</h2>
    <p>${esc(page.sources.note)}</p>
    <ul class="landsources">
${page.sources.links.map(one => '      <li>' + esc(one.name) + ': <a href="' + esc(one.url)
    + '" rel="nofollow noopener">' + esc(one.url.replace(/^https?:\/\//, '')) + '</a></li>').join('\n')}
    </ul>
  </section>
` : ''}

  <section class="faq">
    <h2>How to do it, in four steps</h2>
    <ol class="landsteps">
${page.steps.map(step => '      <li>' + esc(step) + '</li>').join('\n')}
    </ol>
  </section>

  <section class="faq">
    <h2>Who it is for</h2>
    <p>${esc(page.who)}</p>
    <p class="landgo"><a class="landcta" href="/">Open the tool</a></p>
  </section>

  <section class="faq">
    <h2>Questions</h2>
${page.faq.map(one => `    <h3>${esc(one.q)}</h3>
    <p>${esc(one.a)}</p>`).join('\n')}
  </section>

  <section class="faq">
    <h2>Also</h2>
    <ul class="landalso">
${alsoLinks(page)}
    </ul>
  </section>

  <p class="faqback"><a class="faqbackbtn" href="/">Back home</a></p>


</article>
</main>
${footer(null)}

</body>
</html>
`;
}

// A page that has been merged into another. A page rather than a redirect
// rule in render.yaml, for the reason given in premium/index.html: Render
// skips a rule wherever a file exists, and applies render.yaml only to a
// Blueprint. An instant refresh works either way and is read as a permanent
// move. Not in the sitemap, and not indexed: the canonical says where it went.
export function renderMoved(one) {
  const target = pages.find(page => page.slug === one.to);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Written by tools/pages.mjs: this page was merged into /${one.to}/. -->
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  style-src 'self';
  img-src 'self';
  base-uri 'none';
  form-action 'none'">
<meta http-equiv="refresh" content="0; url=/${one.to}/">
<link rel="canonical" href="${SITE}/${one.to}/">
<meta name="robots" content="noindex">
<title>${esc(target.title)} – Blinded</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="plainpage">
<main class="wrap">
  <p>This page is now part of <a href="/${one.to}/">${esc(target.h1)}</a>.</p>
</main>
</body>
</html>
`;
}

export function renderSitemap() {
  const rows = [
    { loc: SITE + '/', freq: 'weekly', pri: '1.0' },
    { loc: SITE + '/faq.html', freq: 'monthly', pri: '0.8' },
    { loc: SITE + '/license/', freq: 'monthly', pri: '0.8' },
    ...pages.map(one => ({ loc: SITE + '/' + one.slug + '/',
                           freq: 'monthly', pri: '0.7' })),
    // Last, and low. They have to be crawlable -- a refund policy nobody can
    // find is not a refund policy -- but nobody arrives at this site looking
    // for them.
    ...legal.map(one => ({ loc: SITE + '/' + one.slug + '/',
                           freq: 'yearly', pri: '0.3' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by tools/pages.mjs. Every page of the site and nothing else: a
     sitemap listing assets, or URLs that do not exist, is a sitemap a crawler
     learns to distrust. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map(one => `  <url>
    <loc>${one.loc}</loc>
    <changefreq>${one.freq}</changefreq>
    <priority>${one.pri}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

// The living keyword list: what each page is meant to answer, in one place,
// so it can be read and revised without opening six files.
export function renderKeywords() {
  return `# What each page is for

Two kinds of search. The broad ones people type most -- "how to redact a
PDF", "redact an image", "AI redaction" -- each get a real guide. The ones
with a job in them -- "why is my redacted text still selectable" -- come from
somebody who has hit the problem and is looking for the way out.

Edit \`content/pages.mjs\` and run \`node tools/pages.mjs\` to rewrite the
pages, this list and the sitemap together.

${pages.map(one => `## [${one.h1}](${SITE}/${one.slug}/)

\`/${one.slug}/\` · ${words(one)} words · ${one.faq.length} questions

${one.keywords.map(k => '- ' + k).join('\n')}`).join('\n\n')}

## Still to write

Kept here rather than in a head, so the next round starts from a list instead
of from scratch.

- nothing queued
`;
}

const run = process.argv[1] && process.argv[1].endsWith('pages.mjs');
if (run) {
  const checking = process.argv.includes('--check');
  const want = new Map();
  for (const page of pages) {
    want.set(page.slug + '/index.html', renderPage(page));
  }
  for (const one of moved) {
    want.set(one.slug + '/index.html', renderMoved(one));
  }
  want.set('sitemap.xml', renderSitemap());
  want.set('KEYWORDS.md', renderKeywords());

  const stale = [];
  for (const [path, body] of want) {
    const full = resolve(root, path);
    const now = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (now === body) continue;
    stale.push(path);
    if (checking) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  if (checking) {
    console.log(stale.length
      ? 'STALE - run: node tools/pages.mjs\n  ' + stale.join('\n  ')
      : 'the landing pages are current');
    process.exit(stale.length ? 1 : 0);
  }
  console.log(stale.length
    ? 'wrote ' + stale.length + ' file(s):\n  ' + stale.join('\n  ')
    : 'nothing to do');
}
