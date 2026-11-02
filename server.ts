// Plain Node server for the API: `node server.ts`. Reads .env, needs DATABASE_URL and the PayPal keys.
// Next.js can serve the same handler instead, from app/api/[...path]/route.ts.
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import pg from 'pg';
import { createHandler } from './lib/api.ts';
import { fromPgPool } from './lib/db.ts';
import { createPaypal } from './lib/paypal.ts';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
for (const k of ['DATABASE_URL', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'APP_URL']) {
  if (!process.env[k]) throw new Error(`${k} is not set`);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
// First start on an empty database (a fresh Render Postgres): create the tables.
const { rows } = await pool.query(`SELECT to_regclass('public.jobs') AS t`);
if (!rows[0].t) {
  await pool.query(readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8'));
  console.log('Created tables from db/schema.sql');
}
const handle = createHandler({
  db: fromPgPool(pool),
  paypal: createPaypal({ clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET! }),
  appUrl: process.env.APP_URL!.replace(/\/$/, ''),
  webhookId: process.env.PAYPAL_WEBHOOK_ID || null,
});

const port = Number(process.env.PORT ?? 3001);
createServer(async (req, res) => {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(new URL(req.url ?? '/', process.env.APP_URL), {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // @ts-expect-error Node needs this for streamed request bodies
    duplex: 'half',
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`Receipts API on :${port}`));
