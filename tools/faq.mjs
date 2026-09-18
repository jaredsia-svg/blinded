// The questions page's structured data, written from the questions page.
//
// Search engines read `FAQPage` data to show a question and its answer in the
// results, and they check it against what the page actually says: data that
// has drifted from the page is treated as a lie about the page, which costs
// more than having none. So it is not written by hand. It is read out of the
// markup every time, and the self-test fails if the copy in the file is not
// what this would produce.
//
//   node tools/faq.mjs          rewrite the block in faq.html
//   node tools/faq.mjs --check  say whether it is already current
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(new URL('..', import.meta.url).pathname, 'faq.html');

// The few entities the questions actually use. A full HTML parser for eight
// headings and their paragraphs would be a dependency for nothing.
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
};

function plain(html) {
  const bare = html.replace(/<[^>]+>/g, '');
  const said = bare.replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m] ?? m);
  return said.replace(/\s+/g, ' ').trim();
}

export function faqData(source) {
  const page = source ?? readFileSync(FILE, 'utf8');
  const questions = [];
  for (const [, body] of page.matchAll(/<section class="faq">([\s\S]*?)<\/section>/g)) {
    const asked = /<h2>([\s\S]*?)<\/h2>/.exec(body);
    if (!asked) continue;
    const answer = plain(body.slice(body.indexOf('</h2>') + 5));
    if (!answer) continue;
    questions.push({
      '@type': 'Question',
      name: plain(asked[1]),
      acceptedAnswer: { '@type': 'Answer', text: answer },
    });
  }
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: questions };
}

// The block as it should read, indented the way the file is.
function blockFor(page) {
  return JSON.stringify(faqData(page), null, 2);
}

function currentBlock(page) {
  const found = /<script type="application\/ld\+json" id="faq-ld">\n([\s\S]*?)\n<\/script>/
    .exec(page);
  return found ? found[1] : null;
}

export function faqIsCurrent(source) {
  const page = source ?? readFileSync(FILE, 'utf8');
  return currentBlock(page) === blockFor(page);
}

const run = process.argv[1] && process.argv[1].endsWith('faq.mjs');
if (run) {
  const page = readFileSync(FILE, 'utf8');
  if (process.argv.includes('--check')) {
    const ok = faqIsCurrent(page);
    console.log(ok ? 'faq.html structured data is current'
      : 'faq.html structured data is STALE - run: node tools/faq.mjs');
    process.exit(ok ? 0 : 1);
  }
  const written = page.replace(
    /(<script type="application\/ld\+json" id="faq-ld">\n)[\s\S]*?(\n<\/script>)/,
    (_, open, close) => open + blockFor(page) + close);
  writeFileSync(FILE, written);
  console.log('wrote ' + faqData(page).mainEntity.length
    + ' questions into faq.html');
}
