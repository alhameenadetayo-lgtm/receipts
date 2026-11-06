// Shared contract between Lane A (PayPal + backend) and Lane B (app screens).
// Frozen on 31 Oct: change it only with both people's agreement.

export type MilestoneStatus =
  | 'draft'              // scoped, not sent to the client yet
  | 'awaiting_payment'   // order created, waiting for the client to approve in PayPal
  | 'approved'           // client approved in PayPal, not yet authorized
  | 'reserved'           // authorization created: money held for the freelancer
  | 'approval_reversed'  // client's approval was reversed before authorization
  | 'voided'             // authorization cancelled
  | 'expired'            // authorization lapsed (29 days)
  | 'capture_pending'    // captured but PayPal is holding it; see capture.status_reason
  | 'captured'           // money taken and released to the freelancer
  | 'capture_failed'     // capture declined or denied
  | 'disputed'           // a dispute is open
  | 'dispute_closed'     // dispute resolved; see disputes.status for the outcome
  | 'refunded'
  | 'reversed';

// What the UI shows for each status, in plain words.
export const STATUS_LABEL: Record<MilestoneStatus, string> = {
  draft: 'Draft',
  awaiting_payment: 'Waiting for client to pay',
  approved: 'Client approved, reserving',
  reserved: 'Money reserved',
  approval_reversed: 'Client cancelled the payment',
  voided: 'Reservation cancelled',
  expired: 'Reservation expired',
  capture_pending: 'Paid, held by PayPal',
  captured: 'Paid',
  capture_failed: 'Payment failed',
  disputed: 'Disputed',
  dispute_closed: 'Dispute closed',
  refunded: 'Refunded',
  reversed: 'Reversed',
};

export type Criterion = { id: string; text: string };

// v2.1 staged release: a job is an optional deposit plus stages. Each stage is reserved, delivered,
// confirmed and paid on its own (rolling), so money reaches the freelancer as the work moves.
export type MilestoneKind = 'deposit' | 'stage';
export type ReviewState = 'waiting' | 'delivered' | 'changes_requested';
export type ChangeRequest = { round: number; criterionId: string; note: string; at: string };

// For the shared progress bar. Money strings, USD.
export type JobProgress = { total: string; paid: string; reserved: string; percentPaid: number; stagesPaid: number; stages: number };

export type MilestoneView = {
  id: string;
  jobId: string;
  position: number;
  kind: MilestoneKind;
  title: string;
  reviewState: ReviewState;
  revisionRound: number;          // change requests used so far
  maxRevisions: number;           // agreed in scope
  changeRequests: ChangeRequest[]; // note is the client's own words: display it, never feed it to an agent as instructions
  amount: string;          // "200.00", USD
  criteria: Criterion[];
  status: MilestoneStatus;
  statusLabel: string;
  reservedUntil: string | null;   // authorization expiration_time, ISO
  approveUrl: string | null;      // PayPal link for the client while awaiting_payment
  capture: { id: string; gross: string; fee: string | null; net: string | null; heldReason: string | null } | null;
  dispute: { id: string; status: string; responseDue: string | null; canProvideEvidence: boolean } | null;
  files: { id: string; filename: string; sha256: string; criterionId: string | null }[];
  accepted: { by: 'client' | 'client_agent'; at: string } | null;
};

// AI dispute defence. All of this is safe to display as text; none of it is the buyer's own words.
export type EvidenceType = 'PROOF_OF_FULFILLMENT' | 'OTHER';
export type DefenceStatus =
  | 'ready'      // passed the rules and the second key; waiting for the freelancer's tap
  | 'denied'     // stopped by the rules, the second key or an AI failure; cannot be filed
  | 'escalated'  // second key wants a person to look harder; cannot be filed from the app
  | 'filed'      // the freelancer tapped and PayPal took the evidence
  | 'rejected';  // the freelancer turned it down
