// Called by the return page after Cashfree redirects back. Safe to call repeatedly.
import { prisma, json, errorResponse } from '../../../../../lib/services.js';
import { settlePayment } from '../../../../../lib/settle-payment.js';

export async function POST(_req, { params }) {
  try {
    const { publicId } = await params;
    const order = await prisma.order.findUnique({ where: { publicId } });
    if (!order?.cfOrderId) return json({ error: 'Order not found' }, 404);
    return json({ payment: await settlePayment(order) });
  } catch (err) {
    return errorResponse(err);
  }
}
