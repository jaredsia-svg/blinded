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
      environment: 'production',     // 'sandbox' while trying it out
      // The client-side token. Sandbox ones begin test_, live ones begin
      // live_, and the two are not interchangeable: a test_ token against
      // production opens a checkout that fails without saying why. The
      // self-test holds the prefix and the environment to each other.
      //
      // This is the publishable one. The API key on the same screen in
      // Paddle begins pdl_ and is a secret; it is not needed by anything
      // here, and the self-test refuses to let one be pasted in below.
      token: 'live_5fa79e2f3c69fe190b79a97f44b',
      // The price IDs, one per row of `prices` above, pri_...
      priceIds: {
        days: 'pri_01m2x13zwme2e5v9vab11x0zwh',
        month: 'pri_01m2x14qczz2mwr165009qmf6a',
      },
    },

    // The one service this project has, and the only thing it does: watch for
    // a payment Paddle says happened, and sign a pass. It never sees a
    // document, is never asked anything by the page holding one, and is
    // reachable only from the buying page. Empty means the pass arrives by
    // email and is typed in instead, which also works.
    mint: 'https://blinded-mint.onrender.com',

    // The public half of the pair tools/pass.mjs made. It can check a pass
    // and cannot mint one, which is why it sits here in the page where
    // anybody may read it: the private half is the only secret, it is not in
    // this repository, and it is not on any machine that serves this file.
    //
    // Changing it invalidates every pass ever sold, because a pass is only a
    // pass against the key that signed it. The self-test imports this to
    // check it is a whole key -- a P-256 key is two coordinates, and half of
    // one looks like a key, passes every other check, and makes the page call
    // every genuine pass a forgery.
    key: {"kty":"EC","crv":"P-256","x":"JbmaKpKZ93MeuFMZjIgurrRklo6VaNsCacsJG4V7cHk","y":"jdxOEvapGepNtGhXIpy7rWe6R_mSGwEsoDLCIZzuiD4"},
  };

  function paidFor(pages) {
    return Boolean(settings.on) && Number(pages) > settings.freePages;
  }

  // The price cards, drawn from the settings above.
  //
  // Here rather than in the page that shows them, because two pages show
  // them: /premium/ and the same content pulled into the tool's own view,
  // where the page's script has not run and cannot. Two copies of this would
  // be two places for a price to be wrong.
  function renderPrices(host) {
    if (!host) return;
    host.textContent = '';
    for (const price of settings.prices) {
      const card = document.createElement('div');
      card.className = 'premcard';
      const what = document.createElement('b');
      what.textContent = price.price;
      const how = document.createElement('span');
      how.textContent = price.label;
      const why = document.createElement('i');
      why.textContent = price.note;
      card.append(what, how, why);
      host.append(card);
    }
  }

  root.BlindedPay = Object.assign(settings, { paidFor, renderPrices });
})(typeof window !== 'undefined' ? window : globalThis);
