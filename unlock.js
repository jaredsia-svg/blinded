// The buying page's own script. It is not the tool and shares nothing with
// it but the pass format and this origin's storage.
//
// The whole flow:
//
//   1. Paddle takes the money, in its own overlay, on its own frames.
//   2. Paddle tells the mint service, server to server, that it happened.
//   3. The mint service signs a pass and hands it back here.
//   4. This page writes the pass into this origin's local storage.
//   5. The tool, in the other tab, finds it there when it is next looked at.
//
// Step 5 is why there is no message passing and no callback. The tool cannot
// be called into from here -- and should not be, since the point of the split
// is that the tool's page has no dealings with a payment processor. Storage
// on a shared origin is enough, and it survives this window being closed at
// the wrong moment, which a postMessage would not.
(function () {
  'use strict';

  const Pay = window.BlindedPay;
  const Pass = window.BlindedPass;
  const el = id => document.getElementById(id);

  function say(text, bad) {
    const note = el('buynote');
    note.textContent = text || '';
    note.hidden = !text;
    note.classList.toggle('warnhint', Boolean(bad));
  }

  // Shown the moment a pass exists, before anything else is done with it: the
  // reviewer is standing in front of a document waiting to be saved, and the
  // worst outcome here is a payment that went through and a page that says
  // nothing.
  function show(pass) {
    Pass.remember(pass);
    el('buypass').textContent = pass;
    el('buydone').hidden = false;
    el('buylist').hidden = true;
    // Including the checkout, which has done its job and would otherwise sit
    // under the pass inviting a second purchase.
    const frame = el('buyframe');
    if (frame) frame.hidden = true;
    // And the way to look for one, now that one is on screen.
    const finder = el('buyfind');
    if (finder) finder.hidden = true;
    say('');
    el('buydone').scrollIntoView({ block: 'nearest' });
  }

  // Ask the mint service for the pass belonging to a transaction Paddle has
  // just completed. Paddle's webhook and this request race, and the webhook
  // usually loses, so this asks a few times before giving up on it.
  //
  // Giving up has to say something true. There is no emailer: the mint signs
  // a pass and files it, and that is the whole of it -- so the way to a pass
  // this page could not fetch is a person, and the page says so rather than
  // promising a message nothing will send.
  async function collect(transaction) {
    if (!Pay.mint) return null;
    const until = Date.now() + 40000;
    let wait = 800;
    while (Date.now() < until) {
      try {
        const answer = await fetch(Pay.mint + '/pass?txn='
          + encodeURIComponent(transaction), { credentials: 'omit' });
        if (answer.ok) {
          const body = await answer.json();
          if (body && body.pass) return body.pass;
        }
      } catch { /* the network, or the service; either way, try again */ }
      await new Promise(done => setTimeout(done, wait));
      wait = Math.min(4000, wait * 1.4);
    }
    return null;
  }

  async function bought(transaction) {
    say('Payment taken. Making your license…');
    const pass = await collect(transaction);
    if (!pass) {
      say('Payment taken, and your license was made — this page could not '
        + 'fetch it in time. Write to support@blinded.dev with your Paddle '
        + 'receipt and we will send it straight back.', true);
      return;
    }
    // Checked before it is shown. A pass that does not verify is a bug at our
    // end, and the reviewer should hear that from us rather than from the
    // tool refusing it a moment later.
    Pass.useKey(Pay.key);
    const answer = await Pass.check(pass);
    if (!answer.ok) {
      say('Payment taken, but the license we made does not check out (' + answer.why
        + '). Keep this page open and get in touch — your payment is '
        + 'safe and this is ours to fix.', true);
      return;
    }
    show(pass);
  }

  function priceRows() {
    const list = el('buylist');
    list.textContent = '';
    for (const price of Pay.prices) {
      const row = document.createElement('li');
      // The same shape as the dialog in the tool: the length in the blue,
      // the price opposite it, the whole row the button. Two different
      // drawings of one offer made it look like two offers.
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'payprice';
      const how = document.createElement('span');
      how.className = 'payfor';
      how.textContent = price.label;
      const what = document.createElement('b');
      what.className = 'paycost';
      what.textContent = price.price;
      go.append(how, what);
      go.addEventListener('click', () => buy(price));
      row.append(go);
      list.append(row);
    }
  }

  // Waking the mint before anybody is waiting on it.
  //
  // A small instance sleeps after a quarter of an hour of quiet and takes the
  // better part of a minute to get up. The forty seconds this page waits for
  // a pass does not cover that, so the buyer pays and sees nothing -- the
  // worst minute this page has.
  //
  // What covers it is the buyer: they spend a minute finding a card and
  // typing it in. So the mint is knocked on when this page opens and again
  // when the overlay does, and by the time Paddle says the payment completed
  // it has been awake for a while. The reply does not matter -- a 404 wakes a
  // sleeping service exactly as well as a 200 -- and nothing waits for it or
  // reports it. It is a knock, not a request.
  function wake() {
    if (!Pay.mint) return;
    try {
      fetch(Pay.mint + '/pass?txn=wake', { credentials: 'omit', cache: 'no-store' })
        .catch(() => { /* asleep, blocked, unreachable: all the same here */ });
    } catch { /* and a browser that will not even make the call */ }
  }

  // `inline` draws the checkout into this page; `overlay` floats it over the
  // page. Inline is right when the price was already chosen in the tool,
  // because then this page is the checkout and nothing else -- an overlay
  // over an otherwise empty page is a curtain in front of a curtain. Somebody
  // who came here without choosing gets the prices and an overlay, since
  // there is a page behind it worth keeping.
  function buy(price, inline) {
    wake();
    const id = Pay.paddle.priceIds[price.id];
    if (!window.Paddle || !id) {
      say('Buying is not switched on for this copy of Blinded yet.', true);
      return;
    }
    if (inline) {
      el('buylist').hidden = true;
      el('buyframe').hidden = false;
    }
    window.Paddle.Checkout.open({
      items: [{ priceId: id, quantity: 1 }],
      settings: inline ? {
        displayMode: 'inline',
        frameTarget: 'checkout-container',
        frameInitialHeight: 460,
        frameStyle: 'width:100%; min-width:312px; background-color:transparent; border:none;',
        showAddDiscounts: true,
      } : {
        displayMode: 'overlay',
        // The discount field is on, which is the only way a code can be used:
        // Paddle draws it inside its own overlay or not at all.
        //
        // It is also how somebody is given a pass without paying -- a
        // reviewer, a journalist, a customer owed one. A hundred percent off
        // still makes a transaction, Paddle still says it completed, and the
        // mint still signs a pass against it, so the free route and the paid
        // route are the same route and there is no second code path minting
        // passes for nothing.
        //
        // Which is also the warning: a code that takes the price to zero is a
        // password for free passes, and it travels. Put a usage limit and an
        // expiry on every one of them in Paddle.
        showAddDiscounts: true,
      },
    });
  }

  // Going back to the tool, which is a window behind this one.
  //
  // This page opens as a window over the tool; the document is still in the
  // tab that opened it, exactly as it was left. Following a link to "/" from
  // here loaded a second copy of the tool into a 520-pixel window while the
  // real one sat behind it holding the reviewer's work -- and the licence
  // they had just bought appeared to have done nothing.
  //
  // Closing hands the tab back instead, and the tool picks the licence up on
  // the focus it gets when this window goes. The href stays as it is, for
  // anybody who opened this page directly rather than from the tool: there is
  // no window to close for them, so the link is the right answer.
  //
  // Only when the tool opened this window, which window.opener answers --
  // provided the two pages are served the same opener policy. They were not:
  // the tool had same-origin and this page same-origin-allow-popups, and two
  // different values put the windows in separate groups, so the opener read
  // null here and every buyer was sent down the link into a second copy of
  // the tool. It passed every test because the test server sent no headers.
  // render.yaml now gives every page the same value, and the self-test holds
  // them to it.
  //
  // Not "close and see what happens". A tab with one entry in its history is
  // closable by script whoever opened it, so somebody who arrived from a link
  // in their email would press this and watch their tab disappear.
  //
  // And if closing is refused anyway, the link still gets them there.
  function goBack(event) {
    if (!window.opener || window.opener.closed) return;
    event.preventDefault();
    const where = event.currentTarget.getAttribute('href') || '/';
    window.close();
    setTimeout(() => { if (!window.closed) location.href = where; }, 250);
  }

  // Fetching a licence back from the id on a Paddle receipt.
  //
  // The mint filed it under that id when it made it, so nothing new has to be
  // stored and nothing here has to know who is asking. It is checked before
  // it is shown, the same as one that has just been bought: a string the page
  // cannot verify is not a licence, whichever door it came through.
  async function findLicence() {
    const box = el('findtxn');
    const note = el('findnote');
    const say = (text, bad) => {
      note.textContent = text;
      note.hidden = !text;
      note.classList.toggle('warnhint', Boolean(bad));
    };
    const txn = String(box.value || '').trim();
    if (!txn) { say('Paste the transaction ID from your receipt.', true); return; }
    if (!Pay.mint) { say('Not switched on for this copy of Blinded.', true); return; }
    say('Looking\u2026', false);
    let answer;
    try {
      answer = await fetch(Pay.mint + '/pass?txn=' + encodeURIComponent(txn),
        { credentials: 'omit', cache: 'no-store' });
    } catch {
      say('Could not reach us. If you are on a network that blocks it, try '
        + 'again from another one.', true);
      return;
    }
    if (answer.status === 429) {
      say('That is a lot of tries. Wait a few minutes and try again.', true);
      return;
    }
    // The mint refuses anything not shaped like a Paddle id before looking.
    if (answer.status === 400) {
      say('That does not look like a transaction ID. It starts with txn_ and '
        + 'is on the receipt Paddle emailed you.', true);
      return;
    }
    if (answer.status === 404) {
      say('No licence under that ID. Check it against the receipt \u2014 it '
        + 'starts with txn_ \u2014 or write to support@blinded.dev.', true);
      return;
    }
    if (answer.status === 410) {
      say('That licence has run out. Buying again gives you a new one.', true);
      return;
    }
    if (!answer.ok) { say('Something went wrong. Try again in a moment.', true); return; }
    const got = await answer.json().catch(() => null);
    const licence = got && got.pass;
    if (!licence) { say('Something went wrong. Try again in a moment.', true); return; }
    Pass.useKey(Pay.key);
    const checked = await Pass.check(licence);
    if (!checked.ok) {
      say('That licence does not check out here (' + checked.why + '). Write '
        + 'to support@blinded.dev and we will look.', true);
      return;
    }
    say('');
    show(licence);
  }

  function start() {
    // ?find is its own page, not the buying page with a box added.
    //
    // It used to sit under the checkout for everybody, which offers a way of
    // getting a licence back to the one person who is in the middle of buying
    // one. Now the tool's dialog and the licence page both send people here
    // with ?find when that is what they want -- and somebody who came to
    // recover a licence they have already paid for should not be shown two
    // prices while they do it. So the prices, the checkout frame and Paddle
    // itself are all left out: nothing here is selling anything.
    const finding = new URLSearchParams(location.search).has('find');

    const find = el('findgo');
    if (find) find.addEventListener('click', findLicence);
    const txnBox = el('findtxn');
    if (txnBox) {
      txnBox.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); findLicence(); }
      });
    }

    const back = el('buyback');
    if (back) back.addEventListener('click', goBack);

    // A pass already in hand, because they bought one and came back. Say so
    // rather than selling them another.
    const held = Pass.recall();
    if (held) {
      Pass.useKey(Pay.key);
      Pass.check(held).then(answer => {
        if (answer.ok) show(held);
      });
    }

    // Nothing below this point is about buying, so in find mode none of it
    // runs: no prices, no checkout, and no Paddle script fetched for a page
    // that will not use it. The mint is still knocked on, because finding a
    // licence is the one thing this page is here to do.
    if (finding) {
      const title = document.querySelector('.buytitle');
      if (title) title.textContent = 'Find your license';
      document.title = 'Find your license \u00b7 Blinded';
      el('buylist').hidden = true;
      el('buyframe').hidden = true;
      const box = el('buyfind');
      if (box) {
        box.hidden = false;
        // It is the only thing on the page now, so it does not need to
        // announce itself with a rule above it as though something came
        // before.
        box.classList.add('buyfindonly');
      }
      const input = el('findtxn');
      if (input) input.focus();
      wake();
      return;
    }

    // Which price, if the tool already asked -- decided before anything is
    // drawn.
    //
    // The rows used to go up and come down again when Paddle finished
    // loading, so somebody who had already chosen watched their own choice
    // offered back to them and then snatched away. They are not drawn at all
    // now when the choice is already made.
    const asked = new URLSearchParams(location.search).get('price');
    const wanted = Pay.prices.find(one => one.id === asked);

    if (!wanted) priceRows();

    // Rehearsing a purchase before payment is switched on.
    //
    // With `on: false` there is nothing to buy, so the prices are hidden and
    // Paddle is never loaded. That is right for a visitor and it leaves no
    // way at all to find out whether buying works -- and the only other way
    // to find out is to switch payment on, which points every real visitor at
    // a sandbox checkout and puts a paywall in front of a tool that is still
    // free. So: the same page, drawn the same way, behind a query nobody
    // arrives at by accident, saying plainly what it is.
    //
    // Somebody who found this and bought a pass would get a working one, for
    // something they did not need. That is the whole exposure, and it is
    // smaller than the alternative.
    const rehearsing = new URLSearchParams(location.search).has('rehearse');

    if (!Pay.on && !rehearsing) {
      say('Blinded is free at every length in this copy. There is nothing to '
        + 'buy.', false);
      el('buylist').hidden = true;
      return;
    }
    if (!Pay.on) {
      // Its own line above the prices rather than the notice slot, because
      // everything else that happens on this page writes to that slot -- the
      // Paddle script failing to load was enough to wipe it -- and this one
      // has to stay on screen for as long as the prices it is explaining.
      document.body.dataset.rehearsing = 'yes';
      const note = document.createElement('p');
      note.className = 'hint warnhint';
      note.id = 'buyrehearse';
      note.textContent = 'A rehearsal of the buying page. Blinded is free at '
        + 'every length in this copy and nobody needs a license — this is here '
        + 'so that buying one can be tested before it is switched on.';
      el('buylist').before(note);
    }
    if (!Pay.paddle.token) {
      say('Buying is not switched on yet.', true);
      return;
    }

    // The first knock: the buyer is reading prices, which is the cheapest
    // lead time there is.
    wake();

    // And something to look at meanwhile. Paddle's script, its frame and the
    // form inside it are three round trips, which is a few seconds on a slow
    // connection -- and an empty page for those seconds reads as a page that
    // has failed. Said only where the checkout is about to open by itself;
    // somebody choosing a price has the prices to look at.
    if (wanted) {
      el('buylist').hidden = true;
      el('buyframe').hidden = false;
      say('Opening the secure checkout\u2026');
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
    script.onerror = () => say('The payment window could not be loaded. If you '
      + 'are on a network that blocks it, a license bought anywhere else will '
      + 'work here.', true);
    script.onload = () => {
      if (Pay.paddle.environment !== 'production') {
        window.Paddle.Environment.set(Pay.paddle.environment);
      }
      // Straight to the checkout when the tool already asked which price.
      //
      // The reviewer pressed USD 2.99 in the dialog; being shown the same two
      // prices again and asked to press one of them again is the tool
      // doubting a decision that was just made. The prices stay on the page
      // behind the overlay, so changing their mind costs nothing.
      window.Paddle.Initialize({
        token: Pay.paddle.token,
        eventCallback(event) {
          if (event.name === 'checkout.completed') {
            bought(event.data && event.data.transaction_id);
            return;
          }
          // The form is up, so the line that was standing in for it goes.
          if (event.name === 'checkout.loaded') {
            say('');
            return;
          }
          // Paddle's overlay says "Something went wrong" and nothing else,
          // whatever the reason -- a price that is not published, a domain
          // the account has not approved, a currency it will not sell in.
          // The reason is in the event, so it is put where somebody can read
          // it rather than left in a dialog that cannot say it.
          if (event.name === 'checkout.error') {
            console.error('Paddle refused the checkout:', event);
            const why = event.error
              && (event.error.detail || event.error.message || event.error.code);
            say('The payment window would not open'
              + (why ? ': ' + why : '. Its reason is in the browser console.'),
              true);
          }
        },
      });

      if (wanted) buy(wanted, true);
    };
    document.head.append(script);
  }

  start();
})();
