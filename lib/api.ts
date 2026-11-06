// Lane A backend: every route in contract.ts ROUTES, as one fetch-style handler (Request -> Response).
// Works under Next.js (app/api/[...path]/route.ts) or the plain Node server in server.ts.
// Money moves only through PayPal; each PayPal POST carries a fixed request id so retries never act twice.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { STATUS_LABEL, type BuyerFields, type DefenceDraft, type DefenceStatus, type DefenceVerdict, type JobProgress, type LedgerRow, type MilestoneStatus, type MilestoneView } from './contract.ts';
import type { Db, Query } from './db.ts';
import { MODELS, checkRules, denied, draftResponse, readUntrusted, secondKey, type JobRecord, type Llm, type ProposedAction } from './defence.ts';
import { applyEvent, canTransition, reservationState } from './ledger.ts';
import { PaypalError, type Paypal } from './paypal.ts';
import { verifyWebhook } from './webhook.ts';

export type Deps = {
  db: Db;
  paypal: Paypal;
  appUrl: string;               // public https origin, e.g. https://receipts.onrender.com
  webhookId: string | null;     // PayPal webhook id; without it every webhook is refused
  paypalWebBase?: string;       // where buyers approve; sandbox by default
  llm?: Llm | null;             // AI dispute defence; without it those routes answer 503
  now?: () => Date;
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MONEY = /^(?:0|[1-9]\d{0,5})\.\d{2}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;
const newKey = () => randomBytes(32).toString('base64url');
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const cents = (money: string) => Number(money.replace('.', ''));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(400, `${field} must be 1-${max} characters`);
  return v.trim();
}

function money(v: unknown, field: string): string {
  if (typeof v !== 'string' || !MONEY.test(v) || cents(v) === 0) throw new HttpError(400, `${field} must look like "200.00"`);
  return v;
}

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

