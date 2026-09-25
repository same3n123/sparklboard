# SparkBoard Assistant service

A ~200-line Express service that turns a learner's sentence into **SparkBoard commands**.
It is the only place an API key exists. The page never sees it.

```
browser  ──POST /api/assistant──▶  this service  ──▶  Claude (claude-sonnet-5, effort low)
   ▲                                     │
   └──── { reply, bullets, commands } ◀──┘
```

The page then runs each returned command through the **same deterministic interpreter**
a typed command goes through (`AGENT.intent()` → `AGENT.do_*`). The model chooses *what to
try*; `MECHANICS.compatible()`, `ifWirePlan()` and each block's `validate()` still decide
what is *possible*. A misread sentence can act on the wrong part — it can never invent a
connection the simulator would refuse. Anything outside the command grammar is dropped by
the page and reported as "I could not do that on this canvas."

## Deploy on Render

1. Push this repository to GitHub (the `server/` folder is all that matters).
2. Render → **New → Web Service** → pick the repo.
   Render reads `server/render.yaml`, or set it by hand:
   - Root Directory: `server`
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Add the environment variable **`ANTHROPIC_API_KEY`** with your key. That is the only
   required one.
4. Deploy, then check `https://<your-service>.onrender.com/health` → `{"ok":true,...}`.

The free plan sleeps after 15 minutes idle, so the first question after a quiet spell
takes ~30 s to wake the service. Everything in SparkBoard keeps working while it sleeps.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Your Anthropic key. Never put this in `index.html`. |
| `MODEL` | no | Defaults to `claude-sonnet-5` — about $5 per 1000 questions with the prompt cached. `claude-haiku-4-5` halves that (about $2.60) but reasons less well about a whole circuit. |
| `ALLOWED_ORIGINS` | no | Comma-separated sites allowed to call it. `*` by default; set it to your site's address once you have one. |
| `APP_TOKEN` | no | A shared secret. If set, the page must send it — type `ai token <secret>` in the Assistant. |
| `MAX_PER_MINUTE` | no | Requests per IP per minute. Default 20. |
| `EFFORT` | no | `low` (default), `medium` or `high`. **Ignored on Haiku 4.5**, which rejects the parameter — it applies only to Sonnet 5 / Opus. |
| `KEEP_AWAKE` | no | Set to `off` to let the free instance sleep. By default the service pings itself every 12 minutes so learners do not hit the ~50 s wake-up. |
| `SUPABASE_URL` | no | Turns the **premium gate and the daily allowance** on. See below. |
| `SUPABASE_ANON_KEY` | no | The other half of the same switch. Public value; the `service_role` key is never used here and must never be set. |

## Who may ask, and how often

The assistant is a **Premium** feature with a limit of **10 messages a day**, and this
service is where that is enforced — not in the page, which can be edited, and not in
`localStorage`, which can be cleared.

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the same two public values
`config/config.js` already carries) and every request must arrive with the learner's
Supabase access token:

```
Authorization: Bearer <the learner's access token>
```

The service hands that token straight back to the database and calls

```sql
select public.ai_message_consume();
```

which takes **no arguments**. It reads who is calling from `auth.uid()`, checks their
plan carries `ai_invent`, and does the test and the increment in **one statement** — so
two tabs cannot both spend the tenth message, and there is nothing here for a client to
lie about: not the user, not the plan, not the count. See
`supabase/migrations/0005_roles_plans_resellers.sql`.

The allowance is spent **before** a single token is bought from the model, so a refusal
costs nothing.

| What happened | Status | What the learner is told |
|---|---|---|
| Not signed in / expired token | 401 | "The assistant needs you to be signed in." |
| Free or Standard plan | 403 | "Premium Feature — upgrade to Premium to access AI Assisted in Invent." |
| Today's ten are gone | 429 | "Daily AI message limit reached. Your AI message limit will reset tomorrow." |

A successful answer carries `usage: { used, limit, left, plan }` back with it, which is
what the chat header's *AI messages today: 7 / 10* is drawn from. The page treats
401/403/429 as **refusals it must show**, not as the service being unreachable — the
built-in interpreter deliberately does not answer instead, because "you have used today's
ten" followed by an answer would read as the limit not existing.

**Leave both blank** and the service is open, rate-limited by IP only. That is right for a
local copy and wrong for a deployment that sells Premium. With them blank, the page still
enforces the allowance through the same database function on its own.

### Deploy this service BEFORE relying on the header

