/**
 * Epson Connect API v2 client (printing).
 *
 * Flow for one print:
 *   1. createJob(settings)            -> { jobId, uploadUri }
 *   2. uploadFile(uploadUri, bytes)   -> file lands in Epson's cloud buffer (1 file per job, max 20 MB)
 *   3. print(jobId)                   -> printer pulls the file and prints
 *   4. getJob(jobId) until terminal   -> completed | error_occurred | canceled | expired | ...
 *
 * Auth: OAuth 2.0 authorization code grant with scope "device". The resulting
 * *device token* is bound to one printer. Every API call sends it as a Bearer
 * token together with the application's x-api-key.
 */

const DEFAULTS = {
  apiBase: 'https://api.epsonconnect.com/api/2',
  authUrl: 'https://auth.epsonconnect.com/auth/authorize',
  tokenUrl: 'https://auth.epsonconnect.com/auth/token',
};

/** Statuses after which a job will never progress on its own. */
export const TERMINAL_STATUSES = new Set(['completed', 'error_occurred', 'canceled', 'expired']);

/** Statuses that need a human at the printer (paper, ink, jam). The job stays alive. */
export const ATTENTION_STATUSES = new Set(['media_empty', 'media_jam', 'marker_supply_empty', 'stopped_other']);

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export class EpsonError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'EpsonError';
    this.status = status;
    this.code = code;
  }
}

export class EpsonConnectClient {
  /**
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {string} opts.clientSecret
   * @param {string} opts.apiKey
   * @param {string} opts.redirectUri
   * @param {{ get(): Promise<object|null>, set(tokens: object): Promise<void> }} opts.tokenStore
   * @param {string} [opts.expectedSerial]  If set, refuse device tokens for any other printer.
   * @param {typeof fetch} [opts.fetch]
   */
  constructor(opts) {
    for (const k of ['clientId', 'clientSecret', 'apiKey', 'redirectUri', 'tokenStore']) {
      if (!opts?.[k]) throw new Error(`EpsonConnectClient: missing ${k}`);
    }
    this.opts = { ...DEFAULTS, ...opts };
    this.fetch = opts.fetch || globalThis.fetch;
    this.refreshing = null;
  }

  // ---------- OAuth ----------

  /** Build the consent URL. `state` MUST be random and verified in the callback (CSRF). */
  authorizationUrl(state) {
    if (!state || state.length < 16) throw new Error('authorizationUrl: a random state (>=16 chars) is required');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      scope: 'device',
      state,
    });
    return `${this.opts.authUrl}?${params}`;
  }

  async exchangeCode(code) {
    const tokens = await this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.opts.redirectUri,
    });
    if (this.opts.expectedSerial) {
      const info = await this.#request('GET', '/printing/devices/info', { token: tokens.deviceToken });
      if (info?.serialNumber !== this.opts.expectedSerial) {
        throw new EpsonError('Authorized printer does not match EPSON_EXPECTED_SERIAL; token discarded', { status: 403 });
      }
    }
    await this.opts.tokenStore.set(tokens);
    return tokens;
  }

  async #tokenRequest(form) {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const res = await this.fetch(this.opts.tokenUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new EpsonError(`Epson token request failed: ${data.error || res.status}`, { status: 401, code: data.error });
    return {
      deviceToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
  }

  /** Returns a valid device token, refreshing 5 min before expiry. Concurrent callers share one refresh. */
  async deviceToken() {
    const t = await this.opts.tokenStore.get();
    if (!t?.deviceToken) throw new EpsonError('Printer not authorized', { status: 503 });
    if (Date.now() + 5 * 60_000 < t.expiresAt) return t.deviceToken;
    if (!this.refreshing) {
      this.refreshing = this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken })
        .then(async (next) => { await this.opts.tokenStore.set(next); return next.deviceToken; })
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  // ---------- Printing ----------

  async #request(method, path, { json, token } = {}) {
    const bearer = token || (await this.deviceToken());
    const res = await this.fetch(`${this.opts.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        'x-api-key': this.opts.apiKey,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new EpsonError(`Epson ${method} ${path} -> ${res.status} ${data.error || ''}`.trim(), { status: res.status, code: data.error });
    return data;
  }

  deviceInfo() {
    return this.#request('GET', '/printing/devices/info');
  }

  /** printMode: 'photo' | 'document'. printSettings keys follow Epson appendix (paperSize, paperType, borderless, ...). */
  async createJob({ jobName, printMode = 'photo', printSettings }) {
    const data = await this.#request('POST', '/printing/jobs', { json: { jobName, printMode, printSettings } });
    if (!data.jobId || !data.uploadUri) throw new EpsonError('Epson did not return jobId/uploadUri', { status: 502 });
    return { jobId: data.jobId, uploadUri: data.uploadUri };
  }

  /**
   * Upload one file to the job's upload URI. `body` may be a Buffer/Uint8Array or Blob.
   * Keep it in memory (<= 20 MB) — there is no need to ever write customer files to disk.
   * @param {string} uploadUri  Capability URL returned by createJob — treat as a secret.
   * @param {'jpg'|'jpeg'|'png'|'pdf'} ext
   */
  async uploadFile(uploadUri, body, { ext = 'jpg', contentType = 'image/jpeg' } = {}) {
    const size = body?.byteLength ?? body?.size;
    if (!size) throw new EpsonError('Empty upload', { status: 400 });
    if (size > MAX_UPLOAD_BYTES) throw new EpsonError('File exceeds 20 MB Epson limit', { status: 413 });
    const url = new URL(uploadUri);
    url.searchParams.set('File', `1.${ext}`);
    const res = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body });
    if (!res.ok) throw new EpsonError(`Epson upload failed: ${res.status}`, { status: res.status === 413 ? 413 : 502 });
  }

  print(jobId) {
    return this.#request('POST', `/printing/jobs/${encodeURIComponent(jobId)}/print`);
  }

  cancel(jobId) {
    return this.#request('POST', `/printing/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  getJob(jobId) {
    return this.#request('GET', `/printing/jobs/${encodeURIComponent(jobId)}`);
  }
}

/** Map an Epson job status to what the app should do. */
export function classifyJobStatus(status) {
  if (status === 'completed') return 'done';
  if (TERMINAL_STATUSES.has(status)) return 'failed';
  if (ATTENTION_STATUSES.has(status)) return 'needs_operator';
  return 'in_progress';
}

/** Print settings for common products on an EcoTank photo printer (e.g. L8050). */
export function printSettingsFor(product, finish = 'GLOSS') {
  const isDoc = product === 'A4_DOCUMENT';
  const isA4 = product === 'A4_PHOTO' || isDoc;
  return {
    printMode: isDoc ? 'document' : 'photo',
    printSettings: {
      paperSize: isA4 ? 'ps_a4' : 'ps_kg', // ps_kg = 4x6 in
      paperType: isDoc ? 'pt_plain' : finish === 'MATTE' ? 'pt_matte' : 'pt_photopaper',
      borderless: !isDoc,
      printQuality: 'high',
      paperSource: 'rear',
      colorMode: 'color',
      doubleSided: 'none',
      copies: 1,
    },
  };
}
