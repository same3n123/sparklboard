/* =====================================================================
   I 4 Invent — the Shop: the Starter Kit, paid for on the page
   ---------------------------------------------------------------------
   TWO ENDPOINTS, and the rule payments.js is written against:

       POST /api/shop/create-order   check the delivery details, price
                                     it, open a Razorpay order
       POST /api/shop/verify         the browser callback

       POST /api/shop/notify         ADMIN ONLY: send the shipped or
                                     delivered email for an order the
                                     admin has just moved (or resend one)

   plus a hook on payments.js's webhook, so a Razorpay payment.captured
   for a kit is settled even if the buyer closed the tab.

   A KIT IS BOUGHT BY SOMEBODY WHO MAY HAVE NO ACCOUNT — a parent at a
   school gate with a phone — so, unlike a plan, neither endpoint needs a
   session. If a Bearer token IS sent it is checked with Supabase and the
   order is linked to that account; it is never trusted as a claim.

   THE BROWSER DECIDES NOTHING ABOUT MONEY. It sends a product KEY and the
   delivery details. The amount comes from public.shop_products (0036),
   in integer paise, written onto the order by the database, and that is
   the number Razorpay is asked for and the number a capture must match.

   THE CONFIRMATION EMAIL is sent from here, through Resend — the same
   provider and the same i4invent.com domain the sign-up and password
   emails already go out on. RESEND_API_KEY lives in this process's
   environment and never reaches a browser. shop_claim_email() makes the
   callback and the webhook agree on who sends it, so it goes exactly
   once; with no key configured the order still completes and the page
   says to keep the order number.

   ENVIRONMENT
     RESEND_API_KEY      sends the confirmation. Unset: no email, order still fine.
     SHOP_MAIL_FROM      default  I 4 Invent <orders@i4invent.com>
     SHOP_NOTIFY_EMAIL   optional; the team gets a BCC of every confirmation
     SHOP_REPLY_TO       optional; where a customer's reply goes
     SHOP_SITE           default  https://i4invent.com  (links in the email)
   ===================================================================== */
import express from 'express';
import { payCore, onUnknownOrder } from './payments.js';

const RESEND_KEY = String(process.env.RESEND_API_KEY || '').trim();
const MAIL_FROM  = String(process.env.SHOP_MAIL_FROM || 'I 4 Invent <orders@i4invent.com>').trim();
const NOTIFY     = String(process.env.SHOP_NOTIFY_EMAIL || '').trim();
const REPLY_TO   = String(process.env.SHOP_REPLY_TO || '').trim();
const SITE       = String(process.env.SHOP_SITE || 'https://i4invent.com').trim().replace(/\/+$/, '');

/* what is for sale, as the email names it — the PRICE is never here */
const PRODUCTS = {
  'starter-kit': { name: 'I 4 Invent Starter Kit — Level 1',
                   line: 'Every part for all 12 Level 1 projects, a pre-programmed Arduino and a complete starter book' }
};

export function shopStatus(){
  return { on: payCore.on(), email: !!RESEND_KEY, notify: !!NOTIFY };
}

/* ---------------------------------------------------------------------
   the delivery details: the form's rules again, because the form is a
   courtesy. The database checks them a third time (0036).
   --------------------------------------------------------------------- */
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
function readBuyer(b){
  b = b || {};
  return {
    product: clean(b.product, 40).toLowerCase(),
    name:    clean(b.name, 80),
    email:   clean(b.email, 254).toLowerCase(),
    phone:   String(b.phone || '').replace(/\D/g, '').slice(0, 13),
    address: clean(b.address, 300),
    city:    clean(b.city, 60),
    state:   clean(b.state, 40),
    pin:     String(b.pin || '').replace(/\D/g, '').slice(0, 6),
    inventor: clean(b.inventor, 60) || null
  };
}
function checkBuyer(f){
  if (!PRODUCTS[f.product]) return 'That product is not for sale.';
  if (f.name.length < 2) return 'Please tell us your name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return 'Please enter an email address we can send your confirmation to.';
  if (f.phone.length < 10) return 'Please enter a phone number — 10 digits, or with the country code.';
  if (f.address.length < 8) return 'Please give us the address the box should go to.';
  if (f.city.length < 2) return 'Please tell us the city.';
  if (f.state.length < 2) return 'Please tell us the state.';
  if (!/^\d{6}$/.test(f.pin)) return 'A PIN code is six digits.';
  return null;
}

