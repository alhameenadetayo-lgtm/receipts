// Step 4: the client accepted the work, so capture the reserved money.
import { api, arg } from './paypal.mjs';

const authId = arg(0, 'authorizationId');
const cap = await api('POST', `/v2/payments/authorizations/${authId}/capture`, { final_capture: true }, { requestId: `capture-${authId}` });
console.log(`Capture ${cap.id}: ${cap.status}${cap.status_details ? ` (${cap.status_details.reason})` : ''}`);
const fee = cap.seller_receivable_breakdown;
if (fee) console.log(`Gross $${fee.gross_amount.value}, PayPal fee $${fee.paypal_fee?.value}, net $${fee.net_amount?.value}`);
console.log('Next: log in to sandbox.paypal.com as the CLIENT, open this payment, and report a problem to file a dispute.');
