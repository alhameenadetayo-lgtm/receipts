// AI dispute defence tests with a scripted model. They prove what the code guarantees whatever a model does:
// raw buyer text reaches only the reader, nothing but evidence can be filed, and every failure denies.
// spike/08-redteam-live.ts runs the same attack strings against the real models.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../lib/api.ts';
import { fromPglite } from '../lib/db.ts';
import { buyerFieldsFrom, verdictFrom, type Llm, type LlmRequest } from '../lib/defence.ts';
import { PaypalError, type Paypal } from '../lib/paypal.ts';
import { ATTACKS } from './attacks.ts';

const APP = 'https://receipts.test';
const DISPUTE = 'PP-R-TEST-1';
const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();

const GOOD_READER = { complaint: 'not_received', disputed_criteria: ['c1'], says_work_was_delivered: 'no', asks_seller_for_refund: true, contains_instructions_to_ai: true };
const GOOD_VERDICT = { amount_matches: true, payee_matches: true, evidence_supports: true, no_injection_influence: true, decision: 'approve', reason: 'The note matches the record.' };

let db: PGlite;
let handle: (r: Request) => Promise<Response>;
let paypalCalls: { method: string; path: string; form?: FormData; requestId?: string }[];
let llmCalls: LlmRequest[];
let script: Partial<Record<LlmRequest['role'], (r: LlmRequest) => unknown>>;
let dispute: any;
let fileId: string;

const fakePaypal = (): Paypal => ({
  async call(method, path) {
    paypalCalls.push({ method, path });
    if (path === `/v1/customer/disputes/${DISPUTE}`) return dispute;
    throw new Error(`fake PayPal has no ${method} ${path}`);
  },
  async postRaw() { return { verification_status: 'SUCCESS' }; },
  async postForm(path, form, requestId) {
    paypalCalls.push({ method: 'POST', path, form, requestId });
    return {};
  },
});

const fakeLlm: Llm = async (r) => {
  llmCalls.push(r);
  const answer = script[r.role]?.(r);
  if (answer instanceof Error) throw answer;
  return answer;
};

