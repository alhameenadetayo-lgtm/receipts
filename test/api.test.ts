// Route tests against a real Postgres schema (PGlite, in-process) and a fake PayPal.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../lib/api.ts';
import { fromPglite } from '../lib/db.ts';
import { PaypalError, type Paypal } from '../lib/paypal.ts';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const APP = 'https://receipts.test';

type Call = { method: string; path: string; body?: any; requestId?: string };

// Fake PayPal: just enough state to follow one order through authorize, capture and void.
function fakePaypal() {
  const calls: Call[] = [];
  const orders = new Map<string, { customId: string; amount: string; approved: boolean }>();
  const auths = new Map<string, any>();
  const captures = new Map<string, any>();
  const disputes = new Map<string, any>();
  let n = 0;
  let verify = 'SUCCESS';
  const paypal: Paypal = {
    async call(method, path, body: any, requestId) {
      calls.push({ method, path, body, requestId });
      let m;
      if (method === 'POST' && path === '/v2/checkout/orders') {
        const id = `ORDER${++n}`;
        orders.set(id, { customId: body.purchase_units[0].custom_id, amount: body.purchase_units[0].amount.value, approved: false });
        return { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
      }
      if ((m = path.match(/^\/v2\/checkout\/orders\/(\w+)\/authorize$/))) {
        const o = orders.get(m[1])!;
        if (!o.approved) throw new PaypalError(422, 'ORDER_NOT_APPROVED', 'dbg', 'not approved');
        const now = Date.now();
        const a = { id: `AUTH${++n}`, status: 'CREATED', custom_id: o.customId, amount: { value: o.amount },
          create_time: new Date(now).toISOString(), expiration_time: new Date(now + 29 * 86_400_000).toISOString() };
        auths.set(a.id, a);
        return { id: m[1], purchase_units: [{ payments: { authorizations: [a] } }] };
      }
      if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)\/capture$/))) {
        const a = auths.get(m[1])!;
        a.status = 'CAPTURED';
        const c = { id: `CAP${++n}`, status: 'COMPLETED', custom_id: a.custom_id,
          supplementary_data: { related_ids: { authorization_id: a.id } },
          seller_receivable_breakdown: { gross_amount: { value: a.amount.value }, paypal_fee: { value: '0.62' }, net_amount: { value: '10.38' } } };
        captures.set(c.id, c);
        return c;
      }
      if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)\/void$/))) {
        auths.get(m[1])!.status = 'VOIDED';
        return {};
      }
      if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)$/))) return auths.get(m[1]);
      if ((m = path.match(/^\/v2\/payments\/captures\/(\w+)$/))) return captures.get(m[1]);
      if ((m = path.match(/^\/v1\/customer\/disputes\/([\w-]+)$/))) return disputes.get(m[1]);
      throw new Error(`fake PayPal has no ${method} ${path}`);
    },
    async postRaw(path) {
      calls.push({ method: 'POST', path });
      return { verification_status: verify };
    },
  };
  return {
    paypal, calls, orders, captures, disputes,
    approve: (orderId: string) => { orders.get(orderId)!.approved = true; },
    setVerify: (v: string) => { verify = v; },
  };
}

let handle: (r: Request) => Promise<Response>;
let pp: ReturnType<typeof fakePaypal>;
let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  pp = fakePaypal();
  handle = createHandler({ db: fromPglite(db), paypal: pp.paypal, appUrl: APP, webhookId: 'WH-TEST' });
});

async function call(method: string, path: string, opts: { key?: string; json?: unknown; form?: FormData; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers['content-type'] = 'application/json'; }
  if (opts.form) body = opts.form;
  if (opts.raw !== undefined) body = opts.raw;
  const res = await handle(new Request(`${APP}${path}`, { method, headers, body }));
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), body: text ? JSON.parse(text) : null };
}

async function newJob(amount = '11.00') {
  const r = await call('POST', '/api/jobs', { json: {
    title: 'Logo for Ada Bakery', clientName: 'Ada', clientEmail: 'ada@example.com',
    milestones: [{ title: 'Logo concepts', amount, criteria: ['Three concepts', 'Vector files'] }],
  } });
  assert.equal(r.status, 201);
  return { job: r.body.job, ms: r.body.milestones[0], fk: r.body.freelancerKey as string, ck: r.body.clientKey as string };
}

async function reserved(amount = '11.00') {
  const j = await newJob(amount);
  const pay = await call('POST', `/api/milestones/${j.ms.id}/request-payment`, { key: j.fk });
  const orderId = new URL(pay.body.approveUrl).searchParams.get('token')!;
  pp.approve(orderId);
  const back = await call('GET', `/api/paypal/return?token=${orderId}`);
  assert.equal(back.status, 303);
  return { ...j, orderId };
}

