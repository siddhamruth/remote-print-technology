// Single place where an order becomes PAID. Used by both /verify and the webhook,
// always driven by Cashfree's own API response, never by the request body.
import { fetchOrder, paymentOutcome } from '../../../src/payments/cashfree.js';
import { bookSlot, releaseSlot } from '../../../src/lease/slots.js';
import { prisma, cashfree } from './services.js';

export async function settlePayment(order) {
  if (order.paymentStatus === 'PAID') return 'PAID';
  const cfOrder = await fetchOrder(cashfree(), order.cfOrderId);
  const outcome = paymentOutcome(cfOrder, order.pricePaise);

  if (outcome === 'PENDING') return outcome;

  if (outcome === 'FAILED') {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'FAILED', status: 'PAYMENT_FAILED' } });
      if (order.slotId) await releaseSlot(tx, order.slotId, order.id);
    });
    return outcome;
  }

  await prisma.$transaction(async (tx) => {
    // Idempotent: only the first settle flips PENDING -> PAID.
    const { count } = await tx.order.updateMany({ where: { id: order.id, paymentStatus: { not: 'PAID' } }, data: { paymentStatus: 'PAID' } });
    if (count === 0) return;
    const booked = order.slotId ? await bookSlot(tx, order.slotId, order.id) : false;
    await tx.order.update({ where: { id: order.id }, data: { status: booked ? 'PAID' : 'SLOT_LOST' } });
  });
  return 'PAID';
}
