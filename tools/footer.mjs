// The footer every page carries: the front page's two rows. The generated
// pages take it from here, so they cannot drift apart; the hand-written ones
// (the front page, the questions, the license and the buying page) repeat it
// and the self-test compares them against this.
//
// `current` is the link of the page being read, marked with aria-current.

export function footer(current) {
  const link = (href, text, extra = '') => `  <a class="footlink" href="${href}"${extra}`
    + `${href === current ? ' aria-current="page"' : ''}>${text}</a>`;
  const dot = '  <span class="foot-dot" aria-hidden="true">&middot;</span>';
  return [
    '<!-- The same footer on every page: the front page\'s two rows. -->',
    '<p class="foot">',
    '  <span class="foot-row">',
    '  <span class="foot-name">Blinded</span>', dot,
    link('/faq.html', 'FAQ'), dot,
    link('/license/', 'License'), dot,
    link('/verify/', 'Verify'), dot,
    link('mailto:support@blinded.dev', 'Contact', ' title="support@blinded.dev"'),
    '  </span>',
    '  <span class="foot-row foot-fine">',
    link('/privacy/', 'Privacy'), dot,
    link('/terms/', 'Terms'), dot,
    link('/refunds/', 'Refunds'), dot,
    link('https://github.com/jaredsia-svg/blinded', 'Source', ' rel="noopener"'),
    '  </span>',
    '</p>',
  ].join('\n');
}
