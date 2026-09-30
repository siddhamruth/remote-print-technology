import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyWebhook, paymentOutcome } from '../src/payments/cashfree.js';

const SECRET = 'test_secret';
const sign = (ts, body) => crypto.createHmac('sha256', SECRET).update(`${ts}${body}`).digest('base64');

test('valid webhook signature is accepted', () => {
  const ts = String(Date.now());
  const body = '{"data":{"order":{"order_id":"o1"}}}';
  assert.equal(verifyWebhook(SECRET, body, sign(ts, body), ts), true);
});

test('missing headers are rejected, not skipped', () => {
  assert.equal(verifyWebhook(SECRET, '{}', null, null), false);
  assert.equal(verifyWebhook(SECRET, '{}', 'x', null), false);
});

test('tampered body is rejected', () => {
  const ts = String(Date.now());
  assert.equal(verifyWebhook(SECRET, '{"a":2}', sign(ts, '{"a":1}'), ts), false);
});

test('stale timestamp (replay) is rejected', () => {
  const ts = String(Date.now() - 10 * 60_000);
  assert.equal(verifyWebhook(SECRET, '{}', sign(ts, '{}'), ts), false);
});

test('garbage signature does not throw', () => {
  const ts = String(Date.now());
  assert.equal(verifyWebhook(SECRET, '{}', '!!!not-base64', ts), false);
});

test('paymentOutcome: PAID with matching amount', () => {
  assert.equal(paymentOutcome({ order_status: 'PAID', order_amount: 110, order_currency: 'INR' }, 11000), 'PAID');
});

test('paymentOutcome: amount mismatch throws', () => {
  assert.throws(() => paymentOutcome({ order_status: 'PAID', order_amount: 1, order_currency: 'INR' }, 11000), /mismatch/);
});

test('paymentOutcome: ACTIVE stays pending (do not release slot mid-checkout)', () => {
  assert.equal(paymentOutcome({ order_status: 'ACTIVE' }, 100), 'PENDING');
  assert.equal(paymentOutcome({ order_status: 'EXPIRED' }, 100), 'FAILED');
});
