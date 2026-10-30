// Step 6: register the sandbox webhook, or list existing ones.
// Usage: node spike/06-webhook.mjs register https://your-app.onrender.com/api/paypal/webhook
//        node spike/06-webhook.mjs
import { api, arg } from './paypal.mjs';

const EVENTS = [
  'PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'CHECKOUT.ORDER.APPROVED', 'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
  'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED',
];

if (process.argv[2] === 'register') {
  const url = arg(1, 'https-url');
  const hook = await api('POST', '/v1/notifications/webhooks', { url, event_types: EVENTS.map((name) => ({ name })) });
  console.log(`Webhook ${hook.id} registered. Add it to .env as PAYPAL_WEBHOOK_ID=${hook.id}`);
} else {
  const list = await api('GET', '/v1/notifications/webhooks');
  for (const h of list.webhooks || []) console.log(`${h.id}  ${h.url}  ${h.event_types.length} events`);
  if (!list.webhooks?.length) console.log('No webhooks registered yet.');
}
