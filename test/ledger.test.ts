import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, canTransition, reservationState } from '../lib/ledger.ts';

test('happy path: approve, reserve, capture', () => {
  let s = applyEvent('awaiting_payment', 'CHECKOUT.ORDER.APPROVED');
  assert.equal(s.status, 'approved');
  s = applyEvent(s.status, 'PAYMENT.AUTHORIZATION.CREATED');
  assert.equal(s.status, 'reserved');
  s = applyEvent(s.status, 'PAYMENT.CAPTURE.COMPLETED');
  assert.equal(s.status, 'captured');
});

test('authorization event can arrive before the approval event', () => {
  const s = applyEvent('awaiting_payment', 'PAYMENT.AUTHORIZATION.CREATED');
  assert.equal(s.status, 'reserved');
  const late = applyEvent(s.status, 'CHECKOUT.ORDER.APPROVED');
  assert.equal(late.status, 'reserved');
  assert.equal(late.applied, false);
});

test('a late authorization event never undoes a capture', () => {
  const s = applyEvent('captured', 'PAYMENT.AUTHORIZATION.CREATED');
  assert.deepEqual([s.status, s.applied], ['captured', false]);
});

test('duplicate delivery is a no-op', () => {
  const s = applyEvent('captured', 'PAYMENT.CAPTURE.COMPLETED');
  assert.deepEqual([s.status, s.applied], ['captured', false]);
});

test('held capture can complete later', () => {
  const s = applyEvent('capture_pending', 'PAYMENT.CAPTURE.COMPLETED');
  assert.equal(s.status, 'captured');
});

test('dispute lifecycle', () => {
  let s = applyEvent('captured', 'CUSTOMER.DISPUTE.CREATED');
  assert.equal(s.status, 'disputed');
  s = applyEvent(s.status, 'CUSTOMER.DISPUTE.UPDATED');
  assert.deepEqual([s.status, s.applied], ['disputed', true]);
  s = applyEvent(s.status, 'CUSTOMER.DISPUTE.RESOLVED');
  assert.equal(s.status, 'dispute_closed');
});

test('a second dispute on the same transaction is refused', () => {
  const s = applyEvent('dispute_closed', 'CUSTOMER.DISPUTE.CREATED');
  assert.equal(s.applied, false);
});

test('cannot capture a voided reservation', () => {
  assert.equal(applyEvent('voided', 'PAYMENT.CAPTURE.COMPLETED').applied, false);
  assert.equal(canTransition('voided', 'captured'), false);
});

test('unknown events are ignored, not thrown', () => {
  const s = applyEvent('reserved', 'BILLING.SUBSCRIPTION.CREATED');
  assert.deepEqual([s.status, s.applied], ['reserved', false]);
});

test('reservation honour period and expiry', () => {
  const created = '2026-10-30T10:00:00Z';
  const expires = '2026-11-28T10:00:00Z';
  assert.equal(reservationState(expires, created, new Date('2026-11-01T10:00:00Z')), 'honoured');
  assert.equal(reservationState(expires, created, new Date('2026-11-05T10:00:00Z')), 'needs_reauthorize');
  assert.equal(reservationState(expires, created, new Date('2026-11-28T10:00:00Z')), 'expired');
});
