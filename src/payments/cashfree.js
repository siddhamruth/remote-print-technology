/**
 * Cashfree Payment Gateway (API version 2023-08-01).
 *
 * Rules that keep payments un-forgeable:
 *   - The browser never decides whether an order is paid. Only the server does,
 *     by asking Cashfree (GET /orders/{id}) or by a webhook with a valid signature.
 *   - Webhooks without signature headers are rejected, never "skipped".
 *   - Amount and currency are re-checked against the database before marking PAID.
 */

import crypto from 'node:crypto';

const API_VERSION = '2023-08-01';

export function cashfreeConfig(env = process.env) {
  const isProd = env.CASHFREE_ENV === 'production';
  const appId = env.CASHFREE_APP_ID;
  const secretKey = env.CASHFREE_SECRET_KEY;
  if (!appId || !secretKey) throw new Error('CASHFREE_APP_ID / CASHFREE_SECRET_KEY not set');
  return { appId, secretKey, apiBase: isProd ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg' };
}

function headers({ appId, secretKey }) {
  return {
    'Content-Type': 'application/json',
    'x-client-id': appId,
    'x-client-secret': secretKey,
    'x-api-version': API_VERSION,
  };
}

/**
 * Create a Cashfree order. Returns the payment_session_id the browser SDK needs.
 * @param {{ cfOrderId: string, amountPaise: number, customer: { id: string, name: string, email: string, phone: string }, returnUrl: string, notifyUrl: string }} input
 */
export async function createOrder(cfg, input, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.apiBase}/orders`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({
      order_id: input.cfOrderId,
      order_amount: input.amountPaise / 100,
      order_currency: 'INR',
      customer_details: {
        customer_id: input.customer.id,
        customer_name: input.customer.name,
        customer_email: input.customer.email,
        customer_phone: input.customer.phone,
      },
      order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'Cashfree order creation failed'), { status: 502 });
  return { paymentSessionId: data.payment_session_id };
}

export async function fetchOrder(cfg, cfOrderId, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.apiBase}/orders/${encodeURIComponent(cfOrderId)}`, { headers: headers(cfg) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'Cashfree status check failed'), { status: 502 });
  return data;
}

/**
 * Decide the payment outcome from a Cashfree order object.
 * @returns {'PAID'|'PENDING'|'FAILED'}
 */
export function paymentOutcome(cfOrder, expectedPaise) {
  if (cfOrder.order_status === 'PAID') {
    const paidPaise = Math.round(Number(cfOrder.order_amount) * 100);
    if (paidPaise !== expectedPaise || cfOrder.order_currency !== 'INR') {
      throw Object.assign(new Error(`Amount mismatch: paid ${paidPaise}, expected ${expectedPaise}`), { status: 409 });
    }
    return 'PAID';
  }
  // ACTIVE = customer may still be on the payment page; do not release the slot yet.
  if (cfOrder.order_status === 'ACTIVE') return 'PENDING';
  return 'FAILED'; // EXPIRED, TERMINATED, TERMINATION_REQUESTED
}

/**
 * Verify a Cashfree webhook: base64(HMAC-SHA256(secret, timestamp + rawBody)).
 * @param {string} rawBody  exact request body text — do not re-serialize parsed JSON
 * @param {string|null} signature  x-webhook-signature header
 * @param {string|null} timestamp  x-webhook-timestamp header (ms since epoch)
 */
export function verifyWebhook(secretKey, rawBody, signature, timestamp, { maxAgeMs = 5 * 60_000, now = Date.now() } = {}) {
  if (!secretKey || !signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxAgeMs) return false;
  const expected = crypto.createHmac('sha256', secretKey).update(`${timestamp}${rawBody}`).digest();
  let given;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
