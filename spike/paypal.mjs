// Tiny PayPal sandbox client for the Phase 1 spike. No dependencies; Node 18+.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = 'https://api-m.sandbox.paypal.com';

function loadEnv() {
  const path = new URL('../.env', import.meta.url);
  if (!existsSync(path)) throw new Error('Missing .env. Copy .env.example to .env and fill it in.');
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) {
    if (!process.env[k]) throw new Error(`${k} is empty in .env`);
  }
}
loadEnv();

let cached;
export async function token() {
  if (cached && cached.expires > Date.now() + 60_000) return cached;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${body.error_description || body.error}`);
  cached = { value: body.access_token, scope: body.scope, expires: Date.now() + body.expires_in * 1000 };
  return cached;
}

// requestId makes POSTs idempotent: PayPal returns the first result for a repeated id.
export async function api(method, path, body, { requestId } = {}) {
  const t = await token();
  const headers = { Authorization: `Bearer ${t.value}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (method !== 'GET') headers['PayPal-Request-Id'] = requestId || randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = (data.details || []).map((d) => d.issue).join(', ');
    throw new Error(`${method} ${path} failed (${res.status}) ${data.name || ''} ${detail} debug_id=${data.debug_id || res.headers.get('paypal-debug-id')}`);
  }
  return data;
}

export function arg(i, name) {
  const v = process.argv[2 + i];
  if (!v) {
    console.error(`Usage: node ${process.argv[1].split(/[\\/]/).pop()} <${name}>`);
    process.exit(1);
  }
  return v;
}