const REASONS = ['no_such_product', 'invalid_name', 'invalid_email', 'invalid_phone', 'invalid_address',
  'invalid_city', 'invalid_state', 'invalid_pin', 'too_many_orders', 'shop_busy', 'order_not_open',
  'amount_mismatch', 'no_such_order'];
function reason(e){
  const m = String((e && e.message) || '');
  for (const r of REASONS) if (m.indexOf(r) >= 0) return r;
  return 'error';
}
function plain(e){
  const r = reason(e);
  if (r === 'too_many_orders') return 'We have several orders from these details today already. Please reach us on WhatsApp and we will sort it out.';
  if (r === 'shop_busy') return 'The shop is very busy just now. Please try again in a little while.';
  if (r.indexOf('invalid_') === 0) return 'Please check your details — one of them could not be accepted.';
  if (r === 'no_such_product') return 'That product is not for sale.';
  return 'That did not go through. Please try again.';
}

const first = rows => Array.isArray(rows) ? (rows[0] || null) : rows;
const ref = o => 'I4K-' + (o.order_no || String(o.id || '').slice(0, 8).toUpperCase());
const rupees = paise => '₹' + (Number(paise) / 100).toLocaleString('en-IN');

function publicShopOrder(o, emailed){
  if (!o) return null;
  return {
    id: o.id, ref: ref(o), product: o.product, amount: Number(o.amount_paise), currency: o.currency,
    status: o.status, email: o.email, paidAt: o.paid_at,
    /* the buyer's own private tracking link (0037); absent on a 0036 database */
    track: o.track_token || null,
    emailed: emailed === undefined ? !!o.email_sent_at : !!emailed
  };
}

/* =====================================================================
   THE EMAILS — three of them, one layout: branded like the sign-up and
   password emails, and readable with images off, because they carry none.

     confirmation   the moment the payment is settled (callback or webhook)
     shipped        when an admin marks the box shipped — courier + tracking
     delivered      when an admin marks it delivered

   Every one carries the order's private tracking link, /#order-<token>,
   which opens the Track your order page on that order with no sign-in.
   ===================================================================== */
const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const trackLink = o => o.track_token ? SITE + '/#order-' + o.track_token : SITE + '/#track';
const firstName = o => String(o.name || '').split(' ')[0] || 'there';

const BTN = 'display:inline-block;background:#00697F;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 18px;border-radius:8px';
const BTN2 = 'display:inline-block;background:#ffffff;color:#00697F;text-decoration:none;font-weight:700;font-size:14px;padding:9px 16px;border-radius:8px;border:1px solid #9ED8E6';

