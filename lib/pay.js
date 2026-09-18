// What this deployment charges for, and nothing else.
//
// One file, so that turning payment on, moving the threshold or changing a
// price is one edit in one place rather than a search through the program.
// A fork with `on: false` is the whole tool, free, forever — which is the
// state this ships in.
//
// The key here is the public half of a pair made by tools/pass.mjs. It can
// only check a pass, never mint one, so publishing it costs nothing: that is
// the point of signing rather than looking up.
(function (root) {
  'use strict';

  const settings = {
    // Off. Payment is a thing this deployment can do, not a thing the program
    // does — and a paywall that shipped switched on before anybody had
    // arranged to take the money would be a broken tool rather than a
    // profitable one.
    on: false,

    // Everything is free below this. Twenty pages covers a contract, a
    // letter, a scan of something that came in the post: the jobs somebody
    // does once and would not pay for. It is not a trial that runs out.
    freePages: 20,

    // What is actually charged for: writing the finished file. Everything
    // before that — opening, reading, searching, marking, reviewing, saving a
    // draft — is free at any length, so nobody discovers the price after
    // doing the work.
    //
    // A gate at opening would be worse and a gate at searching would be
    // dishonest: the reviewer has to be able to see what the tool finds
    // before deciding it is worth three dollars.
    charge: 'export',

    prices: [
      { id: 'days', label: '5 days', price: 'USD 2.99', days: 5,
        note: 'For one job.' },
      { id: 'month', label: 'a month', price: 'USD 6.99', days: 31,
        note: 'For a run of them.' },
    ],

    // Where buying happens: a page of its own, so that the page holding the
    // document keeps a content security policy that cannot reach a payment
    // processor. See render.yaml.
    where: '/unlock.html',

    // Paddle, as merchant of record. Which means Paddle sells the licence and
    // handles the VAT, rather than us registering for sales tax in forty
    // jurisdictions over a three-dollar sale.
    //
    // Filled in from the Paddle dashboard. The token is publishable and is
    // meant to be in the page; the API key is not and never appears here.
    paddle: {
      environment: 'sandbox',        // 'production' when it is
      token: '',                     // the client-side token, pll_...
      // The price IDs, one per row of `prices` above, pri_...
      priceIds: { days: '', month: '' },
    },

    // The one service this project has, and the only thing it does: watch for
    // a payment Paddle says happened, and sign a pass. It never sees a
    // document, is never asked anything by the page holding one, and is
    // reachable only from the buying page. Empty means the pass arrives by
    // email and is typed in instead, which also works.
    mint: '',

    // The development key. tools/pass.mjs made it, here, in a sandbox that no
    // longer exists — so nobody can mint a pass against it, including us.
    // Replace it with your own before switching `on`, and the self-test will
    // tell you if you forget.
    key: {"kty":"EC","crv":"P-256","x":"OSCwdiuORozb803Hn4MA4amf8oe-3elb4VNneL5yaHQ","y":"WDZilDk83iqQaMU50-iQakPfPZfihm7M6rEZBvM7f1k"},
    keyIsDevelopment: true,
  };

  function paidFor(pages) {
    return Boolean(settings.on) && Number(pages) > settings.freePages;
  }

  root.BlindedPay = Object.assign(settings, { paidFor });
})(typeof window !== 'undefined' ? window : globalThis);
