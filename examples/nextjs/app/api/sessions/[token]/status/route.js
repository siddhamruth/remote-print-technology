import { prisma, epson, json, errorResponse } from '../../../../../lib/services.js';
import { loadActiveSession } from '../../../../../../../src/session/print-session.js';
import { classifyJobStatus } from '../../../../../../../src/epson/client.js';

export async function GET(_req, { params }) {
  try {
    const { token } = await params;
    const session = await loadActiveSession(prisma, token);
    const jobs = await prisma.printJob.findMany({ where: { sessionId: session.id }, orderBy: { fileIndex: 'asc' } });

    const results = [];
    for (const job of jobs) {
      const { status } = await epson.getJob(job.epsonJobId);
      if (status !== job.status) await prisma.printJob.update({ where: { id: job.id }, data: { status } });
      results.push({ index: job.fileIndex, status, state: classifyJobStatus(status) });
    }

    const states = results.map((r) => r.state);
    const overall = states.length && states.every((s) => s === 'done') ? 'done'
      : states.includes('failed') ? 'failed'
      : states.includes('needs_operator') ? 'needs_operator' // alert staff: paper/ink/jam
      : 'in_progress';
    if (overall === 'done' || overall === 'failed') {
      await prisma.order.update({ where: { id: session.orderId }, data: { status: overall === 'done' ? 'PRINT_COMPLETE' : 'PRINT_FAILED' } });
    }
    return json({ overall, jobs: results });
  } catch (err) {
    return errorResponse(err);
  }
}
