/* =====================================================================
   Payment lifecycle tests —  node test-payments.mjs

   There are no Razorpay credentials here, so this stands a FAKE Razorpay
   and a FAKE PostgREST in front of the real server/payments.js and drives
   the real routes. What is being tested is the part that is ours: the
   signature checks, the reconciliation, the idempotency, the access
   extension arithmetic, and the refusal to trust the browser.

   What it CANNOT test is Razorpay's own behaviour. That still needs a
   real test-mode key — see the report.
   ===================================================================== */
import crypto from 'node:crypto';
import express from 'express';

const KEY_ID = 'rzp_test_FAKE123';
const KEY_SECRET = 'secret_key_for_tests';
const WEBHOOK_SECRET = 'webhook_secret_for_tests';

process.env.RAZORPAY_KEY_ID = KEY_ID;
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.SUPABASE_URL = 'http://127.0.0.1:8901';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_key';
process.env.SUPABASE_ANON_KEY = 'anon_key';

/* ---------------- the fake database ---------------- */
const PRICES = {
  'standard|monthly': { regular: 99900,  reseller: 49900,  given: 1,  paid: 1 },
  'standard|yearly':  { regular: 999000, reseller: 499500, given: 12, paid: 10 },
  'premium|monthly':  { regular: 149900, reseller: 74900,  given: 1,  paid: 1 },
  'premium|yearly':   { regular: 1499000,reseller: 749500, given: 12, paid: 10 }
};
/* plans.sort_order — what makes one plan "dearer" than another */
const RANK = { free: 0, standard: 1, premium: 2 };

const DB = {
  orders: new Map(), events: new Set(), purchases: [],
  profiles: new Map([['stu-1', { id:'stu-1', role:'student', subscription_status:'active',
                                 subscription_plan:'free', plan_expires_at:null,
                                 billing_cycle:'monthly' }]]),
  resellers: new Map([['sam50', { id:'res-1', user_id:'res-user', unique_code:'sam50' }]]),
  reset(){ this.orders.clear(); this.events.clear(); this.purchases.length = 0;
           this.profiles.set('stu-1', { id:'stu-1', role:'student',
             subscription_status:'active', subscription_plan:'free', plan_expires_at:null,
             billing_cycle:'monthly' }); }
};

/* public.upgrade_quote_for(), in the same arithmetic and the same order,
   so a change to one is caught by these tests against the other.
   Amounts here are PAISE, as the orders table stores them. */
function upgradeQuote(studentId, plan, coded){
  const prof = DB.profiles.get(studentId);
  if (!prof) return null;
  const now = new Date();
  const exp = prof.plan_expires_at ? new Date(prof.plan_expires_at) : null;
  /* plan_of(): an expired or cancelled plan is Free, with nothing to credit */
  const cur = (prof.subscription_status === 'active' && (!exp || exp > now))
              ? prof.subscription_plan : 'free';
  if (cur === 'free' || cur === plan) return null;
  if (!exp || exp <= now) return null;
  if (RANK[plan] == null || RANK[cur] == null || RANK[plan] <= RANK[cur]) return null;

  const cycle = prof.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
  const from = PRICES[cur + '|' + cycle], to = PRICES[plan + '|' + cycle];
  if (!from || !to) return null;

  const days = Math.ceil((exp - now) / 86400000);
  if (days <= 0) return null;
  const term = to.given * 30;
  const frac = Math.min(1, Math.max(0, days / term));
  /* rupees, rounded UP, so no upgrade price can carry paise */
  const reg = Math.ceil(((to.regular - from.regular) / 100) * frac);
  let fin = coded ? Math.ceil(((to.reseller - from.reseller) / 100) * frac) : reg;
  if (reg <= 0) return null;
  fin = Math.max(1, Math.min(fin, reg));
  return { kind:'upgrade', from: cur, plan, cycle, daysLeft: days, termDays: term,
           expiresAt: exp.toISOString(),
           original: reg * 100, final: fin * 100 };      /* paise */
}
let seq = 0;