function bearer(req: Request): string | null {
  const m = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

type Role = 'freelancer' | 'client';

// Returns which role the bearer key holds on this job, or throws 401/403.
async function authJob(q: Query, req: Request, jobId: string, allowed: Role[]): Promise<Role> {
  const key = bearer(req);
  if (!key) throw new HttpError(401, 'missing bearer key');
  const { rows } = await q('SELECT freelancer_key_hash, client_key_hash FROM jobs WHERE id = $1', [jobId]);
  if (!rows.length) throw new HttpError(404, 'job not found');
  const h = hashKey(key);
  if (allowed.includes('freelancer') && sameHash(h, rows[0].freelancer_key_hash)) return 'freelancer';
  if (allowed.includes('client') && sameHash(h, rows[0].client_key_hash)) return 'client';
  throw new HttpError(403, 'this key cannot do that');
}

async function audit(q: Query, actor: string, action: string, milestoneId: string | null,
  decision: string, reason: string, detail: unknown = null) {
  await q('INSERT INTO audit_log (actor, action, milestone_id, decision, reason, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor, action, milestoneId, decision, reason, detail === null ? null : JSON.stringify(detail)]);
}

async function loadMilestone(q: Query, id: string, lock = false) {
  const { rows } = await q(`SELECT * FROM milestones WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows.length) throw new HttpError(404, 'milestone not found');
  return rows[0];
}

async function setStatus(q: Query, ms: any, to: MilestoneStatus, actor: string, why: string) {
  if (ms.status === to) return;
  if (!canTransition(ms.status, to)) throw new HttpError(409, `cannot go from ${ms.status} to ${to}`);
  await q('UPDATE milestones SET status = $2, status_changed_at = now() WHERE id = $1', [ms.id, to]);
  await audit(q, actor, `status ${ms.status} -> ${to}`, ms.id, 'n/a', why);
  ms.status = to;
}

async function latestAuthorization(q: Query, milestoneId: string) {
  const { rows } = await q('SELECT * FROM authorizations WHERE milestone_id = $1 ORDER BY created_at DESC LIMIT 1', [milestoneId]);
  return rows[0] ?? null;
}

async function upsertAuthorization(q: Query, milestoneId: string, a: any, parentId: string | null = null) {
  await q(`INSERT INTO authorizations (id, milestone_id, parent_authorization_id, status, amount, expiration_time, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()))
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, expiration_time = EXCLUDED.expiration_time`,
    [a.id, milestoneId, parentId, a.status, a.amount?.value ?? '0.00', a.expiration_time ?? null, a.create_time ?? null]);
}

async function upsertCapture(q: Query, milestoneId: string, authorizationId: string, c: any) {
  const b = c.seller_receivable_breakdown;
  await q(`INSERT INTO captures (id, milestone_id, authorization_id, status, status_reason, gross, paypal_fee, net)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, status_reason = EXCLUDED.status_reason,
             paypal_fee = COALESCE(EXCLUDED.paypal_fee, captures.paypal_fee), net = COALESCE(EXCLUDED.net, captures.net)`,
    [c.id, milestoneId, authorizationId, c.status, c.status_details?.reason ?? null,
      b?.gross_amount?.value ?? c.amount?.value ?? '0.00', b?.paypal_fee?.value ?? null, b?.net_amount?.value ?? null]);
}

async function milestoneView(q: Query, ms: any): Promise<MilestoneView> {
  const [files, auth, cap, dispute, acc, changes] = await Promise.all([
    q('SELECT id, filename, sha256, criterion_id FROM evidence_files WHERE milestone_id = $1 ORDER BY uploaded_at', [ms.id]),
    latestAuthorization(q, ms.id),
    q('SELECT * FROM captures WHERE milestone_id = $1', [ms.id]),
    q('SELECT * FROM disputes WHERE milestone_id = $1 ORDER BY updated_at DESC LIMIT 1', [ms.id]),
    q('SELECT accepted_by, accepted_at FROM acceptances WHERE milestone_id = $1', [ms.id]),
    q('SELECT round, criterion_id, note, created_at FROM change_requests WHERE milestone_id = $1 ORDER BY round', [ms.id]),
  ]);
  const c = cap.rows[0];
  const d = dispute.rows[0];
  const a = acc.rows[0];
  const status = ms.status as MilestoneStatus;
  return {
    id: ms.id,
    jobId: ms.job_id,
    position: ms.position,
    kind: ms.kind,
    title: ms.title,
    reviewState: ms.review_state,
    revisionRound: ms.revision_round,
    maxRevisions: ms.max_revisions,
    changeRequests: changes.rows.map((r: any) => ({ round: r.round, criterionId: r.criterion_id, note: r.note, at: iso(r.created_at)! })),
    amount: ms.amount,
    criteria: ms.criteria,
    status,
    statusLabel: STATUS_LABEL[status],
    reservedUntil: status === 'reserved' && auth ? iso(auth.expiration_time) : null,
    approveUrl: status === 'awaiting_payment' ? ms.approve_url : null,
    capture: c ? { id: c.id, gross: c.gross, fee: c.paypal_fee, net: c.net, heldReason: c.status_reason } : null,
    dispute: d ? { id: d.id, status: d.status, responseDue: iso(d.seller_response_due), canProvideEvidence: d.can_provide_evidence } : null,
    files: files.rows.map((f: any) => ({ id: f.id, filename: f.filename, sha256: f.sha256, criterionId: f.criterion_id })),
    accepted: a ? { by: a.accepted_by, at: iso(a.accepted_at)! } : null,
  };
}

function jobView(j: any) {
  return { id: j.id, title: j.title, clientName: j.client_name, clientEmail: j.client_email, currency: j.currency, createdAt: iso(j.created_at) };
}

async function jobWithMilestones(q: Query, jobId: string) {
  const job = (await q('SELECT * FROM jobs WHERE id = $1', [jobId])).rows[0];
  const ms = (await q('SELECT * FROM milestones WHERE job_id = $1 ORDER BY position', [jobId])).rows;
  const milestones = await Promise.all(ms.map((m: any) => milestoneView(q, m)));
  return { job: jobView(job), milestones, progress: progress(milestones) };
}

const PAID: MilestoneStatus[] = ['captured', 'capture_pending', 'disputed', 'dispute_closed'];

// What the shared progress bar shows. Cents as integers, so no float drift.
function progress(milestones: MilestoneView[]): JobProgress {
  const sum = (list: MilestoneView[]) => list.reduce((n, m) => n + cents(m.amount), 0);
  const total = sum(milestones);
  const paid = milestones.filter((m) => PAID.includes(m.status));
  const money = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
  return {
    total: money(total),
    paid: money(sum(paid)),
    reserved: money(sum(milestones.filter((m) => m.status === 'reserved'))),
    percentPaid: total ? Math.round((sum(paid) / total) * 100) : 0,
    stagesPaid: paid.length,
    stages: milestones.length,
  };
}

// Captures a reserved milestone (reauthorizing first if past the 3-day honour period) and sets its status.
async function captureReserved(d: Deps, q: Query, ms: any, now: Date) {
  let auth = await latestAuthorization(q, ms.id);
  if (!auth) throw new HttpError(409, 'no authorization on file');
  const state = reservationState(iso(auth.expiration_time)!, iso(auth.created_at)!, now);
  if (state === 'expired') throw new HttpError(409, 'reservation expired; request payment again');
  if (state === 'needs_reauthorize') {
    const re = await d.paypal.call('POST', `/v2/payments/authorizations/${auth.id}/reauthorize`, {}, `reauthorize-${auth.id}`);
    await upsertAuthorization(q, ms.id, re, auth.id);
    await audit(q, 'system', 'reauthorized', ms.id, 'n/a', `past the 3-day honour period; new authorization ${re.id}`);
    auth = { ...auth, id: re.id };
  }
  const cap = await d.paypal.call('POST', `/v2/payments/authorizations/${auth.id}/capture`, { final_capture: true }, `capture-${ms.id}`);
  await upsertCapture(q, ms.id, auth.id, cap);
  await q("UPDATE authorizations SET status = 'CAPTURED' WHERE id = $1", [auth.id]);
  const to: MilestoneStatus = cap.status === 'COMPLETED' ? 'captured' : cap.status === 'PENDING' ? 'capture_pending' : 'capture_failed';
  await setStatus(q, ms, to, 'system', `capture ${cap.id} ${cap.status}${cap.status_details?.reason ? ` (${cap.status_details.reason})` : ''}`);
}

// ---- routes -------------------------------------------------------------------------------------

async function createJob(d: Deps, req: Request) {
  const b = await body(req);
  const title = text(b.title, 'title', 200);
  const clientName = text(b.clientName, 'clientName', 120);
  const clientEmail = text(b.clientEmail, 'clientEmail', 320);
  if (!EMAIL.test(clientEmail)) throw new HttpError(400, 'clientEmail is not an email address');
  if (!Array.isArray(b.milestones) || b.milestones.length < 1 || b.milestones.length > 20) {
    throw new HttpError(400, 'milestones must be a list of 1-20');
  }
  const milestones: { kind?: string; title: string; amount: string; criteria: { id: string; text: string }[] }[] = b.milestones.map((m: any, i: number) => {
    if (!Array.isArray(m?.criteria) || m.criteria.length < 1 || m.criteria.length > 20) {
      throw new HttpError(400, `milestones[${i}].criteria must be a list of 1-20`);
    }
    return {
      title: text(m.title, `milestones[${i}].title`, 200),
      amount: money(m.amount, `milestones[${i}].amount`),
      criteria: m.criteria.map((c: unknown, k: number) => ({ id: `c${k + 1}`, text: text(c, `milestones[${i}].criteria[${k}]`, 500) })),
    };
  });
  const maxRevisions = b.maxRevisions ?? 2;
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 5) throw new HttpError(400, 'maxRevisions must be 0-5');
  if (b.deposit !== undefined) {
    milestones.unshift({ kind: 'deposit', title: 'Deposit', amount: money(b.deposit, 'deposit'),
      criteria: [{ id: 'c1', text: 'Scope and stage plan agreed' }] });
  }
  const jobId = newId('job');
  const freelancerKey = newKey();
  const clientKey = newKey();
  const out = await d.db.transaction(async (q) => {
    await q('INSERT INTO jobs (id, title, client_name, client_email, freelancer_key_hash, client_key_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [jobId, title, clientName, clientEmail, hashKey(freelancerKey), hashKey(clientKey)]);
    for (const [i, m] of milestones.entries()) {
      const id = newId('ms');
      await q('INSERT INTO milestones (id, job_id, position, kind, title, amount, criteria, max_revisions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, jobId, i + 1, m.kind ?? 'stage', m.title, m.amount, JSON.stringify(m.criteria), maxRevisions]);
      await audit(q, 'freelancer', `${m.kind ?? 'stage'} scoped`, id, 'n/a', `${m.title}, $${m.amount}`);
    }
    return jobWithMilestones(q, jobId);
  });
  // The keys are shown once; only their hashes are stored.
  return json(201, { ...out, freelancerKey, clientKey });
}

async function getJob(d: Deps, req: Request, jobId: string) {
  await authJob(d.db.query, req, jobId, ['freelancer', 'client']);
  return json(200, await jobWithMilestones(d.db.query, jobId));
}

async function requestPayment(d: Deps, req: Request, msId: string) {
  const first = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, first.job_id, ['freelancer']);
  const approveUrl = await d.db.transaction(async (q) => {
    const ms = await loadMilestone(q, msId, true);
    if (ms.status === 'awaiting_payment' && ms.approve_url) return ms.approve_url as string;
    if (ms.status !== 'draft') throw new HttpError(409, `payment already requested (${ms.status})`);
    const job = (await q('SELECT title FROM jobs WHERE id = $1', [ms.job_id])).rows[0];
    const order = await d.paypal.call('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{
        custom_id: ms.id,
        invoice_id: ms.id,
        description: `${job.title}: ${ms.title}`.slice(0, 127),
        amount: { currency_code: 'USD', value: ms.amount },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Receipts',
            user_action: 'CONTINUE',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${d.appUrl}/api/paypal/return`,
            cancel_url: `${d.appUrl}/jobs/${ms.job_id}?milestone=${ms.id}&payment=cancelled`,
          },
        },
      },
    }, `order-${ms.id}`);
    const link = order.links?.find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!link) throw new HttpError(502, 'PayPal returned no approval link');
    await q('UPDATE milestones SET paypal_order_id = $2, approve_url = $3 WHERE id = $1', [ms.id, order.id, link]);
    await setStatus(q, ms, 'awaiting_payment', 'freelancer', `PayPal order ${order.id}`);
    return link as string;
  });
  return json(200, { approveUrl });
}

