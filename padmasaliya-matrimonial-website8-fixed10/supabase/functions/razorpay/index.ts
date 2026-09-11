// ---------------------------------------------------------------------------
//  Razorpay — the only place that may add credits to an account.
//
//  Why this is not a database function: creating a Razorpay order and checking
//  a payment signature both need the Key Secret. A secret in the browser is
//  not a secret, and Postgres cannot call an external API, so it lives here.
//
//  Three jobs:
//    create-order  the browser asks for an order; we price it from OUR table,
//                  never from anything the browser sent
//    verify        the browser reports a payment; we check Razorpay's HMAC
//                  before a single credit is granted
//    webhook       Razorpay tells us directly, so a payment still lands even
//                  if the member closed the tab mid-transaction
//
//  Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function
//  Name it exactly "razorpay" and paste this file in.
//
//  Turn OFF "Verify JWT" for this function. Razorpay's webhook arrives with no
//  user token, so the platform's own gate would reject it before this code ran.
//  Nothing is lost by turning it off: every member-facing path below checks the
//  token itself, and the webhook path is gated by its HMAC signature instead.
//
//  Then set these secrets (Edge Functions -> Manage secrets):
//    RAZORPAY_KEY_ID       from the Razorpay dashboard
//    RAZORPAY_KEY_SECRET   from the Razorpay dashboard
//    RAZORPAY_WEBHOOK_SECRET  whatever you typed when creating the webhook
// ---------------------------------------------------------------------------

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';
const KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';
const WEBHOOK_SECRET = Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-razorpay-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// HMAC-SHA256, hex — what Razorpay signs both callbacks and webhooks with.
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time compare: a plain === leaks how much of the signature matched.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Service-role client: this function is the only thing allowed to grant
// credits, and grant_credits() has EXECUTE revoked from anon/authenticated.
const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    // ---- Razorpay's own webhook arrives without a user token -------------
    const webhookSig = req.headers.get('x-razorpay-signature');
    if (webhookSig) return await handleWebhook(req, webhookSig);

    // ---- everything else is a signed-in member ---------------------------
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'AUTH_REQUIRED' }, 401);

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'AUTH_REQUIRED' }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({}));

    if (body.action === 'create-order') return await createOrder(user.id, body.pack_id);
    if (body.action === 'verify') return await verify(user.id, body);

    return json({ error: 'UNKNOWN_ACTION' }, 400);
  } catch (e) {
    console.error('razorpay function error', e);
    return json({ error: 'SERVER_ERROR' }, 500);
  }
});

// ---------------------------------------------------------------------------
//  create-order
// ---------------------------------------------------------------------------
async function createOrder(userId: string, packId: string) {
  if (!KEY_ID || !KEY_SECRET) return json({ error: 'RAZORPAY_NOT_CONFIGURED' }, 503);

  // The price comes from our table, never from the request. A browser that
  // asks for 50 credits at Rs 1 gets the real price of the 50-credit pack.
  const { data: pack } = await admin
    .from('credit_packs').select('*').eq('id', packId).eq('active', true).single();
  if (!pack) return json({ error: 'BAD_PACK' }, 400);

  // Razorpay rejects anything under a rupee, and a zero-rupee pack would mean
  // a misconfigured price row handing out free credits.
  if (!Number.isInteger(pack.price_paise) || pack.price_paise < 100) {
    console.error('pack has a bad price', pack.id, pack.price_paise);
    return json({ error: 'BAD_AMOUNT' }, 400);
  }

  // Nor may someone buy more credits than they have profiles to spend on.
  const { data: canCount } = await admin.rpc('unlockable_count', { uid: userId });
  if (typeof canCount === 'number' && pack.credits > canCount) {
    return json({ error: 'PACK_TOO_BIG' }, 400);
  }

  const receipt = 'pm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 30);
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + btoa(`${KEY_ID}:${KEY_SECRET}`),
    },
    body: JSON.stringify({
      amount: pack.price_paise,
      currency: 'INR',
      receipt,
      notes: { user_id: userId, pack_id: pack.id, credits: String(pack.credits) },
    }),
  });

  if (!res.ok) {
    console.error('razorpay order failed', await res.text());
    return json({ error: 'ORDER_FAILED' }, 502);
  }
  const order = await res.json();

  // Recorded before the member pays, so an abandoned checkout is visible in
  // the admin panel rather than silently missing.
  await admin.from('credit_payments').insert({
    user_id: userId,
    pack_id: pack.id,
    credits: pack.credits,
    amount_paise: pack.price_paise,
    razorpay_order_id: order.id,
    status: 'created',
  });

  return json({
    razorpay_order_id: order.id,
    amount: pack.price_paise,
    credits: pack.credits,
    key_id: KEY_ID,
  });
}

