// Wiring shared by the example route handlers.
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { EpsonConnectClient } from '../../../src/epson/client.js';
import { prismaTokenStore } from '../../../src/epson/token-store.js';
import { cashfreeConfig } from '../../../src/payments/cashfree.js';

const g = globalThis;
export const prisma = g.__prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
if (process.env.NODE_ENV !== 'production') g.__prisma = prisma;

export const epson = new EpsonConnectClient({
  clientId: process.env.EPSON_CLIENT_ID,
  clientSecret: process.env.EPSON_CLIENT_SECRET,
  apiKey: process.env.EPSON_API_KEY,
  redirectUri: process.env.EPSON_REDIRECT_URI,
  expectedSerial: process.env.EPSON_EXPECTED_SERIAL,
  tokenStore: prismaTokenStore(prisma),
});

export const cashfree = () => cashfreeConfig();

/** Admin guard: constant-time compare against ADMIN_SECRET. Replace with real admin auth if you have it. */
export function isAdminSecret(value) {
  const given = Buffer.from(value || '');
  const want = Buffer.from(process.env.ADMIN_SECRET || '');
  return want.length >= 32 && given.length === want.length && crypto.timingSafeEqual(given, want);
}

export function json(body, status = 200) {
  return Response.json(body, { status });
}

export function errorResponse(err) {
  const status = err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  return json({ error: status >= 500 ? 'Internal error' : err.message }, status);
}