function mailShell(o, m){
  const row = (k, v, strong) => '<tr><td style="padding:8px 0;color:#5B6B7C;font-size:14px">' + h(k) +
    '</td><td style="padding:8px 0;text-align:right;font-size:14px;color:#0B1F38' + (strong ? ';font-weight:700' : '') + '">' + v + '</td></tr>';
  return '<!doctype html><html><body style="margin:0;background:#EEF3F7;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0B1F38">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF3F7;padding:28px 12px"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #D6E1EA">' +
      '<tr><td style="background:#0B1F38;padding:22px 28px">' +
        '<div style="font-size:20px;font-weight:800;letter-spacing:.14em;color:#ffffff">I 4 INVENT</div>' +
        '<div style="font-size:12px;letter-spacing:.12em;color:#7FE3F2;margin-top:2px">CURATING INVENTORS</div></td></tr>' +
      '<tr><td style="padding:28px 28px 8px">' +
        '<div style="display:inline-block;background:' + m.badgeBg + ';color:' + m.badgeInk + ';font-size:12px;font-weight:700;letter-spacing:.08em;padding:5px 10px;border-radius:999px">' + h(m.badge) + '</div>' +
        '<h1 style="font-size:22px;line-height:1.3;margin:14px 0 6px">' + h(m.heading) + '</h1>' +
        '<p style="font-size:15px;line-height:1.6;color:#33475B;margin:0">' + m.intro + '</p></td></tr>' +
      '<tr><td style="padding:18px 28px 4px">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E3EAF0;border-bottom:1px solid #E3EAF0">' +
          m.rows.map(r => row(r[0], r[1], r[2])).join('') +
        '</table></td></tr>' +
      (m.address ? '<tr><td style="padding:14px 28px 6px">' +
        '<div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#5B6B7C">DELIVERING TO</div>' +
        '<p style="font-size:14px;line-height:1.6;margin:6px 0 0">' + h(o.name) + '<br>' + h(o.address) + '<br>' +
          h(o.city) + ', ' + h(o.state) + ' — ' + h(o.pin) + '<br>Phone: ' + h(o.phone) + '</p></td></tr>' : '') +
      '<tr><td style="padding:18px 28px 8px">' +
        '<div style="background:#F3FAFC;border:1px solid #CDEBF2;border-radius:10px;padding:14px 16px">' +
          '<div style="font-weight:700;font-size:15px;margin-bottom:4px">' + h(m.boxTitle) + '</div>' +
          '<div style="font-size:14px;line-height:1.6;color:#33475B">' + m.boxText + '</div>' +
          '<div style="margin-top:12px">' + m.buttons.map((b, i) =>
            '<a href="' + h(b[1]) + '" style="' + (i ? BTN2 : BTN) + ';margin:0 8px 8px 0">' + h(b[0]) + '</a>').join('') + '</div>' +
        '</div></td></tr>' +
      '<tr><td style="padding:14px 28px 26px;font-size:13px;line-height:1.6;color:#5B6B7C">' +
        'Questions about your order? Reply to this email or reach us on WhatsApp, and quote <b>' + h(ref(o)) + '</b>.<br>' +
        'This is a one-time purchase — nothing renews and no card is kept on file.</td></tr>' +
    '</table>' +
    '<div style="font-size:12px;color:#7A8A99;margin-top:14px">I 4 Invent · ' + h(SITE.replace(/^https?:\/\//, '')) + '</div>' +
    '</td></tr></table></body></html>';
}

/* what each email says. `text` is the plain-text part, line by line */
function mailFor(o, kind){
  const p = PRODUCTS[o.product] || { name: o.product, line: '' };
  const track = trackLink(o), kit = SITE + '/#kit';
  const mono = s => '<span style="font-family:Consolas,monospace;font-size:13px">' + h(s) + '</span>';
  if (kind === 'shipped'){
    const courierRows = [['Order number', '<b>' + h(ref(o)) + '</b>'], ['Courier', h(o.courier || '—')]];
    if (o.tracking_no) courierRows.push(['Tracking number', mono(o.tracking_no), true]);
    return {
      subject: 'Shipped — ' + ref(o) + ' · your I 4 Invent Starter Kit is on its way',
      html: mailShell(o, {
        badge: 'SHIPPED', badgeBg: '#E1F3F7', badgeInk: '#00697F',
        heading: 'Good news, ' + firstName(o) + ' — your kit is on its way.',
        intro: 'Your Starter Kit has left us and is with ' + h(o.courier || 'the courier') + '. Here is how to follow it.',
        rows: courierRows, address: true,
        boxTitle: 'Follow your parcel',
        boxText: 'Use the tracking number with the courier, or open your order page — it shows every step, from packed to delivered.',
        buttons: [].concat(o.tracking_url ? [['Track with ' + (o.courier || 'the courier') + ' →', o.tracking_url]] : [],
                           [['Your order page →', track]])
      }),
      text: ['I 4 INVENT — SHIPPED', '', 'Good news, ' + firstName(o) + ' — your Starter Kit is on its way.', '',
        'Order number: ' + ref(o), 'Courier: ' + (o.courier || '—'),
        o.tracking_no ? 'Tracking number: ' + o.tracking_no : '', o.tracking_url ? 'Track with the courier: ' + o.tracking_url : '', '',
        'Delivering to:', o.name, o.address, o.city + ', ' + o.state + ' — ' + o.pin, '',
        'Your order page: ' + track, '', 'Questions? Reply to this email and quote ' + ref(o) + '.']
    };
  }
  if (kind === 'delivered'){
    return {
      subject: 'Delivered — ' + ref(o) + ' · time to build!',
      html: mailShell(o, {
        badge: 'DELIVERED', badgeBg: '#E3F7EC', badgeInk: '#146C3A',
        heading: 'Your Starter Kit has arrived, ' + firstName(o) + '!',
        intro: 'Open the box, open the starter book, and build your first circuit. The Arduino is already programmed — plug it in and it works.',
        rows: [['Order number', '<b>' + h(ref(o)) + '</b>'], ['Item', h(p.name)]], address: false,
        boxTitle: 'Where to start',
        boxText: 'Begin with Light an LED in your starter book, then scan the QR code on its page to build the same circuit on screen, step by step.',
        buttons: [['Open the kit page →', kit], ['Your order page', track]]
      }),
      text: ['I 4 INVENT — DELIVERED', '', 'Your Starter Kit has arrived, ' + firstName(o) + '!', '',
        'Order number: ' + ref(o), '', 'Start here: ' + kit, 'Your order page: ' + track, '',
        'Questions? Reply to this email and quote ' + ref(o) + '.']
    };
  }
  return {
    subject: 'Order confirmed — ' + ref(o) + ' · I 4 Invent Starter Kit',
    html: mailShell(o, {
      badge: 'ORDER CONFIRMED', badgeBg: '#E3F7EC', badgeInk: '#146C3A',
      heading: 'Thank you, ' + firstName(o) + '. Your order is confirmed.',
      intro: 'We have received your payment and your order is confirmed. We will pack your Starter Kit and email you again the moment it ships.',
      rows: [['Order number', '<b>' + h(ref(o)) + '</b>'], ['Item', h(p.name)], ['Quantity', '1'], ['Delivery', 'Included'],
             ['Amount paid', h(rupees(o.amount_paise)), true]]
        .concat(o.razorpay_payment_id ? [['Payment ID', '<span style="font-family:Consolas,monospace;font-size:12px">' + h(o.razorpay_payment_id) + '</span>']] : []),
      address: true,
      boxTitle: 'While you wait',
      boxText: h(p.line) + '. You can start today: every Level 1 project can be built on screen first, step by step.',
      buttons: [['Track your order →', track], ['Open the kit page', kit]]
    }),
    text: ['I 4 INVENT — ORDER CONFIRMED', '',
      'Thank you, ' + firstName(o) + '. We have received your payment and your Starter Kit order is confirmed.', '',
      'Order number: ' + ref(o), 'Item: ' + p.name, 'Quantity: 1', 'Amount paid: ' + rupees(o.amount_paise),
      o.razorpay_payment_id ? 'Payment ID: ' + o.razorpay_payment_id : '', '',
      'Delivering to:', o.name, o.address, o.city + ', ' + o.state + ' — ' + o.pin, 'Phone: ' + o.phone, '',
      'Track your order: ' + track, 'Start building on screen today: ' + kit, '',
      'Questions? Reply to this email and quote ' + ref(o) + '.']
  };
}

async function resendSend(o, kind, key){
  const m = mailFor(o, kind);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY, 'Idempotency-Key': key },
    body: JSON.stringify(Object.assign({
      from: MAIL_FROM, to: [o.email], subject: m.subject, html: m.html, text: m.text.join('\n')
    }, NOTIFY ? { bcc: [NOTIFY] } : {}, REPLY_TO ? { reply_to: REPLY_TO } : {}))
  });
  if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
}