// ---------------------------------------------------------------------------
//  verify — the browser's callback
// ---------------------------------------------------------------------------
async function verify(userId: string, body: Record<string, string>) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return json({ error: 'MISSING_FIELDS' }, 400);
  }

  if (!KEY_SECRET) return json({ error: 'RAZORPAY_NOT_CONFIGURED' }, 503);

  const expected = await hmacHex(KEY_SECRET, `${razorpay_order_id}|${razorpay_payment_id}`);
  if (!safeEqual(expected, razorpay_signature)) {
    await admin.from('credit_payments')
      .update({ status: 'failed' }).eq('razorpay_order_id', razorpay_order_id);
    return json({ error: 'BAD_SIGNATURE' }, 400);
  }

  return await creditOrder(razorpay_order_id, razorpay_payment_id, userId);
}

// ---------------------------------------------------------------------------
//  webhook — Razorpay telling us directly
// ---------------------------------------------------------------------------
async function handleWebhook(req: Request, signature: string) {
  const raw = await req.text();
  if (!WEBHOOK_SECRET) return json({ error: 'WEBHOOK_NOT_CONFIGURED' }, 503);

  const expected = await hmacHex(WEBHOOK_SECRET, raw);
  if (!safeEqual(expected, signature)) return json({ error: 'BAD_SIGNATURE' }, 400);

  const event = JSON.parse(raw);
  if (event.event !== 'payment.captured') return json({ ok: true, ignored: event.event });

  const payment = event.payload?.payment?.entity;
  if (!payment?.order_id) return json({ ok: true });

  return await creditOrder(payment.order_id, payment.id, null);
}

// ---------------------------------------------------------------------------
//  The one path that grants credits. Both the callback and the webhook end
//  here, and it is safe to run twice — the status check is the guard, so a
//  member who pays once is never credited twice.
// ---------------------------------------------------------------------------
async function creditOrder(orderId: string, paymentId: string, expectUser: string | null) {
  const { data: row } = await admin
    .from('credit_payments').select('*').eq('razorpay_order_id', orderId).single();

  if (!row) return json({ error: 'ORDER_NOT_FOUND' }, 404);
  if (expectUser && row.user_id !== expectUser) return json({ error: 'NOT_YOUR_ORDER' }, 403);
  if (row.status === 'paid') return json({ ok: true, already: true });

  const { error: markErr } = await admin
    .from('credit_payments')
    .update({ status: 'paid', razorpay_payment_id: paymentId, paid_at: new Date().toISOString() })
    .eq('razorpay_order_id', orderId)
    .eq('status', 'created');          // only the first writer wins
  if (markErr) return json({ error: 'UPDATE_FAILED' }, 500);

  const { error: grantErr } = await admin.rpc('grant_credits', {
    p_user_id: row.user_id,
    p_credits: row.credits,
    p_source: 'razorpay:' + paymentId,
  });
  if (grantErr) {
    console.error('grant_credits failed after payment', orderId, grantErr);
    return json({ error: 'GRANT_FAILED' }, 500);
  }

  return json({ ok: true, credits: row.credits });
}
