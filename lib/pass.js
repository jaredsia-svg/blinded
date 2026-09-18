// A pass: proof that somebody paid, checkable without asking anyone.
//
// The problem this solves is narrow. Export of a long document is paid for;
// the page doing the export must not call home to find out whether it may
// proceed. A tool whose whole claim is that nothing leaves the machine cannot
// have a licence check that phones a server, because that request carries the
// one thing it is not supposed to reveal — that this person, on this machine,
// is redacting something right now.
//
// So the pass is signed rather than looked up. A private key held off this
// machine signs a few facts; the page carries only the matching public key and
// checks the signature itself. No account, no lookup, no network, works on a
// plane. The server that mints one never learns what was redacted, and is not
// consulted again.
//
//   blinded1.<payload>.<signature>
//
// both segments base64url, the payload a JSON object, the signature ECDSA over
// P-256 with SHA-256 across the payload segment's bytes. P-256 rather than
// Ed25519 because WebCrypto has had it everywhere for years and Ed25519 is
// still missing from browsers people actually have.
//
// What it does not do:
//
//   - It cannot stop a determined person. The check is in JavaScript on their
//     machine, and so is the page-count gate above it. Anyone willing to edit
//     the source has already won, and a pass can be passed on. At three
//     dollars, the cost of preventing that exceeds the loss; the short
//     lifetimes are the whole mitigation.
//   - It cannot detect a clock set backwards. Expiry is read from the
//     machine's own clock, which the person holding the pass controls.
//
// Both are accepted deliberately. What the design does buy is that an honest
// buyer is never locked out by a network they do not have, and never has to
// tell us anything to use what they bought.
(function (root) {
  'use strict';

  const PREFIX = 'blinded1';
  // Where the pass is kept between visits. One key, one value, this origin
  // only: it is a receipt, not a session.
  const STORE = 'blinded.pass';

  // base64url, which is base64 with two characters swapped and the padding
  // dropped — so it survives being pasted into a URL, an email, or a form
  // that trims things.
  function fromB64(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function toB64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Split and read, without checking the signature. Used to say something
  // useful about a pass that does not verify — "this one ran out on Tuesday"
  // is a better answer than "no".
  function read(pass) {
    const parts = String(pass || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(fromB64(parts[1])));
    } catch { return null; }
    if (!payload || typeof payload !== 'object') return null;
    if (payload.v !== 1) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return { payload, signed: parts[1], signature: parts[2] };
  }

  // Tolerance on the clock, both ways. A machine whose clock is a few minutes
  // out is common and is not fraud; being told the pass you bought forty
  // seconds ago is not valid yet would be.
  const SKEW = 5 * 60;

  function expired(payload, now) {
    const seconds = (now === undefined ? Date.now() : now) / 1000;
    return payload.exp + SKEW < seconds;
  }

  // The key this page checks against. Set by whoever builds the page; a page
  // with no key verifies nothing, which is the right default for a fork.
  let publicJwk = null;
  function useKey(jwk) { publicJwk = jwk || null; }

  let imported = null;
  async function key(subtle) {
    if (!publicJwk) return null;
    if (!imported) {
      imported = subtle.importKey('jwk', publicJwk,
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    }
    return imported;
  }

  // The whole question, answered locally: is this a pass we issued, and is it
  // still in date.
  //
  // Returns a reason rather than a boolean, because every one of these needs a
  // different sentence in front of the person holding it.
  async function check(pass, options) {
    const opts = options || {};
    const subtle = opts.subtle
      || (root.crypto && root.crypto.subtle);
    const parts = read(pass);
    if (!parts) return { ok: false, why: 'unreadable' };
    if (!subtle) return { ok: false, why: 'nocrypto' };
    const verifier = await key(subtle);
    if (!verifier) return { ok: false, why: 'nokey' };
    let good = false;
    try {
      good = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
        await verifier,
        fromB64(parts.signature),
        new TextEncoder().encode(parts.signed));
    } catch { good = false; }
    // Order matters. A forged pass is not "expired", and telling somebody
    // their invented code ran out would send them looking for a renewal
    // button that will not help them.
    if (!good) return { ok: false, why: 'forged' };
    if (expired(parts.payload, opts.now)) {
      return { ok: false, why: 'expired', payload: parts.payload };
    }
    return { ok: true, payload: parts.payload };
  }

  // Kept per browser, and only here. It is not sent anywhere, it is not in the
  // exported file, and it does not follow the reviewer to another machine --
  // which is why what they are emailed is the pass itself, not a link to it.
  function remember(pass) {
    try { root.localStorage.setItem(STORE, String(pass)); return true; }
    catch { return false; }
  }

  function recall() {
    try { return root.localStorage.getItem(STORE) || null; }
    catch { return null; }
  }

  function forget() {
    try { root.localStorage.removeItem(STORE); } catch { /* nothing to do */ }
  }

  // How long is left, in whole days, for saying so.
  function daysLeft(payload, now) {
    const seconds = (now === undefined ? Date.now() : now) / 1000;
    return Math.max(0, Math.ceil((payload.exp - seconds) / 86400));
  }

  root.BlindedPass = {
    PREFIX, STORE, SKEW,
    read, check, expired, daysLeft,
    useKey, remember, recall, forget,
    toB64, fromB64,
  };
})(typeof window !== 'undefined' ? window : globalThis);
