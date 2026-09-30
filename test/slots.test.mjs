import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDaySlots, zonedTimeToUtc, holdSlot, bookSlot, SlotUnavailableError } from '../src/lease/slots.js';

test('IST wall-clock converts to correct UTC instant', () => {
  assert.equal(zonedTimeToUtc('2026-10-01', '10:00', 330).toISOString(), '2026-10-01T04:30:00.000Z');
});

test('10:00-21:00 in 15-minute slots = 44 windows, contiguous', () => {
  const s = generateDaySlots('2026-10-01');
  assert.equal(s.length, 44);
  assert.equal(s[0].startsAt.toISOString(), '2026-10-01T04:30:00.000Z');
  assert.equal(s.at(-1).endsAt.toISOString(), '2026-10-01T15:30:00.000Z');
  for (let i = 1; i < s.length; i++) assert.equal(s[i].startsAt.getTime(), s[i - 1].endsAt.getTime());
});

// Minimal fake of prisma.slot.updateMany that evaluates the where-clause like Postgres would.
function fakeDb(slot) {
  const matches = (w, now) =>
    w.id === slot.id &&
    (w.isAvailable === undefined || slot.isAvailable === w.isAvailable) &&
    (!w.startsAt || slot.startsAt > w.startsAt.gt) &&
    (!w.OR || w.OR.some((c) =>
      ('heldUntil' in c && c.heldUntil === null && slot.heldUntil === null) ||
      (c.heldUntil?.lt && slot.heldUntil && slot.heldUntil < c.heldUntil.lt) ||
      ('heldByOrderId' in c && slot.heldByOrderId === c.heldByOrderId)));
  return {
    slot: {
      async updateMany({ where, data }) {
        if (!matches(where)) return { count: 0 };
        Object.assign(slot, data);
        return { count: 1 };
      },
    },
  };
}

test('second hold on a held slot fails with 409', async () => {
  const now = new Date('2026-10-01T03:00:00Z');
  const slot = { id: 1, isAvailable: true, heldUntil: null, heldByOrderId: null, startsAt: new Date('2026-10-01T04:30:00Z') };
  const db = fakeDb(slot);
  await holdSlot(db, 1, 101, { now });
  await assert.rejects(holdSlot(db, 1, 102, { now }), SlotUnavailableError);
});

test('expired hold can be taken; original payer then gets SLOT_LOST (false)', async () => {
  const t0 = new Date('2026-10-01T03:00:00Z');
  const t1 = new Date('2026-10-01T03:20:00Z'); // after 10 min hold
  const slot = { id: 1, isAvailable: true, heldUntil: null, heldByOrderId: null, startsAt: new Date('2026-10-01T04:30:00Z') };
  const db = fakeDb(slot);
  await holdSlot(db, 1, 101, { now: t0 });
  await holdSlot(db, 1, 102, { now: t1 });
  assert.equal(await bookSlot(db, 1, 101, { now: t1 }), false);
  assert.equal(await bookSlot(db, 1, 102, { now: t1 }), true);
  assert.equal(slot.isAvailable, false);
});

test('cannot hold a slot that already started', async () => {
  const slot = { id: 1, isAvailable: true, heldUntil: null, heldByOrderId: null, startsAt: new Date('2026-10-01T04:30:00Z') };
  await assert.rejects(holdSlot(fakeDb(slot), 1, 1, { now: new Date('2026-10-01T05:00:00Z') }), SlotUnavailableError);
});