const fakeDb = express();
fakeDb.use(express.json());
fakeDb.get('/auth/v1/user', (req, res) => {
  const t = String(req.get('Authorization') || '');
  if (/good-token/.test(t)) return res.json({ id:'stu-1', email:'sam@example.com', user_metadata:{ username:'sam' } });
  res.status(401).json({ error:'bad token' });
});
fakeDb.post('/rest/v1/rpc/:fn', (req, res) => {
  const a = req.body || {};
  const fn = req.params.fn;
  try {
    if (fn === 'upgrade_quote_for')
      return res.json(upgradeQuote(a.p_student, String(a.p_plan || ''), !!a.p_coded));

    if (fn === 'payment_open_order'){
      const kind = String(a.p_kind || 'purchase');
      if (kind !== 'purchase' && kind !== 'upgrade') throw new Error('no_such_order_kind');
      let resel = null;
      if (a.p_code){
        resel = DB.resellers.get(String(a.p_code).toLowerCase());
        if (!resel) throw new Error('invalid_reseller_code');
      }

      let period = a.p_period, months, paid, reg, fin, was = null;
      if (kind === 'upgrade'){
        const up = upgradeQuote(a.p_student, String(a.p_plan || ''), !!resel);
        if (!up) throw new Error('not_an_upgrade');
        period = up.cycle; was = up.from;
        reg = up.original; fin = up.final; months = 0; paid = 0;
      } else {
        const pr = PRICES[a.p_plan + '|' + a.p_period];
        if (!pr) throw new Error('no_such_plan');
        reg = pr.regular; fin = resel ? pr.reseller : pr.regular;
        months = pr.given; paid = pr.paid;
      }

      const o = {
        id: 'ord-' + (++seq), student_id: a.p_student, plan: a.p_plan,
        billing_period: period, access_duration_months: months, months_paid: paid,
        regular_amount: reg, final_amount: fin,
        currency: 'INR', reseller_id: resel ? resel.id : null,
        reseller_code_used: resel ? resel.unique_code : null,
        order_kind: kind, upgrade_from: was,
        razorpay_order_id: null, razorpay_payment_id: null,
        payment_status: 'pending', access_status: 'pending',
        starts_at: null, expires_at: null, paid_at: null, flagged_reason: null
      };
      DB.orders.set(o.id, o);
      return res.json([o]);
    }
    if (fn === 'payment_attach_razorpay'){
      const o = DB.orders.get(a.p_order);
      if (!o || o.payment_status !== 'pending' || o.razorpay_order_id) throw new Error('order_not_open');
      o.razorpay_order_id = a.p_rzp_order;
      return res.json([o]);
    }
    if (fn === 'orders_get')        return res.json(DB.orders.has(a.p_order) ? [DB.orders.get(a.p_order)] : []);
    if (fn === 'orders_by_razorpay') return res.json([...DB.orders.values()].filter(o => o.razorpay_order_id === a.p_rzp_order));
    if (fn === 'webhook_seen'){
      if (DB.events.has(a.p_event)) return res.json(false);
      DB.events.add(a.p_event); return res.json(true);
    }
    if (fn === 'payment_mark_failed'){
      const o = DB.orders.get(a.p_order);
      if (o && o.payment_status === 'pending'){ o.payment_status='failed'; o.access_status='cancelled'; o.flagged_reason=a.p_reason; }
      return res.json([o]);
    }
    if (fn === 'payment_mark_paid'){
      const o = DB.orders.get(a.p_order);
      if (!o) throw new Error('no_such_order');
      if (o.payment_status === 'paid') return res.json([o]);       /* idempotent */
      if (a.p_amount != null && Number(a.p_amount) !== Number(o.final_amount)){
        o.flagged_reason = 'amount_mismatch';
        throw new Error('amount_mismatch');
      }
      const prof = DB.profiles.get(o.student_id);
      const now = new Date();
      let from, exp;
      if (o.order_kind === 'upgrade'){
        /* buys no time: the end date is the one they already had, and
           never earlier than tomorrow */
        from = now;
        const had = prof.plan_expires_at ? new Date(prof.plan_expires_at) : now;
        const min = new Date(now.getTime() + 86400000);
        exp = had > min ? had : min;
      } else {
        const cur = (prof.subscription_status === 'active' && prof.plan_expires_at)
                    ? new Date(prof.plan_expires_at) : now;
        from = cur > now ? cur : now;
        exp = new Date(from); exp.setMonth(exp.getMonth() + o.access_duration_months);
      }
      o.payment_status='paid'; o.access_status='active';
      o.razorpay_payment_id = a.p_payment_id || o.razorpay_payment_id;
      o.paid_at = now.toISOString(); o.starts_at = from.toISOString(); o.expires_at = exp.toISOString();
      prof.subscription_plan = o.plan; prof.subscription_status='active';
      prof.plan_expires_at = o.expires_at;
      prof.billing_cycle = o.billing_period;
      DB.purchases.push({ order:o.id, reseller_id:o.reseller_id, final:o.final_amount });
      return res.json([o]);
    }
    if (fn === 'payment_mark_refunded'){
      const o = DB.orders.get(a.p_order);
      if (!o) throw new Error('no_such_order');
      o.payment_status='refunded'; o.access_status='cancelled'; o.refunded_amount=a.p_amount;
      return res.json([o]);
    }
    return res.json(null);
  } catch(e){ res.status(400).json({ message: e.message }); }
});