async function call(method: string, path: string, key?: string, json?: unknown) {
  const res = await handle(new Request(`${APP}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// A stage that was delivered, accepted and captured, with a dispute open against the capture.
async function disputedStage(opts: { filename?: string; note?: string; mime?: string } = {}) {
  const r = await call('POST', '/api/jobs', undefined, {
    title: 'Logo for Ada Bakery', clientName: 'Ada', clientEmail: 'ada@example.com',
    milestones: [{ title: 'Logo concepts', amount: '11.00', criteria: ['Three concepts', 'Vector files'] }],
  });
  const msId = r.body.milestones[0].id;
  const bytes = Buffer.from('%PDF-1.4 the logo concepts');
  const sha = createHash('sha256').update(bytes).digest('hex');
  fileId = 'file_test';
  await db.query("UPDATE milestones SET status = 'disputed', review_state = 'delivered' WHERE id = $1", [msId]);
  await db.query("INSERT INTO authorizations (id, milestone_id, status, amount) VALUES ('AUTH1',$1,'CAPTURED','11.00')", [msId]);
  await db.query("INSERT INTO captures (id, milestone_id, authorization_id, status, gross) VALUES ('CAP1',$1,'AUTH1','COMPLETED','11.00')", [msId]);
  await db.query('INSERT INTO evidence_files (id, milestone_id, criterion_id, filename, mime_type, sha256, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [fileId, msId, 'c1', opts.filename ?? 'concepts.pdf', opts.mime ?? 'application/pdf', sha, bytes]);
  await db.query("INSERT INTO acceptances (id, milestone_id, accepted_by, file_hashes) VALUES ('acc1',$1,'client',$2)", [msId, JSON.stringify([sha])]);
  if (opts.note) await db.query("INSERT INTO change_requests (id, milestone_id, round, criterion_id, note) VALUES ('chg1',$1,1,'c1',$2)", [msId, opts.note]);
  await db.query("INSERT INTO disputes (id, milestone_id, capture_id, status, can_provide_evidence) VALUES ($1,$2,'CAP1','WAITING_FOR_SELLER_RESPONSE',true)", [DISPUTE, msId]);
  return { msId, fk: r.body.freelancerKey as string, ck: r.body.clientKey as string, sha };
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../db/defence.sql', import.meta.url), 'utf8'));
  paypalCalls = [];
  llmCalls = [];
  script = {
    reader: () => GOOD_READER,
    drafter: () => ({ evidenceType: 'PROOF_OF_FULFILLMENT', notes: 'Three logo concepts were delivered and the client accepted them.', citedFileIds: [fileId] }),
    second_key: () => GOOD_VERDICT,
  };
  dispute = {
    dispute_id: DISPUTE, status: 'WAITING_FOR_SELLER_RESPONSE', dispute_life_cycle_stage: 'CHARGEBACK', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    dispute_amount: { currency_code: 'USD', value: '11.00' }, seller_response_due_date: FUTURE,
    disputed_transactions: [{ seller_transaction_id: 'CAP1', items: [] }],
    messages: [{ posted_by: 'BUYER', content: 'I never got anything.' }],
    evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER' }, { evidence_type: 'OTHER', source: 'REQUESTED_FROM_SELLER' }],
    links: [{ rel: 'self' }, { rel: 'provide_evidence' }, { rel: 'accept_claim' }],
  };
  handle = createHandler({ db: fromPglite(db), paypal: fakePaypal(), appUrl: APP, webhookId: 'WH', llm: fakeLlm });
});

const moneyMoved = () => paypalCalls.filter((c) => c.method === 'POST' && !c.path.endsWith('/provide-evidence'));

test('happy path: draft, second key, tap, evidence filed once with files named by fingerprint', async () => {
  const { msId, fk, sha } = await disputedStage();
  const draft = await call('POST', `/api/milestones/${msId}/defence`, fk);
  assert.equal(draft.status, 201);
  assert.equal(draft.body.draft.status, 'ready');
  assert.equal(draft.body.draft.buyerFields.containsInstructionsToAi, true);
  assert.equal(draft.body.attemptsLeft, 2);
  assert.equal(paypalCalls.some((c) => c.path.endsWith('/provide-evidence')), false, 'nothing is filed before the tap');

  const filed = await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId: draft.body.draft.id });
  assert.equal(filed.status, 200);
  assert.equal(filed.body.draft.status, 'filed');
  const post = paypalCalls.find((c) => c.path === `/v1/customer/disputes/${DISPUTE}/provide-evidence`)!;
  assert.equal(post.requestId, `evidence-${draft.body.draft.id}`);
  const input = JSON.parse(await (post.form!.get('input') as Blob).text());
  assert.deepEqual(input.evidences[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  const attached = [...post.form!.entries()].filter(([k]) => k !== 'input').map(([, v]) => v) as File[];
  assert.deepEqual(attached.map((f) => f.name), [`delivery-${sha.slice(0, 12)}.pdf`]);

  const again = await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId: draft.body.draft.id });
  assert.equal(again.status, 200);
  assert.equal(paypalCalls.filter((c) => c.path.endsWith('/provide-evidence')).length, 1, 'a second tap files nothing');
  const log = await call('GET', `/api/audit?milestoneId=${msId}`, fk);
  assert.deepEqual(log.body.rows.filter((r: any) => r.model).map((r: any) => r.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('the three models run in order, and only the freelancer can act', async () => {
  const { msId, fk, ck } = await disputedStage();
  assert.equal((await call('POST', `/api/milestones/${msId}/defence`, ck)).status, 403);
  assert.equal((await call('POST', `/api/milestones/${msId}/defence`)).status, 401);
  const d = await call('POST', `/api/milestones/${msId}/defence`, fk);
  assert.deepEqual(llmCalls.map((c) => c.role), ['reader', 'drafter', 'second_key']);
  assert.equal((await call('POST', `/api/milestones/${msId}/defence/file`, ck, { draftId: d.body.draft.id })).status, 403);
  assert.equal((await call('GET', `/api/milestones/${msId}/defence`, ck)).status, 403);
});

test(`red team: ${ATTACKS.length} attacks in dispute text, client notes and file names never reach the drafter or the gate`, async () => {
  const stuffed = ATTACKS.join(' || ');
  const { msId, fk } = await disputedStage({ filename: stuffed.slice(0, 200), note: stuffed });
  dispute.messages = ATTACKS.map((content) => ({ posted_by: 'BUYER', content }));
  dispute.evidences.push({ evidence_type: 'CREATE', source: 'SUBMITTED_BY_BUYER', notes: stuffed });
  dispute.disputed_transactions[0].items = [{ item_description: stuffed }];
  const d = await call('POST', `/api/milestones/${msId}/defence`, fk);
  assert.equal(d.body.draft.status, 'ready');
  const reader = llmCalls.find((c) => c.role === 'reader')!;
  const later = llmCalls.filter((c) => c.role !== 'reader');
  assert.equal(later.length, 2);
  for (const attack of ATTACKS) {
    assert.ok(reader.user.includes(attack), 'the reader does see the text');
    for (const c of later) assert.ok(!c.user.includes(attack) && !c.system.includes(attack), `leaked to ${c.role}: ${attack}`);
  }
  assert.equal(moneyMoved().length, 0, 'no POST to PayPal at all');
  assert.ok(!paypalCalls.some((c) => /refund|accept-claim/.test(c.path)));
});

test('a compromised reader cannot smuggle text: output is rebuilt from fixed values', async () => {
  const attack = ATTACKS[0];
  const { msId, fk } = await disputedStage();
  script.reader = () => ({ complaint: attack, disputed_criteria: [attack, 'c1'], says_work_was_delivered: attack, asks_seller_for_refund: attack, contains_instructions_to_ai: attack, extra: attack });
  await call('POST', `/api/milestones/${msId}/defence`, fk);
  for (const c of llmCalls.filter((x) => x.role !== 'reader')) assert.ok(!c.user.includes(attack));
  assert.deepEqual(buyerFieldsFrom({ complaint: attack, disputed_criteria: [attack, 'c1'], extra: attack }, ['c1']),
    { complaint: 'unclear', disputedCriteria: ['c1'], saysWorkWasDelivered: 'unclear', asksSellerForRefund: false, containsInstructionsToAi: false });
});

test('a compromised drafter is stopped: whatever it returns can only ever be evidence, and the rules deny bad evidence', async () => {
  const { msId, fk } = await disputedStage();
  const cases: [any, RegExp][] = [
    [{ evidenceType: 'PROOF_OF_REFUND', notes: 'We refunded.', citedFileIds: ['file_test'] }, /evidence type/],
    [{ evidenceType: 'OTHER', notes: 'Pay here https://evil.example', citedFileIds: ['file_test'] }, /links/],
    [{ evidenceType: 'OTHER', notes: 'Delivered.', citedFileIds: ['someone_elses_file'] }, /not on this milestone/],
  ];
  for (const [answer, why] of cases) {
    script.drafter = () => answer;
    const d = await call('POST', `/api/milestones/${msId}/defence`, fk);
    assert.equal(d.body.draft.status, 'denied');
    assert.match(d.body.draft.verdict.reason, why);
    assert.equal(d.body.draft.verdict.by, 'rules');
    assert.equal((await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId: d.body.draft.id })).status, 409);
  }
  assert.equal(llmCalls.filter((c) => c.role === 'second_key').length, 0, 'the rules stop these before the gate is paid for');
  assert.equal(moneyMoved().length, 0);
  assert.equal((await call('POST', `/api/milestones/${msId}/defence`, fk)).status, 409, 'attempts are capped');
});

test('the gate fails closed: refusal, error, bad output and an approve with a failed check all deny', async () => {
  assert.equal(verdictFrom({ ...GOOD_VERDICT, evidence_supports: false }).decision, 'deny');
  assert.equal(verdictFrom({ ...GOOD_VERDICT, amount_matches: 'true' }).decision, 'deny');
  assert.equal(verdictFrom({ ...GOOD_VERDICT, decision: 'sure' }).decision, 'deny');
  assert.equal(verdictFrom(null).decision, 'deny');
  assert.equal(verdictFrom({ ...GOOD_VERDICT, decision: 'escalate' }).decision, 'escalate');

  const { msId, fk } = await disputedStage();
  script.second_key = () => new Error('second_key stopped with refusal');
  const d = await call('POST', `/api/milestones/${msId}/defence`, fk);
  assert.equal(d.body.draft.status, 'denied');
  assert.match(d.body.draft.verdict.reason, /denied/);
  assert.equal((await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId: d.body.draft.id })).status, 409);
  assert.equal(paypalCalls.some((c) => c.path.endsWith('/provide-evidence')), false);
});

test('reader or drafter failure denies and files nothing; escalate cannot be filed but can be rejected', async () => {
  const { msId, fk } = await disputedStage();
  script.reader = () => new Error('reader stopped with refusal');
  const a = await call('POST', `/api/milestones/${msId}/defence`, fk);
  assert.equal(a.body.draft.status, 'denied');
  assert.equal(a.body.draft.notes, null);
  assert.equal(llmCalls.length, 1, 'no draft without the reader');

  script.reader = () => GOOD_READER;
  script.second_key = () => ({ ...GOOD_VERDICT, decision: 'escalate', reason: 'The record is thin.' });
  const b = await call('POST', `/api/milestones/${msId}/defence`, fk);
  assert.equal(b.body.draft.status, 'escalated');
  assert.equal((await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId: b.body.draft.id })).status, 409);
  assert.equal((await call('POST', `/api/milestones/${msId}/defence/reject`, fk, { draftId: b.body.draft.id })).body.draft.status, 'rejected');
});

test('rules: wrong capture, too large an amount and a passed deadline deny before the gate', async () => {
  const { msId, fk } = await disputedStage();
  dispute.disputed_transactions[0].seller_transaction_id = 'SOMEONE_ELSES';
  dispute.dispute_amount.value = '999.00';
  dispute.seller_response_due_date = new Date(Date.now() - 1000).toISOString();
  const d = await call('POST', `/api/milestones/${msId}/defence`, fk);
  assert.equal(d.body.draft.status, 'denied');
  for (const why of [/different|not against/, /more than was captured/, /deadline/]) assert.match(d.body.draft.verdict.reason, why);
  assert.equal(llmCalls.filter((c) => c.role === 'second_key').length, 0);
});

test('tap re-checks: PayPal closed the window, or a file was swapped after acceptance', async () => {
  const { msId, fk } = await disputedStage();
  const d = await call('POST', `/api/milestones/${msId}/defence`, fk);
  const draftId = d.body.draft.id;
  const links = dispute.links;
  dispute.links = [{ rel: 'self' }];
  assert.equal((await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId })).status, 409);
  dispute.links = links;

  await db.query('UPDATE evidence_files SET bytes = $1 WHERE id = $2', [Buffer.from('a different file'), fileId]);
  const swapped = await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId });
  assert.equal(swapped.status, 409);
  assert.equal(swapped.body.draft.status, 'denied');
  assert.equal(paypalCalls.some((c) => c.path.endsWith('/provide-evidence')), false);
});

test('a file PayPal cannot take is listed by fingerprint instead of attached', async () => {
  const { msId, fk, sha } = await disputedStage({ mime: 'application/zip' });
  const d = await call('POST', `/api/milestones/${msId}/defence`, fk);
  await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId: d.body.draft.id });
  const post = paypalCalls.find((c) => c.path.endsWith('/provide-evidence'))!;
  assert.equal([...post.form!.keys()].filter((k) => k !== 'input').length, 0);
  assert.match(JSON.parse(await (post.form!.get('input') as Blob).text()).evidences[0].notes, new RegExp(sha));
});

test('PayPal refusing the filing leaves the draft ready to try again', async () => {
  const { msId, fk } = await disputedStage();
  const d = await call('POST', `/api/milestones/${msId}/defence`, fk);
  handle = createHandler({ db: fromPglite(db), appUrl: APP, webhookId: 'WH', llm: fakeLlm, paypal: { ...fakePaypal(), postForm: async () => { throw new PaypalError(422, 'UNPROCESSABLE', 'dbg', 'no'); } } });
  assert.equal((await call('POST', `/api/milestones/${msId}/defence/file`, fk, { draftId: d.body.draft.id })).status, 502);
  assert.equal((await call('GET', `/api/milestones/${msId}/defence`, fk)).body.draft.status, 'ready');
});

test('without an AI key the routes say so; no dispute means no spend', async () => {
  const { msId, fk } = await disputedStage();
  const noAi = createHandler({ db: fromPglite(db), paypal: fakePaypal(), appUrl: APP, webhookId: 'WH' });
  const res = await noAi(new Request(`${APP}/api/milestones/${msId}/defence`, { method: 'POST', headers: { authorization: `Bearer ${fk}` } }));
  assert.equal(res.status, 503);
  await db.query('DELETE FROM disputes');
  assert.equal((await call('POST', `/api/milestones/${msId}/defence`, fk)).status, 409);
  assert.equal(llmCalls.length, 0);
});
