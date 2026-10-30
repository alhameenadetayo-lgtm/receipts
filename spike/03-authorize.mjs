// Step 3: after the client approves, authorize the order (money reserved, not taken).
import { api, arg } from './paypal.mjs';

const orderId = arg(0, 'orderId');
const order = await api('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, { requestId: `authorize-${orderId}` });
const auth = order.purchase_units[0].payments.authorizations[0];
console.log(`Authorization ${auth.id}: ${auth.status}, $${auth.amount.value}`);
console.log(`Expires: ${auth.expiration_time}. Capture within 3 days, or reauthorize after that.`);
console.log(`Then run: node spike/04-capture.mjs ${auth.id}`);