async function paypalReturn(d: Deps, url: URL) {
  const orderId = url.searchParams.get('token');
  if (!orderId || !/^[A-Z0-9]{5,40}$/.test(orderId)) throw new HttpError(400, 'missing PayPal token');
  const { rows } = await d.db.query('SELECT id, job_id FROM milestones WHERE paypal_order_id = $1', [orderId]);
  if (!rows.length) throw new HttpError(404, 'unknown PayPal order');
  const { id: msId, job_id: jobId } = rows[0];
  const back = (result: string) => Response.redirect(`${d.appUrl}/jobs/${jobId}?milestone=${msId}&payment=${result}`, 303);
  const result = await d.db.transaction(async (q) => {
    const ms = await loadMilestone(q, msId, true);
    if (ms.status !== 'awaiting_payment' && ms.status !== 'approved') return ms.status === 'reserved' ? 'reserved' : ms.status;
    let order;
    try {
      order = await d.paypal.call('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, `authorize-${orderId}`);
    } catch (e) {
      if (e instanceof PaypalError && e.issue === 'ORDER_NOT_APPROVED') return 'not_approved';
      throw e;
    }
    const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth?.id) throw new HttpError(502, 'PayPal returned no authorization');
    await upsertAuthorization(q, ms.id, auth);
    await setStatus(q, ms, 'reserved', 'system', `authorization ${auth.id} ${auth.status}, $${auth.amount?.value}`);
    if (ms.kind !== 'deposit') return 'reserved';
    // A deposit is the client agreeing to the scope and stage plan, so it is taken straight away.
    await q('INSERT INTO acceptances (id, milestone_id, accepted_by, file_hashes) VALUES ($1,$2,$3,$4) ON CONFLICT (milestone_id) DO NOTHING',
      [newId('acc'), ms.id, 'client', '[]']);
    await audit(q, 'client', 'scope agreed by paying the deposit', ms.id, 'approve', `deposit $${ms.amount}`);
    await captureReserved(d, q, ms, d.now?.() ?? new Date());
    return ms.status === 'captured' ? 'paid' : ms.status;
  });
  return back(result);
}

async function uploadFile(d: Deps, req: Request, msId: string) {
  const first = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, first.job_id, ['freelancer']);
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_FILE_BYTES + 64 * 1024) throw new HttpError(413, 'file is larger than 10 MB');
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'send multipart/form-data with a "file" field');
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) throw new HttpError(400, 'missing "file"');
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, 'file is larger than 10 MB');
  const criterionRaw = form.get('criterionId');
  const criterionId = typeof criterionRaw === 'string' && criterionRaw ? criterionRaw : null;
  if (criterionId && !first.criteria.some((c: any) => c.id === criterionId)) throw new HttpError(400, 'unknown criterionId');
  const filename = (file.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = newId('file');
  await d.db.transaction(async (q) => {
    const ms = await loadMilestone(q, msId, true);
    if (ms.kind === 'deposit') throw new HttpError(409, 'files go on a stage, not the deposit');
    if (!['draft', 'awaiting_payment', 'approved', 'reserved'].includes(ms.status)) {
      throw new HttpError(409, `cannot add files while ${ms.status}`);
    }
    if ((await q('SELECT 1 FROM acceptances WHERE milestone_id = $1', [msId])).rows.length) {
      throw new HttpError(409, 'milestone already accepted');
    }
    await q('INSERT INTO evidence_files (id, milestone_id, criterion_id, filename, mime_type, sha256, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, msId, criterionId, filename, (file.type || 'application/octet-stream').slice(0, 100), sha256, bytes]);
    await q("UPDATE milestones SET review_state = 'delivered' WHERE id = $1", [msId]);
    await audit(q, 'freelancer', 'file delivered', msId, 'n/a', `${filename} sha256 ${sha256}`);
  });
  return json(201, { id, filename, sha256 });
}

// The client says which criterion is not met yet. Counted against the revision rounds agreed in scope.
async function requestChanges(d: Deps, req: Request, msId: string) {
  const first = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, first.job_id, ['client']);
  const b = await body(req);
  const note = text(b.note, 'note', 1000);
  if (typeof b.criterionId !== 'string' || !first.criteria.some((c: any) => c.id === b.criterionId)) {
    throw new HttpError(400, 'criterionId must be one of this stage\'s criteria');
  }
  const view = await d.db.transaction(async (q) => {
    const ms = await loadMilestone(q, msId, true);
    if (ms.kind === 'deposit' || ms.status !== 'reserved' || ms.review_state !== 'delivered') {
      throw new HttpError(409, 'changes can be requested only on a delivered stage that is not yet paid');
    }
    if (ms.revision_round >= ms.max_revisions) {
      await audit(q, 'client', 'change request refused', msId, 'deny', `all ${ms.max_revisions} agreed revision rounds used`);
      throw new HttpError(409, `all ${ms.max_revisions} agreed revision rounds are used; agree a way forward or open a PayPal dispute`);
    }
    const round = ms.revision_round + 1;
    await q('INSERT INTO change_requests (id, milestone_id, round, criterion_id, note) VALUES ($1,$2,$3,$4,$5)',
      [newId('chg'), msId, round, b.criterionId, note]);
    await q("UPDATE milestones SET review_state = 'changes_requested', revision_round = $2 WHERE id = $1", [msId, round]);
    await audit(q, 'client', 'changes requested', msId, 'n/a', `round ${round} of ${ms.max_revisions}, criterion ${b.criterionId}`);
    return milestoneView(q, { ...ms, review_state: 'changes_requested', revision_round: round });
  });
  return json(200, view);
}

