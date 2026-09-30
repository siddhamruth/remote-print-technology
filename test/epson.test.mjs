import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EpsonConnectClient, classifyJobStatus, printSettingsFor } from '../src/epson/client.js';
import { memoryTokenStore } from '../src/epson/token-store.js';

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) throw new Error(`unexpected fetch ${u}`);
    const { status = 200, body = {} } = typeof routes[key] === 'function' ? routes[key](u, init) : routes[key];
    return new Response(status === 202 ? '' : JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

const base = { clientId: 'cid', clientSecret: 'sec', apiKey: 'key', redirectUri: 'https://x/cb' };

test('authorizationUrl requires a random state', () => {
  const c = new EpsonConnectClient({ ...base, tokenStore: memoryTokenStore() });
  assert.throws(() => c.authorizationUrl(''), /state/);
  const url = new URL(c.authorizationUrl('a'.repeat(32)));
  assert.equal(url.searchParams.get('scope'), 'device');
  assert.equal(url.searchParams.get('state'), 'a'.repeat(32));
});

test('full job flow sends bearer + api key and File=1.jpg', async () => {
  const fetch = mockFetch({
    '/printing/jobs/j1/print': { status: 202 },
    '/printing/jobs/j1': { body: { status: 'completed' } },
    '/printing/jobs': { body: { jobId: 'j1', uploadUri: 'https://upload.epsonconnect.com/data?Key=k' } },
    'upload.epsonconnect.com': { status: 200 },
  });
  const c = new EpsonConnectClient({ ...base, fetch, tokenStore: memoryTokenStore({ deviceToken: 'dt', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }) });
  const { printMode, printSettings } = printSettingsFor('SIX_BY_FOUR', 'MATTE');
  const { jobId, uploadUri } = await c.createJob({ jobName: 't', printMode, printSettings });
  await c.uploadFile(uploadUri, Buffer.from([0xff, 0xd8, 0xff]));
  await c.print(jobId);
  assert.equal((await c.getJob(jobId)).status, 'completed');

  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer dt');
  assert.equal(fetch.calls[0].init.headers['x-api-key'], 'key');
  assert.equal(JSON.parse(fetch.calls[0].init.body).printSettings.paperType, 'pt_matte');
  const up = new URL(fetch.calls[1].url);
  assert.equal(up.searchParams.get('File'), '1.jpg');
  assert.equal(up.searchParams.get('Key'), 'k');
});

test('upload failure throws instead of being swallowed', async () => {
  const fetch = mockFetch({ 'upload.epsonconnect.com': { status: 415 } });
  const c = new EpsonConnectClient({ ...base, fetch, tokenStore: memoryTokenStore() });
  await assert.rejects(c.uploadFile('https://upload.epsonconnect.com/data?Key=k', Buffer.from('x')), /upload failed/);
  await assert.rejects(c.uploadFile('https://upload.epsonconnect.com/data?Key=k', Buffer.alloc(0)), /Empty/);
});

test('expiring token is refreshed once for concurrent callers', async () => {
  let refreshes = 0;
  const fetch = mockFetch({
    '/auth/token': () => { refreshes++; return { body: { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 } }; },
  });
  const store = memoryTokenStore({ deviceToken: 'old', refreshToken: 'rt', expiresAt: Date.now() + 60_000 });
  const c = new EpsonConnectClient({ ...base, fetch, tokenStore: store });
  const [a, b] = await Promise.all([c.deviceToken(), c.deviceToken()]);
  assert.equal(a, 'new'); assert.equal(b, 'new'); assert.equal(refreshes, 1);
  assert.equal((await store.get()).refreshToken, 'rt2');
});

test('exchangeCode rejects a token for the wrong printer', async () => {
  const fetch = mockFetch({
    '/auth/token': { body: { access_token: 'attacker', refresh_token: 'r', expires_in: 3600 } },
    '/printing/devices/info': { body: { serialNumber: 'OTHER' } },
  });
  const store = memoryTokenStore();
  const c = new EpsonConnectClient({ ...base, fetch, tokenStore: store, expectedSerial: 'MINE' });
  await assert.rejects(c.exchangeCode('code'), /does not match/);
  assert.equal(await store.get(), null);
});

test('status classification', () => {
  assert.equal(classifyJobStatus('completed'), 'done');
  assert.equal(classifyJobStatus('error_occurred'), 'failed');
  assert.equal(classifyJobStatus('media_jam'), 'needs_operator');
  assert.equal(classifyJobStatus('processing'), 'in_progress');
});
