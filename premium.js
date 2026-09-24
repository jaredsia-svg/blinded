// The prices on the License page, written from lib/pay.js.
//
// Not typed into the markup. A price list that is edited in one place and not
// the other is a page that quotes one number and charges another, which is
// the kind of mistake nobody notices until a customer does.
(function () {
  'use strict';

  const Pay = window.BlindedPay;
  const Pass = window.BlindedPass;
  const el = id => document.getElementById(id);

  function rows(buyable) {
    Pay.renderPrices(el('premprices'), { buyable });
  }

  async function held() {
    if (!Pay.key) return null;
    const stored = Pass.recall();
    if (!stored) return null;
    Pass.useKey(Pay.key);
    const answer = await Pass.check(stored);
    return answer.ok ? answer.payload : null;
  }

  // Pasting one in, here rather than in the tool.
  //
  // It works on this page because a licence is checked against a key that came
  // with the page and kept in this browser -- the same browser the tool runs
  // in, so it is there when they go back to it. Nothing is asked of anybody.
  async function useTyped() {
    const box = el('premcodein');
    const note = el('premcodenote');
    const say = (text, bad) => {
      note.textContent = text;
      note.hidden = !text;
      note.classList.toggle('warnhint', Boolean(bad));
    };
    const typed = String(box.value || '').trim();
    if (!typed) { say('Paste the licence you were given.', true); return; }
    Pass.useKey(Pay.key);
    const answer = await Pass.check(typed);
    if (!answer.ok) {
      say(answer.why === 'expired'
        ? 'That licence has run out. Buying again gives you a new one.'
        : 'That does not look like a licence from here. Check for a missing '
          + 'character at either end.', true);
      return;
    }
    Pass.remember(typed);
    say('');
    el('premcoderow').hidden = true;
    el('premhave') && (el('premhave').hidden = true);
    Pay.showLicensed(document.querySelector('.top-link.here'), true);
    Pay.showHeld(document, { left: Pass.daysLeft(answer.payload),
                             license: typed });
  }

  async function start() {
    rows(Pay.on);

    const open = el('premcode');
    if (open) {
      open.addEventListener('click', () => {
        const row = el('premcoderow');
        row.hidden = !row.hidden;
        if (!row.hidden) el('premcodein').focus();
      });
    }
    const go = el('premcodego');
    if (go) go.addEventListener('click', useTyped);
    const typed = el('premcodein');
    if (typed) {
      typed.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); useTyped(); }
      });
    }

    // Asked once, and the answer used twice: the tick in the header and, if
    // payment is on, what this page says instead of prices.
    const license = await held();
    // The same tick the tool's header wears, on the same word.
    Pay.showLicensed(document.querySelector('.top-link.here'), Boolean(license));
    // And neither question is put to somebody who already has one.
    if (license && el('premhave')) el('premhave').hidden = true;

    // Nothing is being charged for yet. Saying so is not modesty: a price
    // list on a page for something that is currently free is a page that
    // lies, and this is the one subject where being caught doing that costs
    // more than the sale.
    if (!Pay.on) {
      const now = el('premnow');
      now.textContent = 'Right now every length is free, including export. '
        + 'The prices below are what a license will cost when that changes.';
      now.hidden = false;
      // And the prices are drawn as cards rather than as buttons: a price
      // that cannot be acted on must not look like it can be pressed.
      return;
    }

    if (!license) return;
    Pay.showHeld(document, { left: Pass.daysLeft(license),
                             license: Pass.recall() });
  }

  start();
})();
