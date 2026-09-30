// Background worker (PM2 / systemd). Every 30 s:
//   - opens print sessions for booked slots whose window started, emails the link
//   - marks paid orders whose window passed without a session as SLOT_MISSED
//   - erases PII 24 h after delivery
import { prisma } from '../lib/services.js';
import { openSession } from '../../../src/session/print-session.js';
import { erasePiiAfterDelivery } from '../../../src/privacy/erase.js';

async function tick(now = new Date()) {
  const due = await prisma.order.findMany({
    where: { status: 'PAID', session: null, slot: { startsAt: { lte: now } } },
    include: { slot: true },
  });
  for (const order of due) {
    if (now >= order.slot.endsAt) {
      await prisma.order.update({ where: { id: order.id }, data: { status: 'SLOT_MISSED' } });
      continue;
    }
    const token = await openSession(prisma, order, order.slot);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'SESSION_OPEN' } });
    await sendSessionEmail(order, `${process.env.PUBLIC_BASE_URL}/session/${token}`);
  }
  await erasePiiAfterDelivery(prisma, { now });
}

async function sendSessionEmail(order, link) {
  // Plug in nodemailer / SES / Postmark. Never log `link`: it is a bearer credential.
  console.log(`[scheduler] session opened for order ${order.publicId}`);
}

setInterval(() => tick().catch((e) => console.error('[scheduler]', e)), 30_000);
tick().catch((e) => console.error('[scheduler]', e));