async function upload(msId: string, key: string, content = 'final logo') {
  const form = new FormData();
  form.set('file', new File([content], 'logo.svg', { type: 'image/svg+xml' }));
  form.set('criterionId', 'c1');
  return call('POST', `/api/milestones/${msId}/files`, { key, form });
}

test('create job hands out keys once and stores only hashes', async () => {
  const j = await newJob();
  assert.equal(j.ms.status, 'draft');
  assert.deepEqual(j.ms.criteria.map((c: any) => c.id), ['c1', 'c2']);
  const { rows } = await db.query<any>('SELECT freelancer_key_hash FROM jobs');
  assert.notEqual(rows[0].freelancer_key_hash, j.fk);
  assert.equal(rows[0].freelancer_key_hash.length, 64);
});

test('bad input is refused', async () => {
  const r = await call('POST', '/api/jobs', { json: { title: 'x', clientName: 'y', clientEmail: 'y@example.com',
    milestones: [{ title: 't', amount: '11', criteria: ['c'] }] } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /200\.00/);
});

test('keys are checked: none, wrong job, wrong role', async () => {
  const a = await newJob();
  const b = await newJob();
  assert.equal((await call('GET', `/api/jobs/${a.job.id}`)).status, 401);
  assert.equal((await call('GET', `/api/jobs/${a.job.id}`, { key: b.fk })).status, 403);
  assert.equal((await call('POST', `/api/milestones/${a.ms.id}/request-payment`, { key: a.ck })).status, 403);
  assert.equal((await call('GET', `/api/jobs/${a.job.id}`, { key: a.ck })).status, 200);
});

test('request payment is idempotent and uses a fixed PayPal request id', async () => {
  const j = await newJob();
  const one = await call('POST', `/api/milestones/${j.ms.id}/request-payment`, { key: j.fk });
  const two = await call('POST', `/api/milestones/${j.ms.id}/request-payment`, { key: j.fk });
  assert.equal(one.body.approveUrl, two.body.approveUrl);
  const creates = pp.calls.filter((c) => c.path === '/v2/checkout/orders');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].requestId, `order-${j.ms.id}`);
  assert.equal(creates[0].body.intent, 'AUTHORIZE');
});

test('return before approval does not reserve', async () => {
  const j = await newJob();
  const pay = await call('POST', `/api/milestones/${j.ms.id}/request-payment`, { key: j.fk });
  const orderId = new URL(pay.body.approveUrl).searchParams.get('token')!;
  const back = await call('GET', `/api/paypal/return?token=${orderId}`);
  assert.match(back.location!, /payment=not_approved/);
  const view = await call('GET', `/api/jobs/${j.job.id}`, { key: j.fk });
  assert.equal(view.body.milestones[0].status, 'awaiting_payment');
});

test('full path: reserve, deliver, accept, capture', async () => {
  const j = await reserved();
  let view = (await call('GET', `/api/jobs/${j.job.id}`, { key: j.ck })).body.milestones[0];
  assert.equal(view.status, 'reserved');
  assert.ok(view.reservedUntil);

  assert.equal((await call('POST', `/api/milestones/${j.ms.id}/accept`, { key: j.ck, json: { by: 'client' } })).status, 409, 'nothing delivered yet');
  const up = await upload(j.ms.id, j.fk);
  assert.equal(up.status, 201);
  assert.equal(up.body.sha256.length, 64);

  const acc = await call('POST', `/api/milestones/${j.ms.id}/accept`, { key: j.ck, json: { by: 'client' } });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.status, 'captured');
  assert.equal(acc.body.capture.fee, '0.62');
  assert.equal(acc.body.accepted.by, 'client');

  const again = await call('POST', `/api/milestones/${j.ms.id}/accept`, { key: j.ck, json: { by: 'client' } });
  assert.equal(again.status, 200);
  assert.equal(pp.calls.filter((c) => c.path.endsWith('/capture')).length, 1, 'captured once');

  const late = await upload(j.ms.id, j.fk, 'sneaky change');
  assert.equal(late.status, 409, 'no new files after acceptance');

  const { rows } = await db.query<any>('SELECT file_hashes FROM acceptances');
  assert.deepEqual(rows[0].file_hashes, [up.body.sha256]);
});

