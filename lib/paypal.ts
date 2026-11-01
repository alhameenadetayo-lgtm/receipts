// PayPal REST client for the backend. fetch is injected so tests run without PayPal.

export type PaypalConfig = {
  clientId: string;
  clientSecret: string;
  base?: string; // default sandbox
};

export class PaypalError extends Error {
  status: number;
  issue: string;
  debugId: string | null;
  constructor(status: number, issue: string, debugId: string | null, message: string) {
    super(message);
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
  }
}

export type Paypal = {
  call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<T>;
  // Raw-body POST, used only for webhook signature verification.
  postRaw<T = any>(path: string, body: string): Promise<T>;
};

export function createPaypal(cfg: PaypalConfig, fetchFn: typeof fetch = fetch): Paypal {
  const base = cfg.base ?? 'https://api-m.sandbox.paypal.com';
  let cached: { value: string; expires: number } | null = null;

  async function token(): Promise<string> {
    if (cached && cached.expires > Date.now() + 60_000) return cached.value;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const res = await fetchFn(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json();
    if (!res.ok) throw new PaypalError(res.status, body.error ?? 'TOKEN', null, 'PayPal token request failed');
    cached = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return cached.value;
  }

  async function send(method: string, path: string, body: string | undefined, requestId?: string) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    // Same request id = PayPal returns the first result instead of acting twice.
    if (method !== 'GET' && requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetchFn(`${base}${path}`, { method, headers, body });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const issue = data.details?.[0]?.issue ?? data.name ?? 'UNKNOWN';
      const debugId = data.debug_id ?? res.headers.get('paypal-debug-id');
      throw new PaypalError(res.status, issue, debugId, `${method} ${path} failed (${res.status}) ${issue} debug_id=${debugId}`);
    }
    return data;
  }

  return {
    call: (method, path, body, requestId) => send(method, path, body === undefined ? undefined : JSON.stringify(body), requestId),
    postRaw: (path, body) => send('POST', path, body),
  };
}
