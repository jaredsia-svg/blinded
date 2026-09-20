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

  async function start() {
    rows(Pay.on);

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

    const license = await held();
    if (!license) return;
    Pay.showHeld(document, { left: Pass.daysLeft(license),
                             license: Pass.recall() });
  }

  start();
})();
