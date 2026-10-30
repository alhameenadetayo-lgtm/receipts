// Milestone state machine. Pure functions: no database, no network, so they are easy to test.
// Webhooks can arrive late, twice or out of order, so a stale event never moves a milestone backwards.
import type { MilestoneStatus, PaypalEventType } from './contract.ts';

const TARGET: Record<PaypalEventType, MilestoneStatus | null> = {
  'CHECKOUT.ORDER.APPROVED': 'approved',
  'CHECKOUT.PAYMENT-APPROVAL.REVERSED': 'approval_reversed',
  'PAYMENT.AUTHORIZATION.CREATED': 'reserved',
  'PAYMENT.AUTHORIZATION.VOIDED': 'voided',
  'PAYMENT.CAPTURE.PENDING': 'capture_pending',
  'PAYMENT.CAPTURE.COMPLETED': 'captured',
  'PAYMENT.CAPTURE.DECLINED': 'capture_failed',
  'PAYMENT.CAPTURE.DENIED': 'capture_failed',
  'PAYMENT.CAPTURE.REFUNDED': 'refunded',
  'PAYMENT.CAPTURE.REVERSED': 'reversed',
  'CUSTOMER.DISPUTE.CREATED': 'disputed',
  'CUSTOMER.DISPUTE.UPDATED': null, // details change, status stays 'disputed'
  'CUSTOMER.DISPUTE.RESOLVED': 'dispute_closed',
};

// The states each target may be entered from. Anything else is stale or out of order.
const ALLOWED_FROM: Record<MilestoneStatus, MilestoneStatus[]> = {
  draft: [],
  awaiting_payment: ['draft'],
  approved: ['awaiting_payment'],
  approval_reversed: ['awaiting_payment', 'approved'],
  reserved: ['awaiting_payment', 'approved'], // the authorization event can beat the approval event
  voided: ['reserved'],
  expired: ['reserved'],
  capture_pending: ['reserved'],
  captured: ['reserved', 'capture_pending'],
  capture_failed: ['reserved', 'capture_pending'],
  disputed: ['captured', 'capture_pending'], // PayPal allows one dispute per transaction, ever
  dispute_closed: ['disputed'],
  refunded: ['captured', 'capture_pending', 'disputed', 'dispute_closed'],
  reversed: ['captured', 'disputed', 'dispute_closed'],
};

export type Transition = { status: MilestoneStatus; applied: boolean; reason: string };

export function applyEvent(current: MilestoneStatus, eventType: string): Transition {
  if (!(eventType in TARGET)) return { status: current, applied: false, reason: `unsubscribed event ${eventType}` };
  const target = TARGET[eventType as PaypalEventType];
  if (target === null) {
    return current === 'disputed'
      ? { status: current, applied: true, reason: 'dispute details updated' }
      : { status: current, applied: false, reason: `dispute update while ${current}` };
  }
  if (target === current) return { status: current, applied: false, reason: 'already in this state' };
  if (!ALLOWED_FROM[target].includes(current)) {
    return { status: current, applied: false, reason: `stale or out of order: ${current} -> ${target}` };
  }
  return { status: target, applied: true, reason: `${current} -> ${target}` };
}

// Moves the app's own actions (not webhooks) through the same rules.
export function canTransition(from: MilestoneStatus, to: MilestoneStatus): boolean {
  return ALLOWED_FROM[to].includes(from);
}

// Authorizations last 29 days; capture is only promised for the first 3 (the honour period).
export function reservationState(expirationTime: string, createdAt: string, now: Date): 'honoured' | 'needs_reauthorize' | 'expired' {
  const exp = Date.parse(expirationTime);
  if (now.getTime() >= exp) return 'expired';
  const honourEnds = Date.parse(createdAt) + 3 * 24 * 60 * 60 * 1000;
  return now.getTime() < honourEnds ? 'honoured' : 'needs_reauthorize';
}