async function createMandate(d: Deps, req: Request, jobId: string) {
  await authJob(d.db.query, req, jobId, ['client']);
  const b = await body(req);
  const maxAmount = money(b.maxAmount, 'maxAmount');
  const days = b.days;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, 'days must be a whole number from 1 to 30');
  const mandateId = newId('mdt');
  const agentKey = newKey();
  const expiresAt = new Date((d.now?.() ?? new Date()).getTime() + days * 86_400_000);
  await d.db.transaction(async (q) => {
    await q('INSERT INTO mandates (id, job_id, max_amount, key_hash, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [mandateId, jobId, maxAmount, hashKey(agentKey), expiresAt]);
    await audit(q, 'client', 'mandate granted', null, 'approve', `agent may accept milestones up to $${maxAmount} until ${expiresAt.toISOString()}`, { mandateId, jobId });
  });
  return json(201, { mandateId, agentKey, expiresAt: expiresAt.toISOString() });
}

async function accept(d: Deps, req: Request, msId: string) {
  const b = await body(req);
  const first = await loadMilestone(d.db.query, msId);
  const now = d.now?.() ?? new Date();
  let actor: 'client' | 'client_agent';
  let mandateId: string | null = null;
  if (b.by === 'client') {
    await authJob(d.db.query, req, first.job_id, ['client']);
    actor = 'client';
  } else if (b.by === 'client_agent') {
    // The agent holds its own key, limited by the mandate: this job, an amount cap, an expiry, revocable.
    const key = bearer(req);
    if (!key || typeof b.mandateId !== 'string') throw new HttpError(401, 'agent needs its key and mandateId');
    const m = (await d.db.query('SELECT * FROM mandates WHERE id = $1 AND job_id = $2', [b.mandateId, first.job_id])).rows[0];
    if (!m || !sameHash(hashKey(key), m.key_hash)) throw new HttpError(403, 'mandate does not match this key and job');
    const deny = m.revoked_at ? 'mandate revoked'
      : new Date(m.expires_at) <= now ? 'mandate expired'
      : cents(first.amount) > cents(m.max_amount) ? `amount $${first.amount} is over the mandate cap $${m.max_amount}` : null;
    if (deny) {
      await audit(d.db.query, 'client_agent', 'accept refused', msId, 'deny', deny, { mandateId: m.id });
      throw new HttpError(403, deny);
    }
    actor = 'client_agent';
    mandateId = m.id;
  } else {
    throw new HttpError(400, 'by must be "client" or "client_agent"');
  }

  const view = await d.db.transaction(async (q) => {
    const ms = await loadMilestone(q, msId, true);
    if (ms.kind === 'deposit') throw new HttpError(409, 'a deposit is paid when the client pays it; nothing to accept');
    const already = (await q('SELECT 1 FROM acceptances WHERE milestone_id = $1', [msId])).rows.length > 0;
    if (already && ms.status !== 'reserved') return milestoneView(q, ms); // repeated accept: nothing to do
    if (ms.status !== 'reserved') throw new HttpError(409, `cannot accept while ${ms.status}`);
    if (!already && ms.review_state === 'changes_requested') {
      throw new HttpError(409, 'changes were requested; waiting for the freelancer to deliver again');
    }
    const files = (await q('SELECT sha256 FROM evidence_files WHERE milestone_id = $1 ORDER BY uploaded_at', [msId])).rows;
    if (!files.length) throw new HttpError(409, 'nothing delivered yet: upload at least one file first');
    if (!already) {
      await q('INSERT INTO acceptances (id, milestone_id, accepted_by, mandate_id, file_hashes) VALUES ($1,$2,$3,$4,$5)',
        [newId('acc'), msId, actor, mandateId, JSON.stringify(files.map((f: any) => f.sha256))]);
      await audit(q, actor, 'work accepted', msId, 'approve', `${files.length} file(s) seen`, { mandateId });
    }
    await captureReserved(d, q, ms, now);
    return milestoneView(q, ms);
  });
  return json(200, view);
}

async function voidMilestone(d: Deps, req: Request, msId: string) {
  const first = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, first.job_id, ['freelancer']);
  const view = await d.db.transaction(async (q) => {
    const ms = await loadMilestone(q, msId, true);
    if (ms.status === 'voided') return milestoneView(q, ms);
    if (ms.status !== 'reserved') throw new HttpError(409, `only a reserved milestone can be cancelled (now ${ms.status})`);
    if ((await q('SELECT 1 FROM acceptances WHERE milestone_id = $1', [msId])).rows.length) {
      throw new HttpError(409, 'client already accepted; it can no longer be cancelled');
    }
    const auth = await latestAuthorization(q, msId);
    await d.paypal.call('POST', `/v2/payments/authorizations/${auth.id}/void`, {}, `void-${auth.id}`);
    await q("UPDATE authorizations SET status = 'VOIDED' WHERE id = $1", [auth.id]);
    await setStatus(q, ms, 'voided', 'freelancer', `authorization ${auth.id} voided`);
    return milestoneView(q, ms);
  });
  return json(200, view);
}

// ---- webhook ------------------------------------------------------------------------------------