/* ---------------- the fake Razorpay ---------------- */
const RZP = { orders: new Map(), payments: new Map() };
let rseq = 0;
const fakeRzp = express();
fakeRzp.use(express.json());
fakeRzp.post('/v1/orders', (req, res) => {
  const o = { id:'order_FAKE' + (++rseq), amount:req.body.amount, currency:req.body.currency,
              receipt:req.body.receipt, status:'created' };
  RZP.orders.set(o.id, o);
  res.json(o);
});
fakeRzp.get('/v1/payments/:id', (req, res) => {
  const p = RZP.payments.get(req.params.id);
  if (!p) return res.status(404).json({ error:{ description:'no such payment' } });
  res.json(p);
});

/* point the module's fetch at the fake Razorpay */
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.razorpay.com'))
    return realFetch('http://127.0.0.1:8902' + u.replace('https://api.razorpay.com',''), init);
  return realFetch(url, init);
};

/* ---------------- boot ---------------- */
const { paymentRoutes } = await import('./payments.js');

const app = express();
app.use('/api/webhooks/razorpay', express.raw({ type:'*/*' }));
app.use(express.json());
app.use(paymentRoutes());

const srvDb  = fakeDb.listen(8901);
const srvRzp = fakeRzp.listen(8902);
const srvApp = app.listen(8903);
const BASE = 'http://127.0.0.1:8903';

/* ---------------- helpers ---------------- */
const post = (path, body, token, headers) => realFetch(BASE + path, {
  method:'POST',
  headers: { 'Content-Type':'application/json',
             ...(token ? { Authorization:'Bearer ' + token } : {}), ...(headers||{}) },
  body: typeof body === 'string' ? body : JSON.stringify(body)
}).then(async r => ({ status:r.status, body: await r.json().catch(()=>null) }));

const paySig = (o, p) => crypto.createHmac('sha256', KEY_SECRET).update(o + '|' + p).digest('hex');
const hookSig = raw => crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

function capture(rzpOrderId, amount, id){
  const p = { id: id || ('pay_FAKE' + (++rseq)), order_id: rzpOrderId, amount,
              currency:'INR', status:'captured' };
  RZP.payments.set(p.id, p);
  return p;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + JSON.stringify(extra) : '')); }
};

/* buy something, all the way to paid. returns {order, payment} */
async function buy(plan, period, code){
  const c = await post('/api/payments/create-order', { plan, billingPeriod: period, resellerCode: code }, 'good-token');
  if (c.status !== 200) return { create: c };
  const p = capture(c.body.razorpayOrderId, c.body.amount);
  const v = await post('/api/payments/verify', {
    orderId: c.body.orderId, razorpay_payment_id: p.id,
    razorpay_signature: paySig(c.body.razorpayOrderId, p.id)
  }, 'good-token');
  return { create: c, payment: p, verify: v };
}

