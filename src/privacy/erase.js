/**
 * PII erasure. Run on a schedule (cron / PM2 / systemd timer), not on demand from the browser.
 *
 * Nulls out customer PII on orders delivered more than `retentionMs` ago.
 * Keeps non-identifying fields (product, amount, dates) for accounting.
 *
 * Note: your payment gateway and courier keep their own records of name/phone/email
 * (regulatory requirement). Say so in your privacy policy — do not claim
 * "nobody can identify you" if a processor still can.
 */
export async function erasePiiAfterDelivery(db, { retentionMs = 24 * 60 * 60_000, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - retentionMs);
  const { count } = await db.order.updateMany({
    where: { deliveredAt: { lt: cutoff }, piiErasedAt: null },
    data: {
      customerName: null,
      customerEmail: null,
      customerPhone: null,
      shippingAddress: null,
      piiErasedAt: now,
    },
  });
  return count;
}
