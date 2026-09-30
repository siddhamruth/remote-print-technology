import crypto from 'node:crypto';
import { epson, json } from '../../../../lib/services.js';

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const cookie = /(?:^|;\s*)epson_oauth_state=([^;]+)/.exec(req.headers.get('cookie') || '')?.[1] || '';

  const ok = state.length > 0 && state.length === cookie.length &&
    crypto.timingSafeEqual(Buffer.from(state), Buffer.from(cookie));
  if (!ok || !code) return json({ error: 'Invalid OAuth state' }, 400); // never echo query params into HTML

  try {
    await epson.exchangeCode(code); // also checks EPSON_EXPECTED_SERIAL when set
    return json({ authorized: true });
  } catch (err) {
    return json({ error: err.message }, err.status || 502);
  }
}
