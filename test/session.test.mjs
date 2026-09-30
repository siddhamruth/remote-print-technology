import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, newToken, loadActiveSession, claimPrint } from '../src/session/print-session.js';

test('tokens are 256-bit and stored hashed', () => {
  const t = newToken();
  assert.equal(Buffer.from(t, 'base64url').length, 32);
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(t), t);
});

const row = (over = {}) => ({ id: 1, tokenHash: hashToken('tok'), opensAt: new Date('2026-10-01T04:30:00Z'), expiresAt: new Date('2026-10-01T04:45:00Z'), printClaimedAt: null, order: {}, ...over });
const db = (r) => ({
  printSession: {
    async findUnique({ where }) { return where.tokenHash === r.tokenHash ? r : null; },
    async updateMany({ where, data }) {
      if (r.printClaimedAt !== null || !(r.expiresAt > where.expiresAt.gt)) return { count: 0 };
      Object.assign(r, data); return { count: 1 };
    },
  },
});

test('session only usable inside its window', async () => {
  const r = row();
  await assert.rejects(loadActiveSession(db(r), 'tok', new Date('2026-10-01T04:00:00Z')), { status: 425 });
  await assert.rejects(loadActiveSession(db(r), 'tok', new Date('2026-10-01T05:00:00Z')), { status: 410 });
  await assert.rejects(loadActiveSession(db(r), 'nope', new Date('2026-10-01T04:35:00Z')), { status: 404 });
  assert.equal((await loadActiveSession(db(r), 'tok', new Date('2026-10-01T04:35:00Z'))).id, 1);
});

test('print can be claimed exactly once', async () => {
  const r = row(); const d = db(r); const now = new Date('2026-10-01T04:35:00Z');
  await claimPrint(d, 1, now);
  await assert.rejects(claimPrint(d, 1, now), { status: 409 });
});