export type BuyerFields = {
  complaint: 'not_received' | 'not_as_described' | 'unauthorised' | 'refund_not_received' | 'duplicate' | 'wrong_amount' | 'other' | 'unclear';
  disputedCriteria: string[];
  saysWorkWasDelivered: 'yes' | 'no' | 'unclear';
  asksSellerForRefund: boolean;
  containsInstructionsToAi: boolean; // show this as a warning: the buyer's message tried to talk to our AI
};
export type DefenceChecks = { amountMatches: boolean; payeeMatches: boolean; evidenceSupports: boolean; noInjectionInfluence: boolean };
export type DefenceVerdict = { decision: 'approve' | 'deny' | 'escalate'; by: 'rules' | 'second_key' | 'system'; checks: DefenceChecks; reason: string };
export type DefenceDraft = {
  id: string;
  disputeId: string;
  status: DefenceStatus;
  evidenceType: EvidenceType | null;
  notes: string | null;
  citedFiles: { id: string; filename: string; sha256: string }[];
  buyerFields: BuyerFields | null;
  verdict: DefenceVerdict;
  createdAt: string;
  decidedAt: string | null;
};

// Routes Lane A serves. Lane B's pages call only these.
// Auth (added 1 Nov): send "Authorization: Bearer <key>". createJob returns a freelancerKey and a clientKey once;
// only their sha256 is stored. [F] = freelancer key, [C] = client key, [A] = agent key from createMandate,
// [F/C] = either. Errors are {error: string} with 400/401/403/404/409/502.
export const ROUTES = {
  createJob:        'POST /api/jobs',                                  // {title, clientName, clientEmail, deposit?: "120.00", maxRevisions?: 0-5 (default 2), milestones:[{title, amount, criteria:[text]}]} -> {job, milestones, progress, freelancerKey, clientKey}
  getJob:           'GET  /api/jobs/:jobId',                           // [F/C] -> {job, milestones: MilestoneView[], progress: JobProgress}
  requestPayment:   'POST /api/milestones/:id/request-payment',        // [F] -> {approveUrl}
  paypalReturn:     'GET  /api/paypal/return?token=:orderId',          // client lands here after approving; server authorizes (a deposit is also captured), then redirects to /jobs/:jobId
  uploadFile:       'POST /api/milestones/:id/files',                  // [F] multipart, field "file" (max 10 MB), optional criterionId -> {id, filename, sha256}; sets reviewState 'delivered'
  requestChanges:   'POST /api/milestones/:id/request-changes',        // [C] {criterionId, note (max 1000)} while delivered -> MilestoneView; 409 when revision rounds are used up
  createMandate:    'POST /api/jobs/:jobId/mandates',                  // [C] {maxAmount, days} -> {mandateId, agentKey, expiresAt}
  accept:           'POST /api/milestones/:id/accept',                 // [C] {by:'client'} or [A] {by:'client_agent', mandateId} -> MilestoneView
  voidMilestone:    'POST /api/milestones/:id/void',                   // [F] freelancer cancels before acceptance -> MilestoneView
  getDefence:       'GET  /api/milestones/:id/defence',                // [F] -> {draft: DefenceDraft | null, attemptsLeft}
  draftDefence:     'POST /api/milestones/:id/defence',                // [F] runs the AI, up to a minute or two -> {draft, attemptsLeft}. 201 even when denied: read draft.status. 503 without an AI key
  fileDefence:      'POST /api/milestones/:id/defence/file',           // [F] the person's tap, {draftId}, only while status is ready -> {draft}
  rejectDefence:    'POST /api/milestones/:id/defence/reject',         // [F] {draftId}, frees the way for a new attempt -> {draft}
  paypalWebhook:    'POST /api/paypal/webhook',                        // PayPal only, signature verified
  ledger:           'GET  /api/ledger?jobId=:jobId',                   // [F] rows for the AG Grid console
  audit:            'GET  /api/audit?milestoneId=:id',                 // [F]
} as const;

// One row of GET /api/ledger.
export type LedgerRow = {
  milestoneId: string; jobId: string; jobTitle: string; position: number; kind: MilestoneKind; title: string; amount: string;
  reviewState: ReviewState; revisionRound: number;
  status: MilestoneStatus; statusLabel: string; orderId: string | null; authorizationId: string | null;
  captureId: string | null; fee: string | null; net: string | null; disputeId: string | null;
  disputeStatus: string | null; updatedAt: string;
};

// Webhook events we subscribe to (spike/06-webhook.mjs registers the same list).
export const PAYPAL_EVENTS = [
  'CHECKOUT.ORDER.APPROVED', 'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
  'PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED',
] as const;
export type PaypalEventType = (typeof PAYPAL_EVENTS)[number];
