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

export type MilestoneView = {
  id: string;
  jobId: string;
  position: number;
  title: string;
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

// Routes Lane A serves. Lane B's pages call only these.
export const ROUTES = {
  createJob:        'POST /api/jobs',                                  // {title, clientName, clientEmail, milestones:[{title, amount, criteria}]}
  getJob:           'GET  /api/jobs/:jobId',                           // -> {job, milestones: MilestoneView[]}
  requestPayment:   'POST /api/milestones/:id/request-payment',        // -> {approveUrl}
  paypalReturn:     'GET  /api/paypal/return?token=:orderId',          // client lands here after approving; server authorizes
  uploadFile:       'POST /api/milestones/:id/files',                  // multipart, field "file", optional criterionId
  accept:           'POST /api/milestones/:id/accept',                 // {by:'client'} or {by:'client_agent', mandateId}
  voidMilestone:    'POST /api/milestones/:id/void',                   // freelancer cancels before acceptance
  paypalWebhook:    'POST /api/paypal/webhook',                        // PayPal only
  ledger:           'GET  /api/ledger',                                // rows for the AG Grid console
  audit:            'GET  /api/audit?milestoneId=:id',
} as const;

// Webhook events we subscribe to (spike/06-webhook.mjs registers the same list).
export const PAYPAL_EVENTS = [
  'CHECKOUT.ORDER.APPROVED', 'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
  'PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED',
] as const;
export type PaypalEventType = (typeof PAYPAL_EVENTS)[number];