console.log('\n=== 1-8. every plan / period / reseller combination ===');
for (const plan of ['standard','premium'])
  for (const period of ['monthly','yearly'])
    for (const code of [null,'sam50']){
      DB.reset();
      const r = await buy(plan, period, code);
      const want = PRICES[plan+'|'+period][code ? 'reseller' : 'regular'];
      const months = PRICES[plan+'|'+period].given;
      ok(`${plan} ${period}${code?' +code':''}: charged ${want} paise, ${months} months`,
         r.create.status===200 && r.create.body.amount===want &&
         r.verify.status===200 && r.verify.body.ok===true &&
         r.verify.body.order.accessMonths===months &&
         r.verify.body.order.finalAmount===want,
         { got:r.create.body && r.create.body.amount, verify:r.verify && r.verify.body });
    }

console.log('\n=== 9. invalid reseller code ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'standard', billingPeriod:'monthly', resellerCode:'nope99' }, 'good-token');
  ok('refused, no order created', c.status===400 && DB.orders.size===0, c.body); }

console.log('\n=== the browser may not set the price ===');
DB.reset();
{ const c = await post('/api/payments/create-order',
    { plan:'premium', billingPeriod:'yearly', resellerCode:null,
      amount: 100, final_amount: 100, discount: 99, resellerId:'res-1' }, 'good-token');
  ok('amount/discount/resellerId in the body are ignored',
     c.status===200 && c.body.amount===1499000 && c.body.resellerApplied===false, c.body); }

console.log('\n=== 10-11. failed payment, abandoned checkout ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'standard', billingPeriod:'monthly' }, 'good-token');
  /* abandoned: nothing more happens */
  ok('abandoned order stays pending, no access',
     DB.orders.get(c.body.orderId).payment_status==='pending' && DB.purchases.length===0);
  /* failed: webhook says so */
  const ev = { event:'payment.failed', payload:{ payment:{ entity:{ id:'pay_x', order_id:c.body.razorpayOrderId, amount:99900 } } } };
  const raw = JSON.stringify(ev);
  const w = await post('/api/webhooks/razorpay', raw, null,
    { 'X-Razorpay-Signature': hookSig(raw), 'X-Razorpay-Event-Id':'evt_fail_1' });
  ok('payment.failed -> failed, still no access',
     w.status===200 && DB.orders.get(c.body.orderId).payment_status==='failed' && DB.purchases.length===0); }

console.log('\n=== 12. duplicate browser callback ===');
DB.reset();
{ const r = await buy('premium','monthly',null);
  const again = await post('/api/payments/verify', {
    orderId: r.create.body.orderId, razorpay_payment_id: r.payment.id,
    razorpay_signature: paySig(r.create.body.razorpayOrderId, r.payment.id) }, 'good-token');
  ok('second callback is a no-op', again.status===200 && again.body.alreadyProcessed===true);
  ok('access granted once only', DB.purchases.length===1, DB.purchases); }

console.log('\n=== 13. duplicate webhook ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'standard', billingPeriod:'yearly', resellerCode:'sam50' }, 'good-token');
  const p = capture(c.body.razorpayOrderId, c.body.amount);
  const ev = { event:'payment.captured', payload:{ payment:{ entity:{ id:p.id, order_id:c.body.razorpayOrderId, amount:p.amount } } } };
  const raw = JSON.stringify(ev);
  const h = { 'X-Razorpay-Signature': hookSig(raw), 'X-Razorpay-Event-Id':'evt_dup_1' };
  const w1 = await post('/api/webhooks/razorpay', raw, null, h);
  const w2 = await post('/api/webhooks/razorpay', raw, null, h);
  ok('both answered 200', w1.status===200 && w2.status===200);
  ok('second was recognised as a duplicate', w2.body && w2.body.duplicate===true, w2.body);
  ok('paid once, referral counted once', DB.purchases.length===1, DB.purchases);
  ok('reseller attributed', DB.purchases[0] && DB.purchases[0].reseller_id==='res-1'); }

