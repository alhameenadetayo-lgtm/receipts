import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifyBody, readSignatureHeaders, verifyWebhook } from '../lib/webhook.ts';

const goodHeaders = new Headers({
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
  'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
  'paypal-transmission-sig': 'abc==',
  'paypal-transmission-time': '2026-10-30T10:00:00Z',
});
// Odd spacing and key order on purpose: verification must send these exact bytes.
const raw = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1","amount":{"value":"11.00"}}}';

test('raw body is spliced in byte-for-byte', () => {
  const body = buildVerifyBody(raw, readSignatureHeaders(goodHeaders), 'WH-ID');
  assert.ok(body.endsWith(`"webhook_event":${raw}}`));
  const parsed = JSON.parse(body);
  assert.equal(parsed.webhook_id, 'WH-ID');
  assert.equal(parsed.webhook_event.resource.id, 'CAP-1');
});

test('verified only on SUCCESS', async () => {
  const ok = await verifyWebhook(raw, goodHeaders, 'WH-ID', async () => ({ verification_status: 'SUCCESS' }));
  assert.equal(ok.ok, true);
  const bad = await verifyWebhook(raw, goodHeaders, 'WH-ID', async () => ({ verification_status: 'FAILURE' }));
  assert.equal(bad.ok, false);
});

test('fails closed when PayPal cannot be reached', async () => {
  const r = await verifyWebhook(raw, goodHeaders, 'WH-ID', async () => { throw new Error('timeout'); });
  assert.equal(r.ok, false);
});

test('missing signature headers are rejected without calling PayPal', async () => {
  let called = false;
  const r = await verifyWebhook(raw, new Headers(), 'WH-ID', async () => { called = true; return {}; });
  assert.deepEqual([r.ok, called], [false, false]);
});

test('cert url must be a paypal.com https url', () => {
  const evil = new Headers(goodHeaders);
  evil.set('paypal-cert-url', 'https://paypal.com.evil.example/cert');
  assert.throws(() => readSignatureHeaders(evil));
});

test('non-JSON body is rejected', async () => {
  const r = await verifyWebhook('not json', goodHeaders, 'WH-ID', async () => ({ verification_status: 'SUCCESS' }));
  assert.equal(r.ok, false);
});