const CAPTURE_EVENT: Record<string, string> = {
  COMPLETED: 'PAYMENT.CAPTURE.COMPLETED', PENDING: 'PAYMENT.CAPTURE.PENDING', DECLINED: 'PAYMENT.CAPTURE.DECLINED',
  FAILED: 'PAYMENT.CAPTURE.DENIED', REFUNDED: 'PAYMENT.CAPTURE.REFUNDED', PARTIALLY_REFUNDED: 'PAYMENT.CAPTURE.REFUNDED',
  REVERSED: 'PAYMENT.CAPTURE.REVERSED',
};

async function milestoneByCustomId(q: Query, customId: unknown): Promise<string | null> {
  if (typeof customId !== 'string') return null;
  return (await q('SELECT id FROM milestones WHERE id = $1', [customId])).rows[0]?.id ?? null;
}

// Re-reads the resource from PayPal (never trusting the webhook body for state), stores it,
// and returns the milestone plus the event type its current PayPal state implies.
async function resolveEvent(d: Deps, q: Query, type: string, resourceId: string): Promise<{ msId: string | null; effective: string | null }> {
  if (type.startsWith('CHECKOUT.')) {
    const msId = (await q('SELECT id FROM milestones WHERE paypal_order_id = $1', [resourceId])).rows[0]?.id ?? null;
    return { msId, effective: type };
  }
  if (type.startsWith('PAYMENT.AUTHORIZATION.')) {
    const a = await d.paypal.call('GET', `/v2/payments/authorizations/${encodeURIComponent(resourceId)}`);
    const orderId = a.supplementary_data?.related_ids?.order_id;
    const msId = (await milestoneByCustomId(q, a.custom_id))
      ?? (orderId ? (await q('SELECT id FROM milestones WHERE paypal_order_id = $1', [orderId])).rows[0]?.id ?? null : null);
    if (!msId) return { msId, effective: null };
    await upsertAuthorization(q, msId, a);
    const effective = a.status === 'CREATED' ? 'PAYMENT.AUTHORIZATION.CREATED' : a.status === 'VOIDED' ? 'PAYMENT.AUTHORIZATION.VOIDED' : null;
    return { msId, effective };
  }
  if (type.startsWith('PAYMENT.CAPTURE.')) {
    const c = await d.paypal.call('GET', `/v2/payments/captures/${encodeURIComponent(resourceId)}`);
    const authId = c.supplementary_data?.related_ids?.authorization_id;
    const msId = (await milestoneByCustomId(q, c.custom_id))
      ?? (authId ? (await q('SELECT milestone_id FROM authorizations WHERE id = $1', [authId])).rows[0]?.milestone_id ?? null : null);
    if (!msId || !authId) return { msId, effective: null };
    if (!(await q('SELECT 1 FROM authorizations WHERE id = $1', [authId])).rows.length) {
      await upsertAuthorization(q, msId, await d.paypal.call('GET', `/v2/payments/authorizations/${encodeURIComponent(authId)}`));
    }
    await upsertCapture(q, msId, authId, c);
    return { msId, effective: CAPTURE_EVENT[c.status] ?? null };
  }
  if (type.startsWith('CUSTOMER.DISPUTE.')) {
    const dp = await d.paypal.call('GET', `/v1/customer/disputes/${encodeURIComponent(resourceId)}`);
    const captureId = dp.disputed_transactions?.[0]?.seller_transaction_id ?? null;
    const cap = captureId ? (await q('SELECT id, milestone_id FROM captures WHERE id = $1', [captureId])).rows[0] : null;
    const msId = cap?.milestone_id ?? (await milestoneByCustomId(q, dp.disputed_transactions?.[0]?.invoice_number));
    const known = (await q('SELECT 1 FROM disputes WHERE id = $1', [dp.dispute_id])).rows.length > 0;
    const canEvidence = (dp.links ?? []).some((l: any) => l.rel === 'provide_evidence');
    // Buyer-written text is not stored here: it goes through the quarantined reader first.
    await q(`INSERT INTO disputes (id, milestone_id, capture_id, status, stage, reason, seller_response_due, can_provide_evidence, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, stage = EXCLUDED.stage, reason = EXCLUDED.reason,
               seller_response_due = EXCLUDED.seller_response_due, can_provide_evidence = EXCLUDED.can_provide_evidence, updated_at = now()`,
      [dp.dispute_id, msId, cap?.id ?? null, dp.status, dp.dispute_life_cycle_stage ?? null, dp.reason ?? null,
        dp.seller_response_due_date ?? null, canEvidence]);
    const effective = dp.status === 'RESOLVED' ? 'CUSTOMER.DISPUTE.RESOLVED' : known ? 'CUSTOMER.DISPUTE.UPDATED' : 'CUSTOMER.DISPUTE.CREATED';
    return { msId, effective };
  }
  return { msId: null, effective: null };
}

async function paypalWebhook(d: Deps, req: Request) {
  const raw = await req.text();
  if (!d.webhookId) return json(503, { error: 'webhook not configured' }); // PayPal retries later
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const check = await verifyWebhook(raw, req.headers, d.webhookId, (p, b) => d.paypal.postRaw(p, b));
  if (!check.ok) {
    // Kept for the audit trail under a random id, so a forged event can never block the real one's id.
    await d.db.query('INSERT INTO webhook_events (event_id, event_type, resource_id, verified, raw_body, processed_at, outcome) VALUES ($1,$2,$3,false,$4,now(),$5)',
      [newId('rejected'), String(event.event_type ?? '').slice(0, 100), String(event.resource?.id ?? '').slice(0, 100) || null,
        raw.slice(0, 100_000), `rejected_signature: ${check.reason}`.slice(0, 300)]);
    return json(401, { error: 'signature not verified' });
  }
  const type = String(event.event_type);
  const resourceId = String(event.resource?.id ?? '');
  const fresh = await d.db.query(
    'INSERT INTO webhook_events (event_id, event_type, resource_id, verified, raw_body) VALUES ($1,$2,$3,true,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
    [event.id, type, resourceId || null, raw]);
  if (!fresh.rows.length) return json(200, { outcome: 'duplicate' });
  try {
    const outcome = await d.db.transaction(async (q) => {
      if (!resourceId) return 'ignored_unknown';
      const { msId, effective } = await resolveEvent(d, q, type, resourceId);
      if (!msId || !effective) return 'ignored_unknown';
      const ms = await loadMilestone(q, msId, true);
      const t = applyEvent(ms.status, effective);
      if (t.applied && t.status !== ms.status) {
        await q('UPDATE milestones SET status = $2, status_changed_at = now() WHERE id = $1', [msId, t.status]);
      }
      await audit(q, 'system', `webhook ${type}`, msId, 'n/a', t.reason, { eventId: event.id, effective });
      return t.applied ? 'applied' : 'ignored_stale';
    });
    await d.db.query('UPDATE webhook_events SET processed_at = now(), outcome = $2 WHERE event_id = $1', [event.id, outcome]);
    return json(200, { outcome });
  } catch (e) {
    // Forget the delivery so PayPal's retry is processed instead of being dropped as a duplicate.
    await d.db.query('DELETE FROM webhook_events WHERE event_id = $1', [event.id]);
    throw e;
  }
}