console.log('\n=== webhook + callback for the SAME payment ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'premium', billingPeriod:'yearly', resellerCode:'sam50' }, 'good-token');
  const p = capture(c.body.razorpayOrderId, c.body.amount);
  const ev = { event:'payment.captured', payload:{ payment:{ entity:{ id:p.id, order_id:c.body.razorpayOrderId, amount:p.amount } } } };
  const raw = JSON.stringify(ev);
  await post('/api/webhooks/razorpay', raw, null, { 'X-Razorpay-Signature': hookSig(raw), 'X-Razorpay-Event-Id':'evt_both' });
  const v = await post('/api/payments/verify', { orderId:c.body.orderId, razorpay_payment_id:p.id,
    razorpay_signature: paySig(c.body.razorpayOrderId, p.id) }, 'good-token');
  ok('callback after webhook is a no-op', v.status===200 && v.body.alreadyProcessed===true, v.body);
  ok('still exactly one purchase', DB.purchases.length===1); }

console.log('\n=== 14. invalid webhook signature ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'standard', billingPeriod:'monthly' }, 'good-token');
  const ev = { event:'payment.captured', payload:{ payment:{ entity:{ id:'pay_forged', order_id:c.body.razorpayOrderId, amount:99900 } } } };
  const raw = JSON.stringify(ev);
  const w = await post('/api/webhooks/razorpay', raw, null,
    { 'X-Razorpay-Signature':'0'.repeat(64), 'X-Razorpay-Event-Id':'evt_forged' });
  ok('rejected 400', w.status===400, w.body);
  ok('no access granted', DB.purchases.length===0 && DB.orders.get(c.body.orderId).payment_status==='pending'); }

console.log('\n=== 15. invalid payment signature ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'premium', billingPeriod:'monthly' }, 'good-token');
  const p = capture(c.body.razorpayOrderId, c.body.amount);
  const v = await post('/api/payments/verify', { orderId:c.body.orderId, razorpay_payment_id:p.id,
    razorpay_signature:'deadbeef'.repeat(8) }, 'good-token');
  ok('rejected', v.status===400, v.body);
  ok('no access granted', DB.purchases.length===0);
  ok('order marked failed', DB.orders.get(c.body.orderId).payment_status==='failed'); }

console.log('\n=== 16. amount mismatch ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'premium', billingPeriod:'yearly' }, 'good-token');
  /* Razorpay reports a payment for far less than the order */
  const p = capture(c.body.razorpayOrderId, 100);
  const v = await post('/api/payments/verify', { orderId:c.body.orderId, razorpay_payment_id:p.id,
    razorpay_signature: paySig(c.body.razorpayOrderId, p.id) }, 'good-token');
  ok('refused', v.status===400, v.body);
  ok('no access granted', DB.purchases.length===0);
  ok('flagged for review', DB.orders.get(c.body.orderId).flagged_reason === 'amount_mismatch'); }

console.log('\n=== signature valid but payment only AUTHORIZED, not captured ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'standard', billingPeriod:'monthly' }, 'good-token');
  const p = { id:'pay_auth', order_id:c.body.razorpayOrderId, amount:c.body.amount, currency:'INR', status:'authorized' };
  RZP.payments.set(p.id, p);
  const v = await post('/api/payments/verify', { orderId:c.body.orderId, razorpay_payment_id:p.id,
    razorpay_signature: paySig(c.body.razorpayOrderId, p.id) }, 'good-token');
  ok('not treated as paid', v.status===200 && v.body.ok===false && v.body.pending===true, v.body);
  ok('no access granted', DB.purchases.length===0); }

console.log('\n=== a payment for SOMEBODY ELSE\'S order ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'standard', billingPeriod:'monthly' }, 'good-token');
  DB.orders.get(c.body.orderId).student_id = 'someone-else';
  const p = capture(c.body.razorpayOrderId, c.body.amount);
  const v = await post('/api/payments/verify', { orderId:c.body.orderId, razorpay_payment_id:p.id,
    razorpay_signature: paySig(c.body.razorpayOrderId, p.id) }, 'good-token');
  ok('refused 403', v.status===403, v.body); }

console.log('\n=== unauthenticated ===');
DB.reset();
{ const c = await post('/api/payments/create-order', { plan:'premium', billingPeriod:'yearly' }, 'bad-token');
  ok('create-order needs a real session', c.status===401);
  const v = await post('/api/payments/verify', { orderId:'x', razorpay_payment_id:'y', razorpay_signature:'z' }, null);
  ok('verify needs a real session', v.status===401); }

