// Keeps work moving when the tab is not the one being looked at.
//
// A browser deliberately starves a background tab. Two of its economies stop
// this program dead:
//
//   - requestAnimationFrame does not fire at all. There are no frames to
//     animate, so the callback simply never runs. pdf.js schedules the
//     continuation of a page render through rAF, which means opening a
//     document and switching tabs parks the render mid-page until you come
//     back and look at it.
//   - setTimeout is clamped to about one call a second, and to one a minute
//     once the tab has been hidden a while. A yield between pages would turn a
//     hundred-page sweep into a hundred seconds of waiting, then far worse.
//
// What is *not* throttled is a task posted through a message channel. It is an
// ordinary task rather than a timer, and browsers do not clamp it — this is the
// same mechanism scheduling libraries use for exactly this reason. So the fix
// throughout is: when the page is hidden, schedule through a message rather
// than through a frame or a timer.
//
// None of this can stop a browser *freezing* a tab outright, which is a
// separate mechanism and not something a page can decline.
(function (root) {
  'use strict';

  const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  // A macrotask that a background tab will still run.
  //
  // Falls back to a timer where there is no MessageChannel — and deliberately
  // in node, where a message port keeps the event loop alive and would stop
  // the test suite ever exiting.
  const nextTask = (() => {
    if (!inBrowser || typeof MessageChannel !== 'function') {
      return () => new Promise(resolve => setTimeout(resolve, 0));
    }
    const channel = new MessageChannel();
    const waiting = [];
    channel.port1.onmessage = () => {
      const resolve = waiting.shift();
      if (resolve) resolve();
    };
    channel.port1.start();
    return () => new Promise(resolve => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
  })();

  /**
   * Wraps a requestAnimationFrame pair so that a hidden page still gets its
   * callbacks, through a message instead of a frame.
   *
   * Written as a factory over the functions it wraps so the behaviour can be
   * tested directly, rather than only by observing a real browser deciding to
   * throttle something.
   *
   * Identifiers handed out for the hidden path are negative, which real frame
   * requests never are, so cancelling can tell which kind it is holding.
   */
  function wrapAnimationFrame(request, cancel, isHidden, now) {
    const pending = new Map();
    let nextId = 1;
    const clock = now || (() => Date.now());

    return {
      request(callback) {
        if (!isHidden()) return request(callback);

        const id = -(nextId++);
        pending.set(id, callback);
        nextTask().then(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          callback(clock());
        });
        return id;
      },
      cancel(id) {
        if (typeof id === 'number' && id < 0) {
          pending.delete(id);
          return;
        }
        cancel(id);
      },
      // For tests, and for deciding whether anything is outstanding.
      pendingCount() { return pending.size; },
    };
  }

  // Installs the wrapper over the real pair. Idempotent, since more than one
  // module has reason to ask for it.
  function keepRenderingWhenHidden() {
    if (!inBrowser || window.__blindedFramesPatched) return false;

    const realRequest = window.requestAnimationFrame.bind(window);
    const realCancel = window.cancelAnimationFrame.bind(window);
    const wrapped = wrapAnimationFrame(
      realRequest, realCancel,
      () => document.hidden,
      () => performance.now());

    window.requestAnimationFrame = wrapped.request;
    window.cancelAnimationFrame = wrapped.cancel;
    window.__blindedFramesPatched = true;
    return true;
  }

  root.BlindedSchedule = { nextTask, wrapAnimationFrame, keepRenderingWhenHidden };
})(typeof window !== 'undefined' ? window : globalThis);