test('client agent: within mandate accepts, over the cap is refused and logged', async () => {
  const j = await reserved('11.00');
  await upload(j.ms.id, j.fk);
  const small = await call('POST', `/api/jobs/${j.job.id}/mandates`, { key: j.ck, json: { maxAmount: '10.00', days: 7 } });
  assert.equal(small.status, 201);
  const refused = await call('POST', `/api/milestones/${j.ms.id}/accept`, { key: small.body.agentKey, json: { by: 'client_agent', mandateId: small.body.mandateId } });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /over the mandate cap/);

  const big = await call('POST', `/api/jobs/${j.job.id}/mandates`, { key: j.ck, json: { maxAmount: '50.00', days: 7 } });
  const wrongKey = await call('POST', `/api/milestones/${j.ms.id}/accept`, { key: small.body.agentKey, json: { by: 'client_agent', mandateId: big.body.mandateId } });
  assert.equal(wrongKey.status, 403);
  const ok = await call('POST', `/api/milestones/${j.ms.id}/accept`, { key: big.body.agentKey, json: { by: 'client_agent', mandateId: big.body.mandateId } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.accepted.by, 'client_agent');

  const auditRows = (await call('GET', `/api/audit?milestoneId=${j.ms.id}`, { key: j.fk })).body.rows;
  assert.ok(auditRows.some((r: any) => r.action === 'accept refused' && r.decision === 'deny'));
});

test('freelancer can void a reservation before acceptance', async () => {
  const j = await reserved();
  const v = await call('POST', `/api/milestones/${j.ms.id}/void`, { key: j.fk });
  assert.equal(v.status, 200);
  assert.equal(v.body.status, 'voided');
  assert.equal((await call('POST', `/api/milestones/${j.ms.id}/accept`, { key: j.ck, json: { by: 'client' } })).status, 409);
});

const sigHeaders = {
  'content-type': 'application/json',
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 't-1',
  'paypal-transmission-sig': 'sig==',
  'paypal-transmission-time': '2026-11-01T10:00:00Z',
};

test('webhook: dispute event re-reads PayPal, moves to disputed, duplicates ignored', async () => {
  const j = await reserved();
  await upload(j.ms.id, j.fk);
  const acc = await call('POST', `/api/milestones/${j.ms.id}/accept`, { key: j.ck, json: { by: 'client' } });
  pp.disputes.set('PP-R-TEST-1', {
    dispute_id: 'PP-R-TEST-1', status: 'UNDER_REVIEW', dispute_life_cycle_stage: 'INQUIRY',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    disputed_transactions: [{ seller_transaction_id: acc.body.capture.id }],
    links: [{ rel: 'self' }, { rel: 'provide_evidence' }],
  });
  // The body claims RESOLVED; PayPal's own record says UNDER_REVIEW, and that is what counts.
  const raw = JSON.stringify({ id: 'WH-EVT-1', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'x', id: 'PP-R-TEST-1', status: 'RESOLVED' } });
  const first = await call('POST', '/api/paypal/webhook', { raw, headers: sigHeaders });
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, 'applied');
  const dup = await call('POST', '/api/paypal/webhook', { raw, headers: sigHeaders });
  assert.equal(dup.body.outcome, 'duplicate');

  const view = (await call('GET', `/api/jobs/${j.job.id}`, { key: j.fk })).body.milestones[0];
  assert.equal(view.status, 'disputed');
  assert.deepEqual(view.dispute, { id: 'PP-R-TEST-1', status: 'UNDER_REVIEW', responseDue: null, canProvideEvidence: true });

  const ledger = await call('GET', `/api/ledger?jobId=${j.job.id}`, { key: j.fk });
  assert.equal(ledger.body.rows[0].disputeId, 'PP-R-TEST-1');
  assert.equal(ledger.body.rows[0].net, '10.38');
});

test('webhook: unverified events are refused and cannot squat a real event id', async () => {
  const j = await reserved();
  pp.setVerify('FAILURE');
  const raw = JSON.stringify({ id: 'WH-EVT-2', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: 'AUTH1' } });
  const forged = await call('POST', '/api/paypal/webhook', { raw, headers: sigHeaders });
  assert.equal(forged.status, 401);
  const view = (await call('GET', `/api/jobs/${j.job.id}`, { key: j.fk })).body.milestones[0];
  assert.equal(view.status, 'reserved');
  const { rows } = await db.query<any>("SELECT count(*)::int AS n FROM webhook_events WHERE event_id = 'WH-EVT-2'");
  assert.equal(rows[0].n, 0);
});

test('webhook without a configured id is refused', async () => {
  const h = createHandler({ db: fromPglite(db), paypal: pp.paypal, appUrl: APP, webhookId: null });
  const res = await h(new Request(`${APP}/api/paypal/webhook`, { method: 'POST', headers: sigHeaders, body: '{}' }));
  assert.equal(res.status, 503);
});
