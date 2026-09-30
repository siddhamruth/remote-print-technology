// The customer's PRINT button. Exactly once per session, only inside the booked window,
// only when every paid-for photo is uploaded. Job ids come from the DB, never the request.
import { prisma, epson, json, errorResponse } from '../../../../../lib/services.js';
import { loadActiveSession, claimPrint, SessionError } from '../../../../../../../src/session/print-session.js';

export async function POST(_req, { params }) {
  try {
    const { token } = await params;
    const session = await loadActiveSession(prisma, token);
    const jobs = await prisma.printJob.findMany({ where: { sessionId: session.id }, orderBy: { fileIndex: 'asc' } });
    if (jobs.length !== session.order.quantity) throw new SessionError(`Upload all ${session.order.quantity} photos first`, 400);

    await claimPrint(prisma, session.id); // atomic; second click gets 409
    await prisma.order.update({ where: { id: session.orderId }, data: { status: 'PRINTING' } });

    for (const job of jobs) {
      await epson.print(job.epsonJobId);
      await prisma.printJob.update({ where: { id: job.id }, data: { status: 'pending' } });
    }
    return json({ printing: jobs.length });
  } catch (err) {
    return errorResponse(err);
  }
}
