import { prisma, cashfree, json, errorResponse } from '../../../../lib/services.js';
import { verifyWebhook } from '../../../../../../src/payments/cashfree.js';
import { settlePayment } from '../../../../lib/settle-payment.js';

export async function POST(req) {
  try {
    const raw = await req.text();
    const ok = verifyWebhook(
      cashfree().secretKey, raw,
      req.headers.get('x-webhook-signature'), req.headers.get('x-webhook-timestamp'),
    );
    if (!ok) return json({ error: 'Invalid signature' }, 401); // missing headers => rejected

    const cfOrderId = JSON.parse(raw)?.data?.order?.order_id;
    const order = cfOrderId && (await prisma.order.findUnique({ where: { cfOrderId } }));
    if (order) await settlePayment(order); // re-checks with Cashfree API; ignores body status
    return json({ received: true });
  } catch (err) {
    return errorResponse(err);
  }
}