/* Exactly once: the database says who sends it. `force` is an admin's
   explicit "send it again" — it skips the claim, and still records it. */
const CLAIM = {
  confirmation: o => payCore.rpc('shop_claim_email', { p_order: o.id }),
  shipped:      o => payCore.rpc('shop_claim_notice', { p_order: o.id, p_kind: 'shipped' }),
  delivered:    o => payCore.rpc('shop_claim_notice', { p_order: o.id, p_kind: 'delivered' })
};
const RELEASE = {
  confirmation: o => payCore.rpc('shop_release_email', { p_order: o.id }),
  shipped:      o => payCore.rpc('shop_release_notice', { p_order: o.id, p_kind: 'shipped' }),
  delivered:    o => payCore.rpc('shop_release_notice', { p_order: o.id, p_kind: 'delivered' })
};
const SENT_AT = { confirmation: 'email_sent_at', shipped: 'shipped_email_at', delivered: 'delivered_email_at' };

async function sendNotice(o, kind, force){
  if (!RESEND_KEY || !o || !o.id || !CLAIM[kind]) return false;
  let claimed = false;
  try { claimed = (await CLAIM[kind](o)) === true; }
  catch(e){ console.error('shop email (claim ' + kind + '):', e.message); if (!force) return false; }
  if (!claimed && !force) return !!o[SENT_AT[kind]];
  try {
    await resendSend(o, kind, 'shop-' + kind + '-' + o.id + (force ? '-' + Date.now() : ''));
    return true;
  } catch(e){
    console.error('shop email (send ' + kind + '):', e.message);
    /* hand the claim back, so the next arrival — or the admin — tries again */
    if (claimed) try { await RELEASE[kind](o); } catch(_){}
    return false;
  }
}
const sendConfirmation = o => sendNotice(o, 'confirmation', false);

