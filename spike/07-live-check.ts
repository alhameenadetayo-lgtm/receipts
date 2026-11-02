// Live check of lib/api.ts against the PayPal sandbox with an in-process database. Moves no money:
// it creates one order (unpaid) and reads back the capture and dispute from the 1 Nov spike.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../lib/api.ts';
import { fromPglite } from '../lib/db.ts';
import { createPaypal } from '../lib/paypal.ts';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m![1], m![2]]));
const paypal = createPaypal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
const db = new PGlite();
await db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const handle = createHandler({ db: fromPglite(db), paypal, appUrl: 'https://receipts.example', webhookId: null });
const req = (method: string, path: string, key?: string, json?: unknown) => handle(new Request(`https://receipts.example${path}`, {
  method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
  body: json === undefined ? undefined : JSON.stringify(json) }));

const job = await (await req('POST', '/api/jobs', undefined, { title: 'Live check', clientName: 'Demo client', clientEmail: 'client@example.com',
  milestones: [{ title: 'Logo concepts', amount: '12.00', criteria: ['Three concepts'] }] })).json();
const pay = await req('POST', `/api/milestones/${job.milestones[0].id}/request-payment`, job.freelancerKey);
const payBody = await pay.json();
console.log('request-payment:', pay.status, payBody.approveUrl ? 'approve link OK' : payBody);
const order = await paypal.call('GET', `/v2/checkout/orders/${new URL(payBody.approveUrl).searchParams.get('token')}`);
console.log('order:', order.status, order.intent, 'custom_id matches:', order.purchase_units[0].custom_id === job.milestones[0].id);

const cap = await paypal.call('GET', '/v2/payments/captures/0DX395994R8541317');
console.log('capture:', cap.status, 'custom_id present:', !!cap.custom_id, 'authorization_id present:', !!cap.supplementary_data?.related_ids?.authorization_id);
const dp = await paypal.call('GET', '/v1/customer/disputes/PP-R-VAT-10195780');
console.log('dispute:', dp.status, dp.dispute_life_cycle_stage, 'seller_transaction_id matches capture:',
  dp.disputed_transactions?.[0]?.seller_transaction_id === '0DX395994R8541317',
  'provide_evidence:', (dp.links ?? []).some((l: any) => l.rel === 'provide_evidence'));