`/health` reports `gated`, and the page reads it before it sends anything: it only
attaches `Authorization` to a service that says it checks identity. That check exists
because of a real failure. `Authorization` makes the request non-simple, so the browser
sends a CORS preflight first, and a service whose `allowedHeaders` does not list it
answers that preflight with a refusal — the real request is never made and the browser
reports a bare `TypeError: Failed to fetch`, which looks exactly like the service being
down. An older deployment therefore keeps working, unauthenticated, instead of breaking.

So the safe order is: **deploy this service first, then set the two variables.** If you
ever see the assistant say *"I could not reach the assistant service"* on a site that
was working, check the preflight before anything else:

```
curl -i -X OPTIONS https://<service>/api/assistant -H "Origin: https://<your-site>" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,authorization"
```

`access-control-allow-origin` must echo your site and `access-control-allow-headers`
must include `Authorization`. Note that `ALLOWED_ORIGINS` defaults to `*` but is
usually tightened at deploy time — a localhost dev copy is not on that list, which is
why the assistant cannot be reached from `http://localhost:8641` unless you add it.

The `service_role` key would bypass RLS and is **not needed**: the learner's own token,
plus a `SECURITY DEFINER` function, is the whole mechanism.

## Turning it on in SparkBoard

**It is already on.** `AI_ENDPOINT` near the top of the AGENT block in `index.html` holds
the service address, so the Assistant uses it with no setup at all. Point it at your own
deploy by editing that one line.

To override it in a single browser, open 💬 Assistant and type:

```
ai https://your-service.onrender.com
```

That address is remembered in this browser (`localStorage`). `ai off` goes back to the
built-in interpreter alone; `ai` on its own says which mode is running. The chat header
shows `· AI` or `· built-in`, so you always know which one answered.

**The published Artifact cannot reach this service** — its Content Security Policy blocks
every external host. AI mode works when `index.html` is opened locally, or served from
your own host. The Artifact keeps the built-in deterministic assistant, unchanged.

## Run it locally

```bash
cd server && npm install && ANTHROPIC_API_KEY=sk-ant-... npm start
```

Then `ai http://localhost:3000` in the Assistant.

## Cost

The system prompt is about 3,350 tokens and is sent with `cache_control: ephemeral`,
so repeat questions read it from cache at a tenth of the price. What you actually pay
per question is the canvas snapshot (~500 tokens in) plus the reply (~350 tokens out).

| model | per 1,000 questions |
|---|---|
| `claude-haiku-4-5` | about $2.60 |
| `claude-sonnet-5` (default) | about $5.20 |
| `claude-opus-5` | about $12.90 |

Nothing sits between Haiku 4.5 and Sonnet 5 on price — Sonnet 4.6 costs the same as
Sonnet 5 and is weaker, so it is never the right pick here.

`EFFORT=low` (the default) keeps thinking short, which is where output tokens go.
`MAX_PER_MINUTE` is the backstop against one page running up a bill.


## Payments (Razorpay, pay-as-you-go)

One-time orders. **No subscriptions, no mandates, no auto-renewal** — a learner buys
one month or twelve months of access and then nothing happens again until they buy
again. `server/payments.js` holds the whole of it.

| Endpoint | What it does |
|---|---|
| `GET /api/payments/config` | Whether payments are on, and the **public** key id |
| `POST /api/payments/create-order` | Prices it, opens a pending order, creates the Razorpay Order |
| `POST /api/payments/verify` | The browser callback — verified, reconciled, then applied |
| `POST /api/webhooks/razorpay` | Razorpay's own confirmation. Signature-checked, idempotent |

### The rule the whole design turns on

**The browser never decides anything about money.** `create-order` reads exactly three
fields — `plan`, `billingPeriod`, `resellerCode` — and ignores anything else in the body.
An `amount`, a `discount` or a `resellerId` sent by a page is not read, and there is a
test that proves it. The amount comes from `public.plan_prices` through
`payment_open_order()`, in integer paise, and that is what reaches Razorpay.

**Access is never granted by a callback.** A browser saying "it worked" is not evidence.
Every activation goes through `payment_mark_paid()`, and only after the signature has
verified *and* Razorpay's own record of the payment has been read back and found to match
the order's amount, currency and `captured` status.

### Environment

| Variable | Meaning |
|---|---|
| `RAZORPAY_KEY_ID` | Public. Reaches the browser by design — Checkout needs it. |
| `RAZORPAY_KEY_SECRET` | Secret. Signs and reads payments. Never leaves this process. |
| `RAZORPAY_WEBHOOK_SECRET` | Secret. Without it the webhook refuses every request. |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret, and the most dangerous value here — it bypasses RLS. Needed because a webhook has **no user session**; there is nobody to act as. |
| `RAZORPAY_LIVE` | Must be `true` before a `rzp_live_` key is accepted. |

