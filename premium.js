// The prices on the Premium page, written from lib/pay.js.
//
// Not typed into the markup. A price list that is edited in one place and not
// the other is a page that quotes one number and charges another, which is
// the kind of mistake nobody notices until a customer does.
(function () {
  'use strict';

  const Pay = window.BlindedPay;
  const Pass = window.BlindedPass;
  const el = id => document.getElementById(id);

  function rows() {
    Pay.renderPrices(el('premprices'));
  }

  async function held() {
    if (!Pay.key) return null;
    const stored = Pass.recall();
    if (!stored) return null;
    Pass.useKey(Pay.key);
    const answer = await Pass.check(stored);
    return answer.ok ? answer.payload : null;
  }

  async function start() {
    rows();

    // Nothing is being charged for yet. Saying so is not modesty: a price
    // list on a page for something that is currently free is a page that
    // lies, and this is the one subject where being caught doing that costs
    // more than the sale.
    if (!Pay.on) {
      const now = el('premnow');
      now.textContent = 'Right now every length is free, including export. '
        + 'The prices below are what a pass will cost when that changes.';
      now.hidden = false;
      // And no button. "Get a pass" for something nobody is charging for is a
      // button that cannot do what it says.
      el('prembuy').closest('.landgo').hidden = true;
      return;
    }

    const pass = await held();
    if (!pass) return;
    const now = el('premnow');
    const left = Pass.daysLeft(pass);
    now.textContent = 'You have a pass' + (left
      ? ', good for ' + left + (left === 1 ? ' more day.' : ' more days.')
      : '.') + ' Nothing to do.';
    now.hidden = false;
    el('prembuy').closest('.landgo').hidden = true;
  }

  start();
})();
