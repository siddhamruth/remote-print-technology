/**
 * Token stores for the Epson device token.
 * A device token lets its holder print to your printer — store it like a password.
 */

import fs from 'node:fs/promises';

/** File-backed store (single-server deployments). Written with mode 0600, atomically. */
export function fileTokenStore(filePath) {
  return {
    async get() {
      try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async set(tokens) {
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(tokens), { mode: 0o600 });
      await fs.rename(tmp, filePath);
    },
  };
}

/**
 * Prisma-backed store (multi-instance deployments). Expects the `PrinterCredential`
 * model from prisma/schema.prisma.
 */
export function prismaTokenStore(prisma, printerId = 'default') {
  return {
    async get() {
      const row = await prisma.printerCredential.findUnique({ where: { id: printerId } });
      return row ? { deviceToken: row.deviceToken, refreshToken: row.refreshToken, expiresAt: row.expiresAt.getTime() } : null;
    },
    async set(t) {
      const data = { deviceToken: t.deviceToken, refreshToken: t.refreshToken, expiresAt: new Date(t.expiresAt) };
      await prisma.printerCredential.upsert({ where: { id: printerId }, create: { id: printerId, ...data }, update: data });
    },
  };
}

/** In-memory store (tests). */
export function memoryTokenStore(initial = null) {
  let value = initial;
  return {
    async get() { return value; },
    async set(t) { value = t; },
  };
}
