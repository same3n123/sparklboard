/* =====================================================================
   I 4 Invent — payments (Razorpay Orders, pay-as-you-go)
   ---------------------------------------------------------------------
   THREE ENDPOINTS, one rule: the browser is never the authority.

       POST /api/payments/create-order   price it, open an order
       POST /api/payments/verify         the browser callback
       POST /api/webhooks/razorpay       Razorpay's own confirmation

   The browser sends a plan, a period and possibly a reseller code. That
   is all it is allowed to say. It does not send an amount, a discount, a
   reseller id, an order id or a payment status; every one of those is
   decided here or in the database, and anything the browser did send of
   that kind would be ignored.

   ONE-TIME PURCHASES. No subscription, no mandate, no auto-renewal. An
   order buys one month or twelve months of access and then nothing
   happens again until the learner buys again.

   ACCESS IS NEVER GRANTED BY THIS FILE. It is granted by
   public.payment_mark_paid(), which is idempotent and atomic, and only
   after a signature has verified AND the amount has been reconciled with
   Razorpay's own record of the payment. A browser saying "it worked" is
   not evidence.

   SECRETS. RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET live in the
   environment and never leave this process — not in a response, not in a
   log line. Only the KEY ID is public, and it is public by design.
   ===================================================================== */
import express from 'express';
import crypto from 'node:crypto';

/* ---------------------------------------------------------------------
   configuration
   --------------------------------------------------------------------- */
const KEY_ID         = String(process.env.RAZORPAY_KEY_ID || '').trim();
const KEY_SECRET     = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
const WEBHOOK_SECRET = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SERVICE_KEY  = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const ANON_KEY     = String(process.env.SUPABASE_ANON_KEY || '').trim();

/* A Razorpay test key starts rzp_test_; a live one starts rzp_live_.
   Going live is deliberate: the service refuses a live key unless
   RAZORPAY_LIVE=true is also set, so nobody switches by pasting a key. */
const IS_LIVE  = /^rzp_live_/i.test(KEY_ID);
const LIVE_OK  = String(process.env.RAZORPAY_LIVE || '').toLowerCase() === 'true';

const PAYMENTS_ON = !!(KEY_ID && KEY_SECRET && SUPABASE_URL && SERVICE_KEY);

export function paymentsStatus(){
  return {
    on: PAYMENTS_ON,
    mode: !KEY_ID ? 'off' : (IS_LIVE ? 'live' : 'test'),
    liveAllowed: LIVE_OK,
    webhook: !!WEBHOOK_SECRET
  };
}

/* ---------------------------------------------------------------------
   Supabase, two ways.

   asService  full rights, for the payment tables. NEVER given a value
              that came from a browser without checking it first.
   whoIs      turns the learner's access token into a user id, by asking
              Supabase. The token is not decoded here: reading a claim is
              not the same as checking an identity.
   --------------------------------------------------------------------- */
async function rpc(name, args, token){
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: token ? ANON_KEY : SERVICE_KEY,
      Authorization: 'Bearer ' + (token || SERVICE_KEY)
    },
    body: JSON.stringify(args || {})
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch(e){ data = null; }
  if (!r.ok){
    const msg = (data && (data.message || data.error)) || ('postgrest ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function whoIs(token){
  if (!token) return null;
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return (u && u.id) ? u : null;
}

function bearer(req){
  const a = String(req.get('Authorization') || '');
  return /^Bearer\s+(.+)$/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : '';
}

/* ---------------------------------------------------------------------
   Razorpay REST, called with Basic auth. No SDK: two endpoints and an
   HMAC do not justify a dependency, and this way the exact request is
   visible in this file.
   --------------------------------------------------------------------- */
function rzpAuth(){
  return 'Basic ' + Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64');
}

async function rzp(path, init){
  const r = await fetch('https://api.razorpay.com/v1' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: rzpAuth(),
               ...((init && init.headers) || {}) }
  });
  const d = await r.json().catch(() => null);
  if (!r.ok){
    /* Razorpay's description is safe to surface; the rest is not. */
    const err = new Error((d && d.error && d.error.description) || ('razorpay ' + r.status));
    err.status = r.status;
    throw err;
  }
  return d;
}