Payments stay **off** unless the key id, the key secret, `SUPABASE_URL` and the service
key are all present. The endpoints then answer 503 and the Pricing page shows its plans
with no Pay button, which is the right thing for a local copy.

### Razorpay dashboard

1. **Settings → API Keys** → generate **Test** keys first.
2. **Settings → Webhooks → Add New Webhook**
   - URL: `https://<your-service>.onrender.com/api/webhooks/razorpay`
   - Secret: any strong random string — the same one you put in `RAZORPAY_WEBHOOK_SECRET`
   - Events: **`payment.captured`**, **`payment.failed`**, **`refund.processed`**
3. Keep **live** keys out of Git and out of `config/config.js`. Only the key id is public,
   and the server hands that to the page itself.

### Tests

```bash
npm run test:payments
```

Stands a fake Razorpay and a fake PostgREST in front of the real routes and drives all of
them: every plan/period/reseller combination, duplicate callbacks, duplicate webhooks,
forged signatures, amount mismatch, an `authorized`-but-not-captured payment, access
extension, refunds, and that no secret appears in any response. It does **not** test
Razorpay itself — that still needs a real test-mode key.

## The Shop (the Starter Kit, `shop.js`)

The Starter Kit is a physical box sold on `/shop`. It goes through the **same Razorpay
account, signature check and reconcile** as the plans — `shop.js` borrows them from
`payments.js` (`payCore`) rather than keeping a second copy — but it is a different kind
of order, kept in its own table (`public.shop_orders`, migration `0036_shop_orders.sql`):

- **No account is needed to buy one.** `POST /api/shop/create-order` takes the delivery
  details (name, email, phone, address, city, state, PIN) and a product **key**. A Bearer
  token, if one is sent, is checked with Supabase and only links the order to that account.
- **The price is the database's.** `shop_open_order()` reads `public.shop_products` and
  writes the amount onto the order in paise; the browser never sends one, and a capture
  for any other amount is flagged, not accepted.
- **`POST /api/shop/verify`** is the browser callback: the signature is checked against
  the Razorpay order id on OUR row, the payment is read back from Razorpay, then
  `shop_mark_paid()` settles it. The webhook settles it too if the buyer closed the tab —
  `payments.js` hands any Razorpay order it does not recognise to `shop.js`.
- **The confirmation email goes out exactly once**, through Resend, the moment the order
  is paid. `shop_claim_email()` decides whether the callback or the webhook sends it; a
  failed send hands the claim back. With no `RESEND_API_KEY` the order still completes and
  the admin's list shows *✉ not sent*.
- **Two more emails follow the box** (0037): *Shipped* (the courier, the tracking number
  and the courier's tracking link) and *Delivered*. The admin moves an order on the **Kit
  orders** page, and the page then calls **`POST /api/shop/notify`** `{ orderId, kind,
  resend }` with the admin's own session token. The service does NOT decide who is an admin:
  it calls `admin_shop_order()` WITH that token, which checks `is_admin()` from inside, and
  only then reads the row with the service key and sends. `shop_claim_notice()` makes each
  email go once; `resend: true` is the admin's explicit *Send again*.
- **Every email links to the buyer's order page**, `/#order-<track_token>` — a private link
  that shows the stage, the dates, the courier and the tracking number, and never the
  street address, the phone or the email.

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `RESEND_API_KEY` | for email | A Resend key for the verified `i4invent.com` domain. Never in the page. |
| `SHOP_MAIL_FROM` | no | Default `I 4 Invent <orders@i4invent.com>`. Use `staging@` on the staging service. |
| `SHOP_NOTIFY_EMAIL` | no | The team's address; gets a BCC of every confirmation (so every order reaches a person). |
| `SHOP_REPLY_TO` | no | Where a customer's reply goes. |
| `SHOP_SITE` | no | Default `https://i4invent.com` — the link in the email. |

The Razorpay and Supabase variables above are the same ones; nothing else is needed.
**Run `0036_shop_orders.sql` and `0037_shop_fulfilment.sql` first** (staging, then
production): until 0036 exists, create-order answers *"The shop is not set up on this server
yet."*, and until 0037 exists the notify endpoint cannot check an admin and the shipped and
delivered emails are not sent.
