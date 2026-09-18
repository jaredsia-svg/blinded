// The other end of lib/pass.js: making passes, and the key that checks them.
//
// This is the only part of Blinded that holds a secret, and it is the part
// that must never be deployed with the app. The private key signs passes; the
// page carries only the public half. If the private key leaks, anybody can
// mint their own pass and the page cannot tell -- which is the ordinary
// trade for a check that works offline.
//
//   node tools/pass.mjs keys                 make a keypair
//   node tools/pass.mjs mint --days 5        mint a pass, signed with it
//   node tools/pass.mjs mint --days 31 --plan month
//   node tools/pass.mjs check <pass>         verify one, the way the page does
//
// The private key is read from BLINDED_PASS_KEY (a JWK, as JSON) or from
// .pass-key.json beside the repo, which is in .gitignore and must stay there.
// `keys` prints the public half in the shape lib/passkey.js wants.
import { webcrypto } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const KEY_FILE = resolve(root, '.pass-key.json');
const subtle = webcrypto.subtle;

const b64 = bytes => Buffer.from(bytes).toString('base64url');

async function makeKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']);
  const priv = await subtle.exportKey('jwk', pair.privateKey);
  const pub = await subtle.exportKey('jwk', pair.publicKey);
  // Only what the check needs. An exported JWK carries key_ops and ext, which
  // say nothing to a verifier and invite the question of whether they matter.
  return { priv, pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } };
}

function privateKeyJwk() {
  if (process.env.BLINDED_PASS_KEY) {
    return JSON.parse(process.env.BLINDED_PASS_KEY);
  }
  if (existsSync(KEY_FILE)) return JSON.parse(readFileSync(KEY_FILE, 'utf8')).priv;
  throw new Error('no signing key: run `node tools/pass.mjs keys` first, or set '
    + 'BLINDED_PASS_KEY');
}

export async function mint(jwk, { days, plan, now }) {
  const key = await subtle.importKey('jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const at = Math.floor((now === undefined ? Date.now() : now) / 1000);
  const payload = {
    v: 1,
    // Only what the check needs to answer. No email, no name, no order
    // number, no machine: a pass that identified its buyer would put that
    // identity in local storage on the machine doing the redacting, which is
    // the one place this program has promised not to write anything down.
    exp: at + Math.round(days * 86400),
    plan: plan || (days > 10 ? 'month' : 'days'),
    // So two passes minted in the same second are not the same string, and so
    // a refunded one can be named in a revocation list if that ever becomes
    // necessary.
    id: b64(webcrypto.getRandomValues(new Uint8Array(6))),
  };
  const signed = b64(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    Buffer.from(signed, 'utf8'));
  return { pass: 'blinded1.' + signed + '.' + b64(new Uint8Array(signature)),
           payload };
}

// The page's own check, run here, so a pass is never handed over untested.
export async function verify(pass, pubJwk) {
  const source = readFileSync(resolve(root, 'lib', 'pass.js'), 'utf8');
  const scope = { window: undefined, globalThis: { crypto: webcrypto,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder, TextDecoder } };
  new Function('window', 'globalThis', source)(undefined, scope.globalThis);
  const Pass = scope.globalThis.BlindedPass;
  Pass.useKey(pubJwk);
  return Pass.check(pass, { subtle });
}

function flag(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at > 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

// Only when run as a command. The self-test imports `mint` and `verify` from
// here, and importing a module should not print anything at all.
const run = process.argv[1] && process.argv[1].endsWith('pass.mjs');
const what = run ? process.argv[2] : 'imported';

if (what === 'imported') {
  // nothing to do
} else if (what === 'keys') {
  const keys = await makeKeys();
  if (existsSync(KEY_FILE) && !process.argv.includes('--force')) {
    console.error(KEY_FILE + ' already exists.\n'
      + 'Overwriting it invalidates every pass ever sold. Pass --force if you '
      + 'really mean it.');
    process.exit(1);
  }
  writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  console.log('wrote ' + KEY_FILE + ' — this file is the business. Back it up '
    + 'somewhere safe, and never commit it.\n');
  console.log('Put this in lib/passkey.js:\n');
  console.log('window.BlindedPass.useKey(' + JSON.stringify(keys.pub) + ');');
} else if (what === 'mint') {
  const days = Number(flag('days', 5));
  const { pass, payload } = await mint(privateKeyJwk(),
    { days, plan: flag('plan', undefined) });
  console.log(pass);
  console.error('\nplan ' + payload.plan + ', ' + days + ' days, expires '
    + new Date(payload.exp * 1000).toISOString());
} else if (what === 'check') {
  const pub = existsSync(KEY_FILE)
    ? JSON.parse(readFileSync(KEY_FILE, 'utf8')).pub : null;
  const answer = await verify(process.argv[3], pub);
  console.log(JSON.stringify(answer, null, 2));
  process.exit(answer.ok ? 0 : 1);
} else if (what) {
  console.error('unknown command: ' + what);
  process.exit(1);
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(line => line.startsWith('//')).join('\n'));
}
