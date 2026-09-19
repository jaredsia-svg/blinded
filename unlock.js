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

  function start() {
    // A pass already in hand, because they bought one and came back. Say so
    // rather than selling them another.
    const held = Pass.recall();
    if (held) {
      Pass.useKey(Pay.key);
      Pass.check(held).then(answer => {
        if (answer.ok) show(held);
      });
    }

    priceRows();

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
      const asked = new URLSearchParams(location.search).get('price');
      const wanted = Pay.prices.find(one => one.id === asked);

      window.Paddle.Initialize({
        token: Pay.paddle.token,
        eventCallback(event) {
          if (event.name === 'checkout.completed') {
            bought(event.data && event.data.transaction_id);
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
