# The mint

The only server this project has. It does two things:

1. Listens for Paddle saying a payment completed, and signs a pass for it.
2. Hands that pass back to `/unlock.html`, once, while the buyer is waiting.

It has never seen a document and cannot be given one. The page that holds
documents is forbidden by its own content security policy from talking to
this, or to anything.

## Deploy it somewhere else

Not on the static site. Blinded's claim is that its origin has no backend,
and that claim is one people check by reading `render.yaml` and watching the
network panel. Putting a server there makes the claim false even if the
server is harmless.

A separate Render service (or a Fly machine, or a small VM) on its own
hostname. It needs about 60MB of memory and no database.

## Before it can run

```sh
node ../tools/pass.mjs keys        # on a machine you control, not in CI
```

That writes `.pass-key.json`: a private key and a public one.

- The **private** key is the business. It mints every pass ever sold. Back it
  up somewhere you would back up a password manager. If it leaks, anybody can
  mint passes and the page cannot tell. If it is lost, no new passes can be
  made and every existing one keeps working until it expires.
- The **public** key goes in `lib/pay.js`, in the page, where anybody may read
  it. It can check a pass and cannot make one. That asymmetry is the whole
  design: it is why the check works offline and why nothing has to be asked
  of a server at the moment somebody exports a document.

Never commit either. `.pass-key.json` is in `.gitignore`.

## Environment

| Name | What |
|---|---|
| `BLINDED_PASS_KEY` | the private JWK, as JSON, from `.pass-key.json` |
| `PADDLE_WEBHOOK_SECRET` | Paddle → Developer tools → Notifications → your endpoint |
| `PADDLE_PRICE_DAYS` | the `pri_…` id of the 5-day pass |
| `PADDLE_PRICE_MONTH` | the `pri_…` id of the month pass |
| `ALLOW_ORIGIN` | `https://blinded.dev` — the only site allowed to read a pass back |
| `PORT` | defaults to 8080 |
| `STORE` | where the rows live, defaults to `./passes.json` |

```sh
BLINDED_PASS_KEY="$(jq -c .priv ../.pass-key.json)" \
PADDLE_WEBHOOK_SECRET=pdl_ntfset_… \
PADDLE_PRICE_DAYS=pri_… PADDLE_PRICE_MONTH=pri_… \
ALLOW_ORIGIN=https://blinded.dev \
node server.mjs
```

## In Paddle

1. Catalogue → two products, one price each: 5 days and a month.
2. Developer tools → Notifications → a destination pointing at
   `https://<this service>/paddle`, subscribed to `transaction.completed`
   only. Copy the secret it gives you.
3. Developer tools → Authentication → a **client-side token** (`test_…` in
   sandbox, `live_…` in production). That one is publishable and goes in
   `lib/pay.js`. The API key on the same screen (`pdl_…`) does not, and is
   not needed here at all.
4. Website approval: Paddle checks the domain before it will take live
   payments. Do that before switching `on`.

Then in `lib/pay.js`: the public key, the Paddle token, the two price ids,
`mint` set to this service's URL, `environment: 'production'`, `on: true`,
and delete `keyIsDevelopment`. The self-test refuses several of those
combinations — see below.

## What it stores

One row per transaction: the transaction id, the pass, when it was made, when
it expires. Not the buyer, not their email, not their country. Paddle is the
merchant of record and holds all of that; this service is not a customer
database and should not be allowed to become one.

Rows are readable for ten minutes after they are made, which is long enough
for the page that is waiting and worth nothing to somebody who finds a
transaction id in a receipt next week. Expired rows are dropped on every
write.

## What it cannot do

- **It cannot stop sharing.** A pass is a string and strings get forwarded.
  The short lifetimes are the mitigation; at three dollars, anything more
  costs more than it saves.
- **It cannot stop a clock being set backwards.** Expiry is read from the
  buyer's own machine.
- **It cannot revoke.** A refunded pass keeps working until it expires. If
  that ever matters, the `id` in each payload is there to build a revocation
  list against — but a list the page has to fetch is a network call at the
  moment of export, which is exactly what this design exists to avoid.

All three are deliberate. The thing being protected is worth three dollars;
the thing being protected *from* — a network request that says "this person
is redacting a document right now" — is worth more than that.