/* =====================================================================
   the webhook's share: Razorpay's own word settles a kit too
   ===================================================================== */
onUnknownOrder(async (event, ent, rzpOrderId) => {
  let order;
  try { order = first(await payCore.rpc('shop_order_by_razorpay', { p_rzp_order: rzpOrderId })); }
  catch(e){ console.error('shop webhook (lookup):', e.message); return false; }
  if (!order) return false;
  if (event === 'payment.captured'){
    let paid;
    try {
      paid = first(await payCore.rpc('shop_mark_paid',
        { p_order: order.id, p_payment_id: ent.id || null, p_amount: Number(ent.amount) }));
    } catch(e){
      /* a capture that does not match the order is flagged for a person to
         look at, and answered 200 — a retry would only mismatch again */
      if (reason(e) !== 'amount_mismatch') throw e;
      console.error('shop webhook: amount mismatch on order', order.id);
      await payCore.rpc('shop_mark_failed', { p_order: order.id, p_reason: 'amount_mismatch' });
      return true;
    }
    await sendConfirmation(paid);
  } else if (event === 'payment.failed'){
    await payCore.rpc('shop_mark_failed', { p_order: order.id, p_reason: 'payment.failed' });
  } else if (event === 'refund.processed' || event === 'refund.created'){
    await payCore.rpc('shop_mark_refunded', { p_order: order.id });
  }
  return true;
});

/* =====================================================================
   the router
   ===================================================================== */
/* ten checkouts in ten minutes from one address is already far past a
   real buyer; the database's own per-email and per-day caps are the check */