console.log('\n=== 17-18. existing access is EXTENDED, not discarded ===');
DB.reset();
{ /* 15 days of access left */
  const soon = new Date(); soon.setDate(soon.getDate() + 15);
  DB.profiles.get('stu-1').plan_expires_at = soon.toISOString();
  DB.profiles.get('stu-1').subscription_plan = 'standard';
  const r = await buy('premium','yearly',null);
  const exp = new Date(r.verify.body.order.expiresAt);
  const want = new Date(soon); want.setMonth(want.getMonth() + 12);
  ok('12-month purchase extends from the old expiry, keeping the 15 days',
     Math.abs(exp - want) < 60000, { got:exp.toISOString(), want:want.toISOString() });

  /* and a monthly purchase on top of that */
  const before = new Date(r.verify.body.order.expiresAt);
  const r2 = await buy('premium','monthly',null);
  const exp2 = new Date(r2.verify.body.order.expiresAt);
  const want2 = new Date(before); want2.setMonth(want2.getMonth() + 1);
  ok('a further monthly purchase extends again',
     Math.abs(exp2 - want2) < 60000, { got:exp2.toISOString(), want:want2.toISOString() }); }

console.log('\n=== 19. expired access starts fresh from today ===');
DB.reset();
{ const past = new Date(); past.setMonth(past.getMonth() - 2);
  DB.profiles.get('stu-1').plan_expires_at = past.toISOString();
  DB.profiles.get('stu-1').subscription_status = 'expired';
  const r = await buy('standard','monthly',null);
  const exp = new Date(r.verify.body.order.expiresAt);
  const want = new Date(); want.setMonth(want.getMonth() + 1);
  ok('expired access is not extended from the past',
     Math.abs(exp - want) < 60000, { got:exp.toISOString(), want:want.toISOString() }); }

console.log('\n=== 20. refund ===');
DB.reset();
{ const r = await buy('standard','yearly','sam50');
  const ev = { event:'refund.processed', payload:{ refund:{ entity:{ id:'rfnd_1',
              order_id:r.create.body.razorpayOrderId, amount:r.create.body.amount } } } };
  const raw = JSON.stringify(ev);
  const w = await post('/api/webhooks/razorpay', raw, null,
    { 'X-Razorpay-Signature': hookSig(raw), 'X-Razorpay-Event-Id':'evt_refund_1' });
  const o = DB.orders.get(r.create.body.orderId);
  ok('refund recorded', w.status===200 && o.payment_status==='refunded' && o.access_status==='cancelled');
  ok('the original order is NOT deleted', DB.orders.has(r.create.body.orderId));
  ok('the purchase record survives for the audit trail', DB.purchases.length===1); }

console.log('\n=== 21-27. UPGRADING: the difference, for the time that is left ===');
DB.reset();
{ /* Standard, monthly, with 15 of the 30 days still to run. Half the
     difference between 1,499 and 999 is 250. */
  const soon = new Date(); soon.setDate(soon.getDate() + 15);
  const prof = DB.profiles.get('stu-1');
  prof.subscription_plan = 'standard'; prof.billing_cycle = 'monthly';
  prof.plan_expires_at = soon.toISOString();

  const c = await post('/api/payments/create-order',
    { plan:'premium', billingPeriod:'monthly', kind:'upgrade' }, 'good-token');
  ok('a Standard learner CAN open a Premium upgrade', c.status===200, c.body);
  ok('priced as the prorated difference, not a new term',
     c.body.amount === 25000, { got:c.body.amount, want:25000 });
  ok('it buys no months', c.body.accessMonths === 0 && c.body.kind === 'upgrade', c.body);

  const ends = new Date(soon);
  const p = capture(c.body.razorpayOrderId, c.body.amount);
  const v = await post('/api/payments/verify', { orderId:c.body.orderId, razorpay_payment_id:p.id,
    razorpay_signature: paySig(c.body.razorpayOrderId, p.id) }, 'good-token');
  ok('the upgrade goes through', v.status===200 && v.body.ok===true, v.body);
  ok('the plan moved to premium', DB.profiles.get('stu-1').subscription_plan === 'premium');
  ok('and the end date did NOT move',
     Math.abs(new Date(v.body.order.expiresAt) - ends) < 60000,
     { got:v.body.order.expiresAt, want:ends.toISOString() });
  ok('the referral ledger still gets exactly one row', DB.purchases.length === 1); }