/* ---------------------------------------------------------------------
   Signature checks. Both are HMAC-SHA256 with a timing-safe compare —
   a plain === leaks how much of a forged signature was right.
   --------------------------------------------------------------------- */
function safeEqual(a, b){
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;          /* length is not secret */
  return crypto.timingSafeEqual(A, B);
}

/* HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET) */
function paymentSignatureOk(orderId, paymentId, signature){
  const expect = crypto.createHmac('sha256', KEY_SECRET)
                       .update(orderId + '|' + paymentId)
                       .digest('hex');
  return safeEqual(expect, signature);
}

/* HMAC_SHA256(raw body, WEBHOOK_SECRET) — the RAW bytes, not a re-encoded
   parse of them: JSON.stringify(JSON.parse(x)) is not always x. */
function webhookSignatureOk(rawBody, signature){
  const expect = crypto.createHmac('sha256', WEBHOOK_SECRET)
                       .update(rawBody)
                       .digest('hex');
  return safeEqual(expect, signature);
}

/* ---------------------------------------------------------------------
   Reconcile with Razorpay itself: is this payment really captured, for
   the right order, the right amount and the right currency?
   --------------------------------------------------------------------- */
async function reconcile(order, paymentId){
  const p = await rzp('/payments/' + encodeURIComponent(paymentId));

  if (p.order_id !== order.razorpay_order_id)
    return { ok: false, why: 'order_mismatch' };
  if (String(p.currency).toUpperCase() !== String(order.currency).toUpperCase())
    return { ok: false, why: 'currency_mismatch' };
  if (Number(p.amount) !== Number(order.final_amount))
    return { ok: false, why: 'amount_mismatch' };
  /* 'authorized' is money held, not taken. Only 'captured' is paid. */
  if (p.status !== 'captured')
    return { ok: false, why: 'not_captured:' + p.status };

  return { ok: true, payment: p };
}

/* The bare name of a refusal we raised ourselves, for the response's
   `code` field. Only our own vocabulary passes: anything else — a
   PostgREST message, a driver error, a stack — is reported as 'error',
   so nothing internal is handed to a browser by accident. */
const REASONS = [
  'no_student', 'not_a_student', 'no_such_period', 'no_such_plan',
  'no_such_order_kind', 'not_an_upgrade', 'free_plan_is_not_a_purchase',
  'plan_is_not_purchasable', 'invalid_reseller_code', 'own_code',
  'order_not_open', 'order_not_created', 'order_refunded', 'amount_mismatch'
];
function reason(e){
  const m = String((e && e.message) || '');
  for (const r of REASONS) if (m.indexOf(r) >= 0) return r;
  return 'error';
}

/* An error a learner may read. Everything else stays in the log. */
function plain(e){
  const m = String((e && e.message) || '');
  if (/invalid_reseller_code/.test(m)) return 'That discount code is not valid.';
  if (/own_code/.test(m))              return 'You cannot use your own reseller code.';
  if (/not_a_student/.test(m))         return 'Only a student account can buy a plan.';
  /* Somebody pressed Upgrade whose plan ran out, or ended, while the page
     was open. The page's own quote is a preview; this is the answer. */
  if (/not_an_upgrade/.test(m))
    return 'There is nothing to upgrade from — your current plan has ended or is not below this one. Buy a full term instead.';
  if (/no_such_order_kind/.test(m))    return 'That kind of order is not available.';
  if (/no_such_plan|no_such_period/.test(m)) return 'That plan or period is not available.';
  if (/amount_mismatch/.test(m))       return 'The amount did not match. This payment is being reviewed — you have not been charged for access.';
  return 'That did not go through. Please try again.';
}

/* =====================================================================
   the router
   ===================================================================== */
