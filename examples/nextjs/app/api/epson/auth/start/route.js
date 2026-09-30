// Admin-only: bind YOUR printer via OAuth. Left unprotected, anyone could bind THEIR
// printer and receive your customers' files.
// GET  -> tiny password form (so the secret goes in a POST body, never a URL)
// POST -> checks ADMIN_SECRET, sets a state cookie, 303-redirects to Epson's consent page
import crypto from 'node:crypto';
import { epson, isAdminSecret } from '../../../../../lib/services.js';

export function GET() {
  return new Response(
    '<!doctype html><meta name="viewport" content="width=device-width"><form method="post">' +
      '<input type="password" name="secret" placeholder="Admin secret" autofocus required> <button>Authorize printer</button></form>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req) {
  const form = await req.formData();
  if (!isAdminSecret(String(form.get('secret') || ''))) return new Response('Unauthorized', { status: 401 });
  const state = crypto.randomBytes(24).toString('base64url');
  return new Response(null, {
    status: 303,
    headers: {
      Location: epson.authorizationUrl(state),
      'Set-Cookie': `epson_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/epson; Max-Age=600`,
    },
  });
}