console.log('\n=== 28-30. an upgrade nobody is entitled to is REFUSED, by name ===');
DB.reset();
{ /* on Free: there is nothing to upgrade from */
  const c = await post('/api/payments/create-order',
    { plan:'premium', billingPeriod:'monthly', kind:'upgrade' }, 'good-token');
  ok('a Free learner cannot upgrade', c.status===400 && c.body.code==='not_an_upgrade', c.body);

  /* on Premium already: nothing dearer to move to */
  const soon = new Date(); soon.setDate(soon.getDate() + 20);
  const prof = DB.profiles.get('stu-1');
  prof.subscription_plan = 'premium'; prof.plan_expires_at = soon.toISOString();
  const c2 = await post('/api/payments/create-order',
    { plan:'standard', billingPeriod:'monthly', kind:'upgrade' }, 'good-token');
  ok('a Premium learner cannot "upgrade" downwards',
     c2.status===400 && c2.body.code==='not_an_upgrade', c2.body);

  /* expired Standard: plan_of() says Free, so there is nothing to credit */
  const past = new Date(); past.setDate(past.getDate() - 1);
  prof.subscription_plan = 'standard'; prof.plan_expires_at = past.toISOString();
  const c3 = await post('/api/payments/create-order',
    { plan:'premium', billingPeriod:'monthly', kind:'upgrade' }, 'good-token');
  ok('an expired plan cannot be upgraded', c3.status===400 && c3.body.code==='not_an_upgrade', c3.body); }

console.log('\n=== 31-33. the browser still decides nothing about an upgrade ===');
DB.reset();
{ const soon = new Date(); soon.setDate(soon.getDate() + 15);
  const prof = DB.profiles.get('stu-1');
  prof.subscription_plan = 'standard'; prof.billing_cycle = 'monthly';
  prof.plan_expires_at = soon.toISOString();

  const c = await post('/api/payments/create-order',
    { plan:'premium', billingPeriod:'yearly', kind:'upgrade',
      amount: 100, final: 100, discount: 99, resellerId: 'res-1' }, 'good-token');
  ok('an amount sent by the browser is ignored', c.body.amount === 25000, c.body);
  ok('the period sent by the browser is ignored — the learner\'s own cycle is used',
     c.body.billingPeriod === 'monthly', c.body);
  ok('a reseller id sent by the browser buys no discount',
     c.body.resellerApplied === false, c.body); }

console.log('\n=== 34-35. a full term is still available to somebody who could upgrade ===');
DB.reset();
{ const soon = new Date(); soon.setDate(soon.getDate() + 15);
  const prof = DB.profiles.get('stu-1');
  prof.subscription_plan = 'standard'; prof.billing_cycle = 'monthly';
  prof.plan_expires_at = soon.toISOString();

  const r = await buy('premium','yearly',null);
  ok('buying a full Premium term still charges the full term',
     r.create.body.amount === 1499000, r.create.body);
  const want = new Date(soon); want.setMonth(want.getMonth() + 12);
  ok('and it EXTENDS from the old expiry, exactly as before',
     Math.abs(new Date(r.verify.body.order.expiresAt) - want) < 60000,
     { got:r.verify.body.order.expiresAt, want:want.toISOString() }); }

console.log('\n=== secrets never leave the process ===');
DB.reset();
{ const cfg = await realFetch(BASE + '/api/payments/config').then(r=>r.json());
  const c = await post('/api/payments/create-order', { plan:'premium', billingPeriod:'monthly' }, 'good-token');
  const all = JSON.stringify(cfg) + JSON.stringify(c.body);
  ok('no key secret in any response', !all.includes(KEY_SECRET));
  ok('no webhook secret in any response', !all.includes(WEBHOOK_SECRET));
  ok('the public key id IS returned, which is correct', cfg.keyId === KEY_ID); }

console.log('\n' + (fail ? `${fail} FAILED, ${pass} passed` : `all ${pass} checks passed`));
srvDb.close(); srvRzp.close(); srvApp.close();
process.exit(fail ? 1 : 0);
