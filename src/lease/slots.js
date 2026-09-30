/**
 * Hardware time-share lease: the printer's day is cut into fixed windows,
 * and each window can belong to exactly one paid order.
 *
 * Slot states:
 *   free      isAvailable = true,  heldUntil null or in the past
 *   held      isAvailable = true,  heldUntil in the future (checkout in progress)
 *   booked    isAvailable = false  (payment verified)
 *
 * Every transition is ONE conditional UPDATE. Postgres row locking makes it atomic,
 * so two concurrent checkouts can never both win (no read-then-write race).
 */

/**
 * Convert a wall-clock time in a fixed-offset zone to a UTC Date.
 * India has no DST, so a fixed offset is exact for Asia/Kolkata (+05:30).
 * @param {string} isoDate 'YYYY-MM-DD'
 * @param {string} hhmm    'HH:MM'
 * @param {number} offsetMinutes e.g. 330 for IST
 */
export function zonedTimeToUtc(isoDate, hhmm, offsetMinutes) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - offsetMinutes * 60_000);
}

/**
 * Generate slot windows for one day, as absolute UTC instants.
 * @returns {{ startsAt: Date, endsAt: Date }[]}
 */
export function generateDaySlots(isoDate, { open = '10:00', close = '21:00', minutes = 15, offsetMinutes = 330 } = {}) {
  const start = zonedTimeToUtc(isoDate, open, offsetMinutes).getTime();
  const end = zonedTimeToUtc(isoDate, close, offsetMinutes).getTime();
  const step = minutes * 60_000;
  const out = [];
  for (let t = start; t + step <= end; t += step) {
    out.push({ startsAt: new Date(t), endsAt: new Date(t + step) });
  }
  return out;
}

export class SlotUnavailableError extends Error {
  constructor(message = 'Slot is not available') {
    super(message);
    this.status = 409;
  }
}

/**
 * Soft-hold a slot during checkout. Throws SlotUnavailableError if someone else has it.
 * Call inside the same transaction that creates the order, so a failed hold rolls the order back.
 * @param {import('@prisma/client').Prisma.TransactionClient} db
 */
export async function holdSlot(db, slotId, orderId, { holdMs = 10 * 60_000, now = new Date() } = {}) {
  const { count } = await db.slot.updateMany({
    where: {
      id: slotId,
      isAvailable: true,
      startsAt: { gt: now },
      OR: [{ heldUntil: null }, { heldUntil: { lt: now } }],
    },
    data: { heldUntil: new Date(now.getTime() + holdMs), heldByOrderId: orderId },
  });
  if (count !== 1) throw new SlotUnavailableError();
}

/**
 * Convert a hold into a booking once payment is verified.
 * Returns false if the hold expired and another order grabbed the slot meanwhile —
 * the caller must then refund or rebook instead of double-booking.
 */
export async function bookSlot(db, slotId, orderId, { now = new Date() } = {}) {
  const { count } = await db.slot.updateMany({
    where: {
      id: slotId,
      isAvailable: true,
      OR: [{ heldByOrderId: orderId }, { heldUntil: null }, { heldUntil: { lt: now } }],
    },
    data: { isAvailable: false, heldUntil: null, heldByOrderId: orderId },
  });
  return count === 1;
}

/** Release a hold (payment failed / abandoned). Only releases if this order still owns it. */
export async function releaseSlot(db, slotId, orderId) {
  await db.slot.updateMany({
    where: { id: slotId, isAvailable: true, heldByOrderId: orderId },
    data: { heldUntil: null, heldByOrderId: null },
  });
}
