/**
 * The customer-facing print session: a short-lived capability that lets exactly one
 * paid order push files to the printer, only inside its booked window, exactly once.
 */

import crypto from 'node:crypto';

/** 256-bit URL-safe token. UUIDv4 is fine too, but never use sequential ids. */
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Store only a hash of bearer tokens, so a DB leak does not leak live sessions. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class SessionError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Open a session for a booked slot. Called by the scheduler when slot.startsAt arrives.
 * The session lives exactly as long as the slot.
 */
export async function openSession(db, order, slot) {
  const token = newToken();
  await db.printSession.create({
    data: { orderId: order.id, tokenHash: hashToken(token), opensAt: slot.startsAt, expiresAt: slot.endsAt },
  });
  return token; // email this to the customer; it is never stored in plain text
}

/** Load a session by token and enforce the time window. */
export async function loadActiveSession(db, token, now = new Date()) {
  const session = await db.printSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { order: true },
  });
  if (!session) throw new SessionError('Session not found', 404);
  if (now < session.opensAt) throw new SessionError('Session has not started yet', 425);
  if (now >= session.expiresAt) throw new SessionError('Session has expired', 410);
  return session;
}

/**
 * Atomically claim the one-and-only print for this session.
 * Two concurrent "PRINT" clicks: exactly one gets `true`.
 */
export async function claimPrint(db, sessionId, now = new Date()) {
  const { count } = await db.printSession.updateMany({
    where: { id: sessionId, printClaimedAt: null, expiresAt: { gt: now } },
    data: { printClaimedAt: now },
  });
  if (count !== 1) throw new SessionError('Print already triggered for this session', 409);
}
