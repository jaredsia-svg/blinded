// The one server this project has.
//
// It does two things and refuses everything else: it listens for Paddle
// saying a payment completed, and it signs a pass. It has never seen a
// document and cannot be given one -- the page that holds documents is not
// permitted by its own content security policy to talk to this, or to
// anything. The only page that talks to this is /unlock.html, which holds no
// document.
//
// It is NOT part of the static site. Deploy it as a separate service, on its
// own hostname. Deploying it alongside the app would put a server on the
// origin that promises not to have one, which is worse than useless even if
// the code is harmless: the claim people check is "this origin has no
// backend", and that claim should stay true.
//
// What it stores: one row per transaction, {txn, pass, exp}, in memory and in
// a file beside it. Not who bought it, not their email -- Paddle has those
// and is the merchant of record. This service is not a customer database and
// should never become one.
//
// Environment:
//   BLINDED_PASS_KEY       the private signing JWK, as JSON   (required)
//   PADDLE_WEBHOOK_SECRET  the signing secret from Paddle     (required)
//   PADDLE_PRICE_DAYS      price id for the 5-day pass
//   PADDLE_PRICE_MONTH     price id for the month pass
//   ALLOW_ORIGIN           the site that may read a pass back (required)
//   PORT                   defaults to 8080
//   STORE                  path for the record, defaults to ./passes.json
import { createHmac, timingSafeEqual, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const need = name => {
  const value = process.env[name];
  if (!value) throw new Error('missing ' + name);
  return value;
};

// Read when the service starts, not when the file is imported: the two pure
// functions below are worth testing, and a test should not have to invent a
// signing key to ask whether a signature check works.
let KEY, SECRET, ORIGIN, STORE, DAYS, passes;

function settings() {
  KEY = JSON.parse(need('BLINDED_PASS_KEY'));
  SECRET = need('PADDLE_WEBHOOK_SECRET');
  ORIGIN = need('ALLOW_ORIGIN');
  STORE = process.env.STORE || './passes.json';
  DAYS = {
    [process.env.PADDLE_PRICE_DAYS || 'days']: 5,
    [process.env.PADDLE_PRICE_MONTH || 'month']: 31,
  };
  passes = existsSync(STORE)
    ? new Map(Object.entries(JSON.parse(readFileSync(STORE, 'utf8')))) : new Map();
}

function keep() {
  // Expired rows are dropped on every write. A pass nobody can use is a row
  // that only creates an obligation to look after it.
  const now = Date.now() / 1000;
  for (const [txn, row] of passes) if (row.exp < now) passes.delete(txn);
  writeFileSync(STORE, JSON.stringify(Object.fromEntries(passes)));
}

const b64 = bytes => Buffer.from(bytes).toString('base64url');

async function mint(days) {
  const key = await webcrypto.subtle.importKey('jwk', KEY,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const payload = {
    v: 1,
    exp: Math.floor(Date.now() / 1000) + days * 86400,
    plan: days > 10 ? 'month' : 'days',
    id: b64(webcrypto.getRandomValues(new Uint8Array(6))),
  };
  const signed = b64(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signed, 'utf8'));
  return { pass: 'blinded1.' + signed + '.' + b64(new Uint8Array(signature)),
           exp: payload.exp, made: Date.now() };
}

// Paddle signs every webhook. Without checking that, this endpoint is "mint a
// pass for anybody who posts some JSON at it", which is the same as giving
// them away.
export function signatureIsGood(header, body, secret, now) {
  const parts = Object.fromEntries(String(header || '').split(';')
    .map(one => one.split('=')).filter(one => one.length === 2));
  if (!parts.ts || !parts.h1) return false;
  // A replayed request from an hour ago is not a new payment.
  const age = Math.abs((now === undefined ? Date.now() : now) / 1000 - Number(parts.ts));
  if (!Number.isFinite(age) || age > 300) return false;
  const want = createHmac('sha256', secret)
    .update(parts.ts + ':' + body).digest('hex');
  const given = String(parts.h1);
  if (given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(given));
}

// Which pass a completed transaction earns. Unknown prices earn nothing
// rather than a default: a pass handed out for a price this service has not
// been told about is a pass given away.
export function daysFor(event, table) {
  const items = (event && event.data && event.data.items) || [];
  for (const item of items) {
    const id = item && (item.price_id || (item.price && item.price.id));
    if (id && table[id]) return table[id];
  }
  return 0;
}

// A licence is handed back for as long as it is worth handing back.
//
// This used to be ten minutes: long enough for the page waiting on a purchase
// just made, and worth nothing to anybody who found the id later. That was
// the right trade while losing a licence meant writing to support, and the
// wrong one the moment the question became "I cleared my browser" or "I am on
// the other laptop" -- both of which are ordinary, and neither of which is
// worth a person's afternoon over three dollars.
//
// So the window is the licence's own life. A row is dropped by keep() the
// moment the licence in it expires, so nothing is kept that could still be
// fetched, and nothing fetchable outlives what it unlocks.
//
// What that costs, stated plainly: the transaction id becomes a bearer token
// for the licence, sitting in the buyer's email. It is a 26-character id
// nobody can guess or enumerate, held by the buyer and by Paddle, and it
// unlocks something that is already a string somebody could forward. The
// exposure is real and it is small, and the rate limit below is there so the
// endpoint cannot be used to look for one.
export function readable(row, now) {
  const at = (now === undefined ? Date.now() : now) / 1000;
  return Boolean(row) && row.exp > at;
}

// How many different licences an address goes looking for, not how many
// times it asks about one.
//
// Counting requests was wrong, and wrong in the worst direction: the buying
// page polls a single id for forty seconds while it waits for Paddle's
// webhook to land -- fifteen requests for one purchase -- so a buyer hit the
// limit on the one transaction they were entitled to, and the licence they
// had just paid for never arrived by itself.
//
// Somebody hunting for a licence they do not own has to try different ids.
// That is the thing worth counting, and it leaves polling alone: one id
// asked about a hundred times is still one id.
//
// Per address, and in memory: a restart forgives everybody, which is the
// right way for this to fail.
const IDS = 8;
const TRY_WINDOW = 10 * 60 * 1000;
const tries = new Map();

export function tooMany(who, txn, now = Date.now(), log = tries) {
  const seen = log.get(who) || new Map();
  for (const [id, at] of seen) if (now - at > TRY_WINDOW) seen.delete(id);
  // Asking again about the same id refreshes it rather than adding to it.
  seen.set(txn, now);
  log.set(who, seen);
  if (seen.size === 0) log.delete(who);
  // The log is only worth the window it covers.
  if (log.size > 5000) {
    for (const [key, ids] of log) {
      let newest = 0;
      for (const at of ids.values()) if (at > newest) newest = at;
      if (now - newest > TRY_WINDOW) log.delete(key);
    }
  }
  return seen.size > IDS;
}

function send(res, code, body, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ORIGIN,
    'Cache-Control': 'no-store',
  }, extra || {}));
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') {
    return send(res, 204, {}, { 'Access-Control-Allow-Headers': 'content-type' });
  }

  // Paddle, saying a payment happened.
  if (req.method === 'POST' && url.pathname === '/paddle') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // Nothing Paddle sends is anywhere near this large.
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', async () => {
      if (!signatureIsGood(req.headers['paddle-signature'], body, SECRET)) {
        return send(res, 401, { error: 'signature' });
      }
      let event;
      try { event = JSON.parse(body); } catch { return send(res, 400, { error: 'json' }); }
      if (event.event_type !== 'transaction.completed') {
        return send(res, 200, { ignored: event.event_type });
      }
      const days = daysFor(event, DAYS);
      if (!days) return send(res, 200, { ignored: 'price' });
      const txn = event.data && event.data.id;
      if (!txn) return send(res, 400, { error: 'no transaction' });
      // Paddle retries, and a retry must not mint a second pass.
      if (!passes.has(txn)) {
        passes.set(txn, await mint(days));
        keep();
      }
      send(res, 200, { ok: true });
    });
    return;
  }

  // The buying page, asking for the pass it just paid for.
  //
  // The transaction id is the only credential, which is weak on its own --
  // so a row is readable for a few minutes after it is made and not
  // afterwards. Long enough for the page that is waiting, short enough that a
  // transaction id found later is worth nothing.
  if (req.method === 'GET' && url.pathname === '/pass') {
    const who = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const txn = String(url.searchParams.get('txn') || '').trim();
    if (tooMany(who, txn)) {
      return send(res, 429, { error: 'too many tries; wait a few minutes' });
    }
    const row = txn && passes.get(txn);
    if (!row) return send(res, 404, { error: 'not yet' });
    if (!readable(row)) {
      return send(res, 410, { error: 'that licence has expired' });
    }
    return send(res, 200, { pass: row.pass });
  }

  send(res, 404, { error: 'no' });
});

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  settings();
  server.listen(Number(process.env.PORT || 8080), () => {
    console.log('the mint is listening on ' + (process.env.PORT || 8080));
  });
}