// ---- AI dispute defence ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3; // per dispute, so a leaked key cannot run up the AI bill
const ATTACHABLE: Record<string, string> = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/png': 'png', 'application/pdf': 'pdf' }; // what PayPal takes
const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;
const MAX_FILED_NOTE = 2000;

async function auditModel(q: Query, actor: string, action: string, milestoneId: string, decision: string, reason: string, model: string | null, detail: unknown = null) {
  await q('INSERT INTO audit_log (actor, action, milestone_id, decision, reason, model, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [actor, action, milestoneId, decision, reason, model, detail === null ? null : JSON.stringify(detail)]);
}

// Everything in a PayPal dispute that the buyer wrote. It goes to the reader and nowhere else, and is not stored.
function buyerTexts(dp: any): string[] {
  const texts = [
    ...(dp.messages ?? []).filter((m: any) => m.posted_by === 'BUYER').map((m: any) => m.content),
    ...(dp.evidences ?? []).filter((e: any) => e.source === 'SUBMITTED_BY_BUYER').map((e: any) => e.notes),
    ...(dp.disputed_transactions ?? []).flatMap((t: any) => (t.items ?? []).flatMap((i: any) => [i.item_description, i.notes])),
  ];
  return texts.filter((t) => typeof t === 'string' && t.trim());
}

const CODE = /^[A-Z_]{1,60}$/;
const canEvidence = (dp: any) => (dp.links ?? []).some((l: any) => l.rel === 'provide_evidence');

// The structured record the drafter and the second key work from. It holds no free text from outside:
// no client notes, no file names, no buyer words. PayPal's own codes are checked before they go in.
async function jobRecord(q: Query, ms: any, dp: any, buyerFields: BuyerFields): Promise<JobRecord> {
  const job = (await q('SELECT title FROM jobs WHERE id = $1', [ms.job_id])).rows[0];
  const cap = (await q('SELECT id, gross, status FROM captures WHERE milestone_id = $1', [ms.id])).rows[0];
  const acc = (await q('SELECT accepted_by, accepted_at, mandate_id, file_hashes FROM acceptances WHERE milestone_id = $1', [ms.id])).rows[0];
  const files = (await q('SELECT id, sha256, criterion_id, uploaded_at FROM evidence_files WHERE milestone_id = $1 ORDER BY uploaded_at', [ms.id])).rows;
  const changes = (await q('SELECT round, criterion_id, created_at FROM change_requests WHERE milestone_id = $1 ORDER BY round', [ms.id])).rows;
  return {
    job: { title: job.title },
    milestone: { id: ms.id, title: ms.title, kind: ms.kind, amount: ms.amount, criteria: ms.criteria, revisionRoundsUsed: ms.revision_round, revisionRoundsAgreed: ms.max_revisions },
    capture: cap ? { id: cap.id, gross: cap.gross, status: cap.status } : null,
    acceptance: acc ? { by: acc.accepted_by, at: iso(acc.accepted_at)!, underMandate: !!acc.mandate_id, fileHashes: acc.file_hashes } : null,
    files: files.map((f: any) => ({ id: f.id, sha256: f.sha256, criterionId: f.criterion_id, uploadedAt: iso(f.uploaded_at)! })),
    changeRequests: changes.map((c: any) => ({ round: c.round, criterionId: c.criterion_id, at: iso(c.created_at)! })),
    dispute: {
      id: dp.dispute_id,
      reason: CODE.test(dp.reason ?? '') ? dp.reason : 'OTHER',
      stage: CODE.test(dp.dispute_life_cycle_stage ?? '') ? dp.dispute_life_cycle_stage : 'UNKNOWN',
      amount: String(dp.dispute_amount?.value ?? ''),
      currency: String(dp.dispute_amount?.currency_code ?? ''),
      respondBy: iso(dp.seller_response_due_date),
      requestedEvidence: (dp.evidences ?? []).filter((e: any) => e.source === 'REQUESTED_FROM_SELLER' && CODE.test(e.evidence_type ?? '')).map((e: any) => e.evidence_type),
      canProvideEvidence: canEvidence(dp),
      disputedCaptureId: dp.disputed_transactions?.[0]?.seller_transaction_id ?? null,
      buyerFields,
    },
  };
}

async function draftView(q: Query, r: any): Promise<DefenceDraft> {
  const ids: string[] = r.cited_file_ids ?? [];
  const files = ids.length ? (await q('SELECT id, filename, sha256 FROM evidence_files WHERE id = ANY($1)', [ids])).rows : [];
  return {
    id: r.id, disputeId: r.dispute_id, status: r.status, evidenceType: r.evidence_type, notes: r.notes,
    citedFiles: files.map((f: any) => ({ id: f.id, filename: f.filename, sha256: f.sha256 })),
    buyerFields: r.buyer_fields, verdict: r.verdict, createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at),
  };
}

async function defenceDispute(q: Query, msId: string) {
  return (await q('SELECT * FROM disputes WHERE milestone_id = $1 ORDER BY updated_at DESC LIMIT 1', [msId])).rows[0] ?? null;
}

async function defenceState(q: Query, disputeId: string | null) {
  if (!disputeId) return { draft: null, attemptsLeft: 0 };
  const { rows } = await q('SELECT * FROM dispute_drafts WHERE dispute_id = $1 ORDER BY created_at DESC', [disputeId]);
  return { draft: rows[0] ? await draftView(q, rows[0]) : null, attemptsLeft: Math.max(0, MAX_ATTEMPTS - rows.length) };
}

async function getDefence(d: Deps, req: Request, msId: string) {
  const ms = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, ms.job_id, ['freelancer']);
  return json(200, await defenceState(d.db.query, (await defenceDispute(d.db.query, msId))?.id ?? null));
}

