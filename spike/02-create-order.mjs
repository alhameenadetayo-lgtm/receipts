// Step 2: create one AUTHORIZE order for one milestone. Usage: node spike/02-create-order.mjs [amount]
import { api } from './paypal.mjs';

const amount = process.argv[2] || '11.00'; // $11 or more keeps the sandbox dispute path open
const milestone = `ms_${Date.now()}`;
const order = await api('POST', '/v2/checkout/orders', {
  intent: 'AUTHORIZE',
  purchase_units: [{
    custom_id: milestone,
    invoice_id: milestone,
    description: 'Receipts spike: logo design, milestone 1',
    amount: { currency_code: 'USD', value: amount },
  }],
  payment_source: {
    paypal: {
      experience_context: {
        user_action: 'CONTINUE',
        return_url: 'https://example.com/return',
        cancel_url: 'https://example.com/cancel',
      },
    },
  },
}, { requestId: `create-${milestone}` });

const approve = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
console.log(`Order ${order.id} (${order.status}), milestone ${milestone}`);
console.log(`Open this, log in as the sandbox CLIENT (personal) account and approve:\n${approve.href}`);
console.log('PayPal then sends you to example.com, which is expected.');
console.log(`Then run: node spike/03-authorize.mjs ${order.id}`);
