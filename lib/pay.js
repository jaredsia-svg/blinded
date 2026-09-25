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
    on: true,

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
      // No note beside them any more. "For one job" and "For a run of them"
      // were guessing at what somebody is doing on their behalf, and the two
      // numbers say everything the choice needs.
      { id: 'days', label: '5 days', price: 'USD 2.99', days: 5 },
      { id: 'month', label: '1 month', price: 'USD 6.99', days: 31 },
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
  function renderPrices(host, opts) {
    if (!host) return;
    // Buyable unless told otherwise. A price that cannot be acted on is a
    // card; one that can is the button that buys it, drawn the same way the
    // tool's own dialog draws it so the two read as one offer.
    const buyable = !opts || opts.buyable !== false;
    host.textContent = '';
    for (const price of settings.prices) {
      const card = document.createElement(buyable ? 'a' : 'div');
      card.className = 'payprice';
      if (buyable) {
        card.dataset.price = price.id;
        // The price travels with it, so the buying page opens the checkout
        // on it instead of asking which one all over again.
        card.href = settings.where + '?price=' + encodeURIComponent(price.id);
      }
      const how = document.createElement('span');
      how.className = 'payfor';
      how.textContent = price.label;
      const what = document.createElement('b');
      what.className = 'paycost';
      what.textContent = price.price;
      card.append(how, what);
      host.append(card);
    }
  }

  // What the licence page says to somebody who already holds one.
  //
  // Here rather than in either page that shows it, because both do: /premium/
  // and the same markup pulled into the tool's own view. Two copies of this
  // would be two places for a licence to be described wrongly, and the one
  // being described belongs to somebody who has paid.
  //
  // The prices go. Offering to sell a second licence to somebody holding a
  // live one is a page that has not read its own state -- and pressing one
  // would take them to a checkout they have no reason to be at.
  // "Tue, 30 Sep 2026, 14:32 GMT+8", in whatever order and language the
  // reader's browser writes dates in. Null for anything that is not a time.
  function expiresText(seconds) {
    const at = Number(seconds);
    if (!Number.isFinite(at) || at <= 0) return null;
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      }).format(new Date(at * 1000));
    } catch {
      return new Date(at * 1000).toString();
    }
  }

  // The green disc and white tick, drawn once here so the one in the header
  // and the one in the box cannot drift into two different marks for the
  // same fact.
  function drawTick(className) {
    const svg = document.createElementNS(TICK, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const disc = document.createElementNS(TICK, 'circle');
    disc.setAttribute('cx', '8');
    disc.setAttribute('cy', '8');
    disc.setAttribute('r', '7');
    disc.setAttribute('fill', '#1a7f37');
    const mark = document.createElementNS(TICK, 'path');
    mark.setAttribute('d', 'M4.9 8.3l2 2 4.2-4.5');
    mark.setAttribute('fill', 'none');
    mark.setAttribute('stroke', '#fff');
    mark.setAttribute('stroke-width', '1.9');
    mark.setAttribute('stroke-linecap', 'round');
    mark.setAttribute('stroke-linejoin', 'round');
    svg.append(disc, mark);
    return svg;
  }

  function showHeld(root, opts) {
    if (!root) return;
    const find = id => root.querySelector('#' + id);
    const prices = find('premprices');
    const note = find('premnow');
    const held = find('premheld');
    const key = find('premkey');
    const show = find('premshow');
    if (prices) prices.hidden = true;
    if (note) {
      // The moment it stops, not a count of days. "Good for 5 more days"
      // left the question it was answering open: until when on the fifth
      // day? A licence runs for exactly its length from the second it was
      // made -- 5 x 24 hours, not to midnight -- so the honest answer is a
      // time, and it is given in the reader's own time zone with the zone
      // named, because a bare "14:32" is a different moment in every one.
      note.textContent = '';
      note.classList.add('premok');
      const words = document.createElement('span');
      const until = expiresText(opts && opts.expires);
      if (until) {
        words.textContent = 'Your license is active until ' + until + '.';
      } else {
        const left = Number(opts && opts.left) || 0;
        words.textContent = 'You have a license, good for ' + left
          + (left === 1 ? ' more day.' : ' more days.');
      }
      note.append(drawTick('premtick'), words);
      note.hidden = false;
    }
    if (!held || !key || !show) return;
    held.hidden = false;
    key.hidden = true;
    key.textContent = '';
    // Revealed on a press and not before. Somebody checking how long they
    // have left should not have to put the licence itself on screen to do it.
    show.onclick = () => {
      const shown = key.hidden === false;
      key.hidden = shown;
      key.textContent = shown ? '' : String((opts && opts.license) || '');
      show.textContent = shown ? 'Show my license' : 'Hide my license';
    };
  }

  // The tick beside the word License, once one is held.
  //
  // Drawn rather than written: a word like "active" beside another word is
  // two things to read where one mark will do, and it would have to be
  // translated. Built here because two pages carry that header -- the tool
  // and the licence page -- and a badge that differs between them reads as
  // two different states.
  const TICK = 'http://www.w3.org/2000/svg';

  function showLicensed(host, yes) {
    if (!host) return;
    const had = host.querySelector('.licensed');
    if (!yes) {
      if (had) had.remove();
      host.removeAttribute('data-licensed');
      return;
    }
    host.setAttribute('data-licensed', 'yes');
    if (had) return;
    const svg = drawTick('licensed');
    // Said as well as drawn, for anything that cannot see it.
    const told = document.createElement('span');
    told.className = 'sr-only';
    told.textContent = ' (you have one)';
    host.append(svg, told);
  }

  root.BlindedPay = Object.assign(settings,
    { paidFor, renderPrices, showHeld, showLicensed });
})(typeof window !== 'undefined' ? window : globalThis);