async function draftDefence(d: Deps, req: Request, msId: string) {
  const ms = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, ms.job_id, ['freelancer']);
  if (!d.llm) throw new HttpError(503, 'the AI is not set up yet');
  const row = await defenceDispute(d.db.query, msId);
  if (!row) throw new HttpError(409, 'there is no dispute on this milestone');
  const state = await defenceState(d.db.query, row.id);
  if (state.draft?.status === 'filed') throw new HttpError(409, 'evidence was already filed on this dispute');
  if (state.draft?.status === 'ready') return json(200, state); // already waiting for the tap: spends nothing
  if (state.attemptsLeft === 0) throw new HttpError(409, `all ${MAX_ATTEMPTS} attempts on this dispute are used; answer it directly in PayPal`);

  // No database transaction is held while the models run.
  const dp = await d.paypal.call('GET', `/v1/customer/disputes/${encodeURIComponent(row.id)}`);
  const id = newId('dft');
  const now = d.now?.() ?? new Date();
  let fields: BuyerFields | null = null;
  let action: ProposedAction | null = null;
  let verdict: DefenceVerdict;
  const log: [string, string, string, string, string | null][] = [];
  try {
    fields = await readUntrusted(d.llm, buyerTexts(dp), ms.criteria);
    log.push(['haiku', 'read the buyer\'s text into fixed fields', 'n/a', `complaint ${fields.complaint}; instructions to AI: ${fields.containsInstructionsToAi}`, MODELS.reader]);
    const record = await jobRecord(d.db.query, ms, dp, fields);
    action = await draftResponse(d.llm, record);
    log.push(['sonnet', 'drafted an evidence note', 'n/a', `${action.evidenceType}, ${action.citedFileIds.length} file(s) cited`, MODELS.drafter]);
    const broken = checkRules(action, record, now);
    if (broken.length) {
      verdict = denied(`Stopped by the rules: ${broken.join('; ')}.`, 'rules');
      log.push(['system', 'rules check', 'deny', broken.join('; '), null]);
    } else {
      verdict = await secondKey(d.llm, action, record);
      log.push(['opus_second_key', 'reviewed the proposed filing', verdict.decision, verdict.reason, MODELS.second_key]);
    }
  } catch (e) {
    console.error(e);
    verdict = denied('The AI could not finish, so nothing can be filed from this attempt.', 'system');
    log.push(['system', 'AI failure', 'deny', e instanceof Error ? e.message.slice(0, 300) : 'error', null]);
  }
  const status: DefenceStatus = verdict.decision === 'approve' ? 'ready' : verdict.decision === 'escalate' ? 'escalated' : 'denied';
  const out = await d.db.transaction(async (q) => {
    await q('INSERT INTO dispute_drafts (id, dispute_id, milestone_id, status, evidence_type, notes, cited_file_ids, buyer_fields, verdict) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, row.id, msId, status, action?.evidenceType ?? null, action?.notes ?? null, JSON.stringify(action?.citedFileIds ?? []), fields && JSON.stringify(fields), JSON.stringify(verdict)]);
    if (fields) await q('UPDATE disputes SET buyer_text_fields = $2 WHERE id = $1', [row.id, JSON.stringify(fields)]);
    for (const [actor, what, decision, reason, model] of log) await auditModel(q, actor, what, msId, decision, reason, model, { draftId: id });
    return defenceState(q, row.id);
  });
  return json(201, out);
}

// The person's tap. Everything is checked again here: the draft could be days old by now.
async function fileDefence(d: Deps, req: Request, msId: string) {
  const first = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, first.job_id, ['freelancer']);
  const { draftId } = await body(req);
  const result = await d.db.transaction(async (q) => {
    const r = (await q('SELECT * FROM dispute_drafts WHERE id = $1 AND milestone_id = $2 FOR UPDATE', [String(draftId), msId])).rows[0];
    if (!r) throw new HttpError(404, 'draft not found');
    if (r.status === 'filed') return { draft: await draftView(q, r) }; // repeated tap: nothing to do
    if (r.status !== 'ready') throw new HttpError(409, `this draft cannot be filed (${r.status})`);
    const dp = await d.paypal.call('GET', `/v1/customer/disputes/${encodeURIComponent(r.dispute_id)}`);
    if (!canEvidence(dp)) throw new HttpError(409, 'PayPal is not accepting evidence on this dispute now');
    const acc = (await q('SELECT file_hashes FROM acceptances WHERE milestone_id = $1', [msId])).rows[0];
    const files = r.cited_file_ids.length ? (await q('SELECT id, mime_type, sha256, bytes FROM evidence_files WHERE id = ANY($1) AND milestone_id = $2', [r.cited_file_ids, msId])).rows : [];
    const stored = new Set<string>(acc?.file_hashes ?? []);
    const swapped = files.length !== r.cited_file_ids.length
      || files.some((f: any) => !stored.has(f.sha256) || createHash('sha256').update(Buffer.from(f.bytes)).digest('hex') !== f.sha256);
    if (swapped) {
      await q("UPDATE dispute_drafts SET status = 'denied', decided_at = now(), verdict = $2 WHERE id = $1",
        [r.id, JSON.stringify(denied('A cited file no longer matches what the client accepted.', 'rules'))]);
      await auditModel(q, 'system', 'filing refused', msId, 'deny', 'a cited file no longer matches what the client accepted', null, { draftId: r.id });
      return { draft: await draftView(q, (await q('SELECT * FROM dispute_drafts WHERE id = $1', [r.id])).rows[0]), refused: true };
    }
    const form = new FormData();
    let bytes = 0;
    const notAttached: string[] = [];
    for (const f of files) {
      const ext = ATTACHABLE[f.mime_type];
      const b = Buffer.from(f.bytes);
      if (!ext || bytes + b.length > MAX_EVIDENCE_BYTES) { notAttached.push(f.sha256); continue; }
      bytes += b.length;
      // Named by fingerprint: the original file name is untrusted text.
      form.append(`evidence_file_${f.sha256.slice(0, 8)}`, new Blob([b], { type: f.mime_type }), `delivery-${f.sha256.slice(0, 12)}.${ext}`);
    }
    let notes: string = r.notes;
    for (const sha of notAttached) {
      const line = `\nDelivered and accepted file, SHA-256 ${sha}.`;
      if (notes.length + line.length <= MAX_FILED_NOTE) notes += line;
    }
    form.append('input', new Blob([JSON.stringify({ evidences: [{ evidence_type: r.evidence_type, notes }] })], { type: 'application/json' }));
    await d.paypal.postForm(`/v1/customer/disputes/${encodeURIComponent(r.dispute_id)}/provide-evidence`, form, `evidence-${r.id}`);
    await q("UPDATE dispute_drafts SET status = 'filed', decided_at = now() WHERE id = $1", [r.id]);
    await auditModel(q, 'freelancer', 'evidence filed with PayPal', msId, 'approve', `${files.length - notAttached.length} file(s) attached`, null, { draftId: r.id, disputeId: r.dispute_id });
    return { draft: await draftView(q, (await q('SELECT * FROM dispute_drafts WHERE id = $1', [r.id])).rows[0]) };
  });
  if ('refused' in result) return json(409, { error: 'a cited file no longer matches what the client accepted', draft: result.draft });
  return json(200, result);
}