const HITS = new Map();
function tooFast(ip){
  const now = Date.now(), W = 600000;
  const list = (HITS.get(ip) || []).filter(t => now - t < W);
  list.push(now); HITS.set(ip, list);
  if (HITS.size > 5000) HITS.clear();
  return list.length > 10;
}

export function shopRoutes(){
  const r = express.Router();

  r.post('/api/shop/create-order', async (req, res) => {
    if (!payCore.on()) return res.status(503).json({ error: 'Online payment is not switched on yet.', code: 'payments_off' });
    if (tooFast(String(req.get('x-forwarded-for') || req.ip || 'anon').split(',')[0].trim()))
      return res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.', code: 'too_fast' });

    const f = readBuyer(req.body);
    const bad = checkBuyer(f);
    if (bad) return res.status(400).json({ error: bad, code: 'invalid_details' });

    /* a session, if one was sent, only LINKS the order — it is checked, never read */
    let user = null;
    try { user = await payCore.whoIs(payCore.bearer(req)); } catch(_){ user = null; }

    let order;
    try {
      order = first(await payCore.rpc('shop_open_order', {
        p_product: f.product, p_name: f.name, p_email: f.email, p_phone: f.phone,
        p_address: f.address, p_city: f.city, p_state: f.state, p_pin: f.pin,
        p_inventor: f.inventor, p_user: user ? user.id : null }));
      if (!order || !order.id) throw new Error('order_not_created');
    } catch(e){
      console.error('shop create-order (open):', e.message);
      return res.status(/does not exist|schema cache/i.test(e.message) ? 503 : 400)
        .json({ error: /does not exist|schema cache/i.test(e.message)
                  ? 'The shop is not set up on this server yet.' : plain(e), code: reason(e) });
    }

    try {
      const rzpOrder = await payCore.rzp('/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(order.amount_paise),            /* paise, from the database */
          currency: order.currency || 'INR',
          receipt: order.id,
          notes: { i4_shop: order.id, product: order.product, ref: ref(order) }
        })
      });
      await payCore.rpc('shop_attach_razorpay', { p_order: order.id, p_rzp_order: rzpOrder.id });
      return res.json({
        orderId: order.id, ref: ref(order), razorpayOrderId: rzpOrder.id, keyId: payCore.keyId(),
        amount: Number(order.amount_paise), currency: order.currency || 'INR',
        product: order.product, productName: (PRODUCTS[order.product] || {}).name || order.product,
        name: order.name, email: order.email, phone: order.phone,
        track: order.track_token || null
      });
    } catch(e){
      console.error('shop create-order (razorpay):', e.message);
      try { await payCore.rpc('shop_mark_failed', { p_order: order.id, p_reason: 'razorpay_order_failed' }); } catch(_){}
      return res.status(502).json({ error: 'Could not reach the payment provider. Nothing was charged.' });
    }
  });

  /* The body is UNTRUSTED. The Razorpay order id the signature is checked
     against is OURS, read from the order row — never the request's. */
  r.post('/api/shop/verify', async (req, res) => {
    if (!payCore.on()) return res.status(503).json({ error: 'Online payment is not switched on yet.' });
    const orderId   = String((req.body && req.body.orderId) || '').trim();
    const paymentId = String((req.body && req.body.razorpay_payment_id) || '').trim();
    const signature = String((req.body && req.body.razorpay_signature) || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(orderId) || !paymentId || !signature)
      return res.status(400).json({ error: 'Incomplete payment details.' });

    let order;
    try { order = first(await payCore.rpc('shop_order_get', { p_order: orderId })); } catch(e){ order = null; }
    if (!order) return res.status(404).json({ error: 'No such order.' });

    if (order.status !== 'pending' && order.status !== 'failed'){
      const emailed = await sendConfirmation(order);
      return res.json({ ok: true, alreadyProcessed: true, order: publicShopOrder(order, emailed || !!order.email_sent_at) });
    }
    if (!order.razorpay_order_id) return res.status(409).json({ error: 'That order was never sent for payment.' });

    if (!payCore.paymentSignatureOk(order.razorpay_order_id, paymentId, signature)){
      console.error('shop verify: bad signature for order', orderId);
      return res.status(400).json({ error: 'That payment could not be verified.' });
    }

    let check;
    try {
      check = await payCore.reconcile({ razorpay_order_id: order.razorpay_order_id,
        currency: order.currency, final_amount: order.amount_paise }, paymentId);
    } catch(e){
      console.error('shop verify (reconcile):', e.message);
      return res.status(502).json({ error: 'Could not confirm the payment yet. If it went through, your confirmation email will arrive shortly.' });
    }
    if (!check.ok){
      console.error('shop verify: reconcile failed', check.why, 'order', orderId);
      if (/amount|currency|order_mismatch/.test(check.why)){
        try { await payCore.rpc('shop_mark_failed', { p_order: orderId, p_reason: check.why }); } catch(_){}
        return res.status(400).json({ error: 'This payment did not match the order. It has been flagged for review.' });
      }
      return res.json({ ok: false, pending: true, ref: ref(order),
        message: 'Payment received and waiting to be confirmed. Your confirmation email will follow shortly.' });
    }

    try {
      const paid = first(await payCore.rpc('shop_mark_paid',
        { p_order: orderId, p_payment_id: paymentId, p_amount: Number(check.payment.amount) }));
      const emailed = await sendConfirmation(paid);
      return res.json({ ok: true, order: publicShopOrder(paid, emailed) });
    } catch(e){
      console.error('shop verify (mark paid):', e.message);
      return res.status(400).json({ error: plain(e), code: reason(e) });
    }
  });

  /* -------------------------------------------------------------------
     notify — the admin moved an order on the Kit orders page and asks for
     the email that goes with it. The admin's OWN token calls
     admin_shop_order(), which checks is_admin() from inside: this file
     never decides who is an admin. Only then is the row read with the
     service key and the email sent, once (or again, with resend).
     ------------------------------------------------------------------- */
  r.post('/api/shop/notify', async (req, res) => {
    if (!payCore.dbOn()) return res.status(503).json({ error: 'The shop is not set up on this server.' });
    const token = payCore.bearer(req);
    if (!token) return res.status(401).json({ error: 'Sign in first.' });
    const orderId = String((req.body && req.body.orderId) || '').trim();
    const kind = String((req.body && req.body.kind) || '').trim();
    const resend = !!(req.body && req.body.resend === true);
    if (!/^[0-9a-f-]{36}$/i.test(orderId) || !CLAIM[kind])
      return res.status(400).json({ error: 'Which order, and which email?' });

    try { await payCore.rpc('admin_shop_order', { p_id: orderId }, token); }
    catch(e){
      const m = String(e.message || '');
      return res.status(/not_an_admin/.test(m) ? 403 : /no_such_order/.test(m) ? 404 : 400)
        .json({ error: /not_an_admin/.test(m) ? 'That is for administrators only.' : 'That order could not be read.' });
    }
    let o;
    try { o = first(await payCore.rpc('shop_order_get', { p_order: orderId })); } catch(e){ o = null; }
    if (!o) return res.status(404).json({ error: 'No such order.' });
    const fits = { confirmation: ['paid', 'packed', 'shipped', 'delivered'], shipped: ['shipped', 'delivered'], delivered: ['delivered'] };
    if (fits[kind].indexOf(o.status) < 0)
      return res.status(409).json({ error: 'That email does not match where the order is (' + o.status + ').' });
    if (!RESEND_KEY) return res.json({ sent: false, emailOff: true });
    /* already gone, and nobody asked for it again: say so rather than
       reporting a send that did not happen */
    if (o[SENT_AT[kind]] && !resend) return res.json({ sent: false, already: true });
    const sent = await sendNotice(o, kind, resend);
    return res.json({ sent });
  });

  return r;
}
