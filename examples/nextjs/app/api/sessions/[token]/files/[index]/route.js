// Server relay: browser -> this route -> Epson upload URI.
// Bytes are held in memory only (max 20 MB); nothing is written to disk and the Epson
// upload URI (a bearer capability) is never exposed to the browser.
import { prisma, epson, json, errorResponse } from '../../../../../../lib/services.js';
import { loadActiveSession, SessionError } from '../../../../../../../../src/session/print-session.js';
import { printSettingsFor, MAX_UPLOAD_BYTES } from '../../../../../../../../src/epson/client.js';

export async function PUT(req, { params }) {
  try {
    const { token, index } = await params;
    const session = await loadActiveSession(prisma, token);
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= session.order.quantity) throw new SessionError('Bad file index', 400);
    if (session.printClaimedAt) throw new SessionError('Already printed', 409);
    if (req.headers.get('content-type') !== 'image/jpeg') throw new SessionError('JPEG only', 415);
    if (Number(req.headers.get('content-length') || 0) > MAX_UPLOAD_BYTES) throw new SessionError('File exceeds 20 MB', 413);
    const bytes = Buffer.from(await req.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new SessionError('File must be 1 byte to 20 MB', 413);

    const { printMode, printSettings } = printSettingsFor(session.order.product);
    const { jobId, uploadUri } = await epson.createJob({ jobName: `order-${session.order.publicId}-${i + 1}`, printMode, printSettings });
    await epson.uploadFile(uploadUri, bytes, { ext: 'jpg', contentType: 'image/jpeg' });

    // Re-uploading an index replaces the previous job (customer swapped a photo).
    const prev = await prisma.printJob.findUnique({ where: { sessionId_fileIndex: { sessionId: session.id, fileIndex: i } } });
    if (prev) await epson.cancel(prev.epsonJobId).catch(() => {});
    await prisma.printJob.upsert({
      where: { sessionId_fileIndex: { sessionId: session.id, fileIndex: i } },
      create: { sessionId: session.id, fileIndex: i, epsonJobId: jobId },
      update: { epsonJobId: jobId, status: 'uploaded' },
    });
    return json({ uploaded: i });
  } catch (err) {
    return errorResponse(err);
  }
}
