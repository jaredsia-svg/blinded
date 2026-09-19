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
    say('Payment taken. Making your pass…');
    const pass = await collect(transaction);
    if (!pass) {
      say('Payment taken, and your pass was made — this page could not fetch '
        + 'it in time. Write to support@blinded.dev with your Paddle receipt '
        + 'and we will send it straight back.', true);
      return;
    }
    // Checked before it is shown. A pass that does not verify is a bug at our
    // end, and the reviewer should hear that from us rather than from the
    // tool refusing it a moment later.
    Pass.useKey(Pay.key);
    const answer = await Pass.check(pass);
    if (!answer.ok) {
      say('Payment taken, but the pass we made does not check out (' + answer.why
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
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'buygo';
      const what = document.createElement('b');
      what.textContent = price.price;
      const how = document.createElement('span');
      how.textContent = price.label;
      go.append(what, how);
      go.addEventListener('click', () => buy(price));
      const note = document.createElement('span');
      note.className = 'buyfine';
      note.textContent = price.note;
      row.append(go, note);
      list.append(row);
    }
  }

  function buy(price) {
    const id = Pay.paddle.priceIds[price.id];
    if (!window.Paddle || !id) {
      say('Buying is not switched on for this copy of Blinded yet.', true);
      return;
    }
    window.Paddle.Checkout.open({
      items: [{ priceId: id, quantity: 1 }],
      settings: {
        displayMode: 'overlay',
        // Paddle sends the receipt; the pass is fetched here and shown above.
        showAddDiscounts: false,
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
        + 'every length in this copy and nobody needs a pass — this is here '
        + 'so that buying one can be tested before it is switched on.';
      el('buylist').before(note);
    }
    if (!Pay.paddle.token) {
      say('Buying is not switched on yet.', true);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
    script.onerror = () => say('The payment window could not be loaded. If you '
      + 'are on a network that blocks it, a pass bought anywhere else will '
      + 'work here.', true);
    script.onload = () => {
      if (Pay.paddle.environment !== 'production') {
        window.Paddle.Environment.set(Pay.paddle.environment);
      }
      window.Paddle.Initialize({
        token: Pay.paddle.token,
        eventCallback(event) {
          if (event.name === 'checkout.completed') {
            bought(event.data && event.data.transaction_id);
          }
        },
      });
    };
    document.head.append(script);
  }

  start();
})();