async function rejectDefence(d: Deps, req: Request, msId: string) {
  const first = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, first.job_id, ['freelancer']);
  const { draftId } = await body(req);
  const draft = await d.db.transaction(async (q) => {
    const r = (await q('SELECT * FROM dispute_drafts WHERE id = $1 AND milestone_id = $2 FOR UPDATE', [String(draftId), msId])).rows[0];
    if (!r) throw new HttpError(404, 'draft not found');
    if (r.status !== 'ready' && r.status !== 'escalated') throw new HttpError(409, `this draft cannot be rejected (${r.status})`);
    await q("UPDATE dispute_drafts SET status = 'rejected', decided_at = now() WHERE id = $1", [r.id]);
    await auditModel(q, 'freelancer', 'draft rejected', msId, 'deny', 'turned down by the freelancer', null, { draftId: r.id });
    return draftView(q, (await q('SELECT * FROM dispute_drafts WHERE id = $1', [r.id])).rows[0]);
  });
  return json(200, { draft });
}

// ---- console ------------------------------------------------------------------------------------

async function ledger(d: Deps, req: Request, url: URL) {
  const jobId = url.searchParams.get('jobId');
  if (!jobId) throw new HttpError(400, 'jobId is required');
  await authJob(d.db.query, req, jobId, ['freelancer']);
  const { rows } = await d.db.query(`
    SELECT m.id, m.job_id, j.title AS job_title, m.position, m.kind, m.title, m.amount, m.status, m.review_state, m.revision_round,
      m.paypal_order_id, m.status_changed_at,
      (SELECT a.id FROM authorizations a WHERE a.milestone_id = m.id ORDER BY a.created_at DESC LIMIT 1) AS authorization_id,
      c.id AS capture_id, c.paypal_fee, c.net,
      (SELECT dp.id FROM disputes dp WHERE dp.milestone_id = m.id ORDER BY dp.updated_at DESC LIMIT 1) AS dispute_id,
      (SELECT dp.status FROM disputes dp WHERE dp.milestone_id = m.id ORDER BY dp.updated_at DESC LIMIT 1) AS dispute_status
    FROM milestones m JOIN jobs j ON j.id = m.job_id LEFT JOIN captures c ON c.milestone_id = m.id
    WHERE m.job_id = $1 ORDER BY m.position`, [jobId]);
  const out: LedgerRow[] = rows.map((r: any) => ({
    milestoneId: r.id, jobId: r.job_id, jobTitle: r.job_title, position: r.position, kind: r.kind, title: r.title, amount: r.amount,
    reviewState: r.review_state, revisionRound: r.revision_round,
    status: r.status, statusLabel: STATUS_LABEL[r.status as MilestoneStatus], orderId: r.paypal_order_id,
    authorizationId: r.authorization_id, captureId: r.capture_id, fee: r.paypal_fee, net: r.net,
    disputeId: r.dispute_id, disputeStatus: r.dispute_status, updatedAt: iso(r.status_changed_at)!,
  }));
  return json(200, { rows: out });
}

async function auditRoute(d: Deps, req: Request, url: URL) {
  const msId = url.searchParams.get('milestoneId');
  if (!msId) throw new HttpError(400, 'milestoneId is required');
  const ms = await loadMilestone(d.db.query, msId);
  await authJob(d.db.query, req, ms.job_id, ['freelancer']);
  const { rows } = await d.db.query('SELECT at, actor, action, decision, reason, model FROM audit_log WHERE milestone_id = $1 ORDER BY id', [msId]);
  return json(200, { rows: rows.map((r: any) => ({ ...r, at: iso(r.at) })) });
}

// ---- router -------------------------------------------------------------------------------------

export function createHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '').split('/').slice(1); // ['api', ...]
    const m = req.method;
    try {
      if (p[0] !== 'api') throw new HttpError(404, 'not found');
      const [, a, id, sub, step] = p;
      if (a === 'health' && m === 'GET') return json(200, { ok: true });
      if (a === 'milestones' && id && sub === 'defence') {
        if (!step && m === 'GET') return await getDefence(deps, req, id);
        if (!step && m === 'POST') return await draftDefence(deps, req, id);
        if (step === 'file' && m === 'POST') return await fileDefence(deps, req, id);
        if (step === 'reject' && m === 'POST') return await rejectDefence(deps, req, id);
      }
      if (a === 'jobs' && !id && m === 'POST') return await createJob(deps, req);
      if (a === 'jobs' && id && !sub && m === 'GET') return await getJob(deps, req, id);
      if (a === 'jobs' && id && sub === 'mandates' && m === 'POST') return await createMandate(deps, req, id);
      if (a === 'milestones' && id && m === 'POST') {
        if (sub === 'request-payment') return await requestPayment(deps, req, id);
        if (sub === 'files') return await uploadFile(deps, req, id);
        if (sub === 'request-changes') return await requestChanges(deps, req, id);
        if (sub === 'accept') return await accept(deps, req, id);
        if (sub === 'void') return await voidMilestone(deps, req, id);
      }
      if (a === 'paypal' && id === 'return' && m === 'GET') return await paypalReturn(deps, url);
      if (a === 'paypal' && id === 'webhook' && m === 'POST') return await paypalWebhook(deps, req);
      if (a === 'ledger' && m === 'GET') return await ledger(deps, req, url);
      if (a === 'audit' && m === 'GET') return await auditRoute(deps, req, url);
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      if (e instanceof PaypalError) {
        console.error(e.message);
        return json(502, { error: `PayPal said ${e.issue}`, debugId: e.debugId });
      }
      console.error(e);
      return json(500, { error: 'internal error' });
    }
  };
}