export function paymentRoutes(){
  const r = express.Router();

  r.get('/api/payments/config', (_req, res) => {
    /* The KEY ID is public — Razorpay Checkout needs it in the browser.
       The secrets are not here and never will be. */
    res.json({
      enabled: PAYMENTS_ON && (!IS_LIVE || LIVE_OK),
      keyId: PAYMENTS_ON ? KEY_ID : null,
      mode: paymentsStatus().mode,
      currency: 'INR'
    });
  });

  /* -------------------------------------------------------------------
     1. create-order
     The browser says WHAT it wants. This decides what it costs.
     ------------------------------------------------------------------- */
  r.post('/api/payments/create-order', async (req, res) => {
    if (!PAYMENTS_ON) return res.status(503).json({ error: 'Payments are not configured.' });
    if (IS_LIVE && !LIVE_OK)
      return res.status(503).json({ error: 'Payments are not enabled in live mode.' });

    const user = await whoIs(bearer(req));
    if (!user) return res.status(401).json({ error: 'Sign in first.' });

    /* THE ONLY FOUR THINGS THE BROWSER MAY SAY. Anything else it sent —
       an amount, a discount, a reseller id — is not read.

       `kind` is the fourth, and it is not an amount: it says whether this
       is a term of access or the DIFFERENCE to a dearer plan for time
       already paid for. The database re-derives the plan they are on,
       re-checks that the target is dearer and re-computes the proration,
       so asking for an upgrade with nothing to upgrade from is refused
       rather than quietly priced as something else. */
    const plan   = String((req.body && req.body.plan) || '').toLowerCase().trim();
    const period = String((req.body && req.body.billingPeriod) || '').toLowerCase().trim();
    const code   = String((req.body && req.body.resellerCode) || '').trim() || null;
    const kind   = String((req.body && req.body.kind) || 'purchase').toLowerCase().trim();

    if (['standard', 'premium'].indexOf(plan) < 0)
      return res.status(400).json({ error: 'That plan is not available.' });
    if (['purchase', 'upgrade'].indexOf(kind) < 0)
      return res.status(400).json({ error: 'That kind of order is not available.' });
    /* An upgrade runs to the end of the term the learner already holds,
       so it has no period of its own to check — the database reads
       theirs. A purchase must name one. */
    if (kind === 'purchase' && ['monthly', 'yearly'].indexOf(period) < 0)
      return res.status(400).json({ error: 'That billing period is not available.' });

    let order;
    try {
      /* prices it, validates the code, writes a PENDING order */
      const rows = await rpc('payment_open_order',
        { p_student: user.id, p_plan: plan, p_period: period || 'monthly',
          p_code: code, p_kind: kind });
      order = Array.isArray(rows) ? rows[0] : rows;
      if (!order || !order.id) throw new Error('order_not_created');
    } catch (e){
      console.error('create-order (open):', e.message);
      /* `code` names WHICH refusal this was. Every one of these strings is
         written by us, in this file or in the migrations, and none of them
         carries a secret — a learner reporting "it will not go through"
         with nothing but the generic sentence is a support case nobody can
         answer, and that is exactly how this bug was reported. */
      return res.status(400).json({ error: plain(e), code: reason(e) });
    }

    try {
      /* The amount comes from the order this database just wrote. It has
         never been in a browser. */
      const rzpOrder = await rzp('/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(order.final_amount),      /* paise, integer */
          currency: order.currency || 'INR',
          receipt: order.id,
          notes: {
            i4_order: order.id,
            plan: order.plan,
            kind: order.order_kind || 'purchase',
            period: order.billing_period,
            months: String(order.access_duration_months)
          }
        })
      });

      await rpc('payment_attach_razorpay', { p_order: order.id, p_rzp_order: rzpOrder.id });

      /* The minimum Razorpay Checkout needs, and nothing more. */
      return res.json({
        orderId: order.id,
        razorpayOrderId: rzpOrder.id,
        keyId: KEY_ID,
        amount: Number(order.final_amount),
        currency: order.currency || 'INR',
        plan: order.plan,
        kind: order.order_kind || 'purchase',
        upgradeFrom: order.upgrade_from || null,
        billingPeriod: order.billing_period,
        accessMonths: order.access_duration_months,
        monthsPaid: order.months_paid,
        regularAmount: Number(order.regular_amount),
        resellerApplied: !!order.reseller_code_used,
        resellerCode: order.reseller_code_used || null,
        name: (user.user_metadata && user.user_metadata.username) || null,
        email: user.email || null
      });
    } catch (e){
      console.error('create-order (razorpay):', e.message);
      try { await rpc('payment_mark_failed', { p_order: order.id, p_reason: 'razorpay_order_failed' }); } catch(_){}
      return res.status(502).json({ error: 'Could not reach the payment provider. Nothing was charged.' });
    }
  });

  /* -------------------------------------------------------------------
     2. verify — the browser callback.

     Everything in the body is UNTRUSTED. The order id we verify against
     comes from OUR OWN record, never from the request: a forged callback
     naming somebody else's Razorpay order must not be able to sign
     itself into a payment.
     ------------------------------------------------------------------- */
  r.post('/api/payments/verify', async (req, res) => {
    if (!PAYMENTS_ON) return res.status(503).json({ error: 'Payments are not configured.' });

    const user = await whoIs(bearer(req));
    if (!user) return res.status(401).json({ error: 'Sign in first.' });

    const orderId   = String((req.body && req.body.orderId) || '').trim();
    const paymentId = String((req.body && req.body.razorpay_payment_id) || '').trim();
    const signature = String((req.body && req.body.razorpay_signature) || '').trim();
    if (!orderId || !paymentId || !signature)
      return res.status(400).json({ error: 'Incomplete payment details.' });

    let order;
    try {
      const rows = await rpc('orders_get', { p_order: orderId });
      order = Array.isArray(rows) ? rows[0] : rows;
    } catch(e){ order = null; }
    if (!order) return res.status(404).json({ error: 'No such order.' });
    if (order.student_id !== user.id)
      return res.status(403).json({ error: 'That order is not yours.' });

    /* ALREADY DONE. A repeated callback is normal — the learner pressed
       back, or the page reloaded. Say yes without doing anything twice. */
    if (order.payment_status === 'paid')
      return res.json({ ok: true, alreadyProcessed: true, order: publicOrder(order) });

    /* The order id used in the HMAC is OURS. */
    if (!order.razorpay_order_id)
      return res.status(409).json({ error: 'That order was never sent for payment.' });

    if (!paymentSignatureOk(order.razorpay_order_id, paymentId, signature)){
      console.error('verify: bad signature for order', orderId);
      try { await rpc('payment_mark_failed', { p_order: orderId, p_reason: 'bad_payment_signature' }); } catch(_){}
      return res.status(400).json({ error: 'That payment could not be verified.' });
    }

    /* A valid signature says the browser was not making it up. It does
       NOT say the money moved — ask Razorpay. */
    let check;
    try { check = await reconcile(order, paymentId); }
    catch (e){
      console.error('verify (reconcile):', e.message);
      return res.status(502).json({ error: 'Could not confirm the payment yet. If it went through, your access will appear shortly.' });
    }

    if (!check.ok){
      console.error('verify: reconcile failed', check.why, 'order', orderId);
      if (/amount|currency|order_mismatch/.test(check.why)){
        try { await rpc('payment_mark_failed', { p_order: orderId, p_reason: check.why }); } catch(_){}
        return res.status(400).json({ error: 'This payment did not match the order. It has been flagged for review.' });
      }
      /* merely not captured yet — the webhook will finish it */
      return res.json({ ok: false, pending: true,
        message: 'Payment received and waiting to be confirmed. Your access will open shortly.' });
    }

    try {
      const rows = await rpc('payment_mark_paid', {
        p_order: orderId, p_payment_id: paymentId,
        p_signature: signature, p_amount: Number(check.payment.amount)
      });
      const paid = Array.isArray(rows) ? rows[0] : rows;
      return res.json({ ok: true, order: publicOrder(paid) });
    } catch (e){
      console.error('verify (mark paid):', e.message);
      return res.status(400).json({ error: plain(e) });
    }
  });

  /* -------------------------------------------------------------------
     3. webhook — Razorpay's own word, which is the one that counts.

     Mounted with a RAW body parser in index.js: the signature is over the
     exact bytes Razorpay sent, and re-serialising a parsed object does
     not reliably reproduce them.
     ------------------------------------------------------------------- */
  r.post('/api/webhooks/razorpay', async (req, res) => {
    if (!WEBHOOK_SECRET){
      console.error('webhook: RAZORPAY_WEBHOOK_SECRET is not set — refusing');
      return res.status(503).json({ error: 'not configured' });
    }

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
    const sig = String(req.get('X-Razorpay-Signature') || '');

    if (!webhookSignatureOk(raw, sig)){
      console.error('webhook: bad signature — rejected');
      return res.status(400).json({ error: 'bad signature' });
    }

    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch(e){ return res.status(400).json({ error: 'bad body' }); }

    const eventId = String(req.get('X-Razorpay-Event-Id') || '') ||
                    (body && body.payload && body.payload.payment &&
                     body.payload.payment.entity && body.payload.payment.entity.id) || '';
    const event = String((body && body.event) || '');

    /* Razorpay retries. The FIRST delivery of an event id does the work;
       every later one is answered 200 and ignored. Answering anything
       else would make Razorpay retry a thing that already happened. */
    if (eventId){
      let first = true;
      try { first = await rpc('webhook_seen',
              { p_event: eventId, p_type: event, p_order: null, p_payload: body }); }
      catch (e){ console.error('webhook (seen):', e.message); }
      if (first === false) return res.json({ ok: true, duplicate: true });
    }

    try {
      const ent = (body.payload && (
        (body.payload.payment && body.payload.payment.entity) ||
        (body.payload.refund && body.payload.refund.entity) ||
        (body.payload.order && body.payload.order.entity))) || {};

      const rzpOrderId = ent.order_id || (body.payload && body.payload.order &&
                          body.payload.order.entity && body.payload.order.entity.id);
      if (!rzpOrderId) return res.json({ ok: true, ignored: 'no order id' });

      const rows = await rpc('orders_by_razorpay', { p_rzp_order: rzpOrderId });
      const order = Array.isArray(rows) ? rows[0] : rows;
      if (!order) return res.json({ ok: true, ignored: 'unknown order' });

      if (event === 'payment.captured'){
        /* payment_mark_paid is idempotent, so the callback having already
           run is not a problem — this simply returns the same row. */
        await rpc('payment_mark_paid', {
          p_order: order.id,
          p_payment_id: ent.id || null,
          p_signature: null,
          p_amount: Number(ent.amount)
        });
      } else if (event === 'payment.failed'){
        await rpc('payment_mark_failed', { p_order: order.id, p_reason: 'payment.failed' });
      } else if (event === 'refund.processed' || event === 'refund.created'){
        await rpc('payment_mark_refunded',
          { p_order: order.id, p_amount: Number(ent.amount) || null, p_revoke: true });
      }
      /* anything else: recorded above, no state change */

      return res.json({ ok: true });
    } catch (e){
      console.error('webhook (' + event + '):', e.message);
      /* 500 makes Razorpay retry, which is what we want for a transient
         failure — the event id keeps the retry from double-applying. */
      return res.status(500).json({ error: 'processing failed' });
    }
  });

  return r;
}

/* What a browser may be told about its own order. */
function publicOrder(o){
  if (!o) return null;
  return {
    id: o.id, plan: o.plan, billingPeriod: o.billing_period,
    kind: o.order_kind || 'purchase', upgradeFrom: o.upgrade_from || null,
    accessMonths: o.access_duration_months, monthsPaid: o.months_paid,
    regularAmount: Number(o.regular_amount), finalAmount: Number(o.final_amount),
    currency: o.currency, resellerCode: o.reseller_code_used || null,
    paymentStatus: o.payment_status, accessStatus: o.access_status,
    startsAt: o.starts_at, expiresAt: o.expires_at, paidAt: o.paid_at
  };
}
