// Step 5: read disputes. No args: list them. With an id: show status and whether evidence can be filed now.
import { api } from './paypal.mjs';

const id = process.argv[2];
if (!id) {
  const list = await api('GET', '/v1/customer/disputes?page_size=10');
  for (const d of list.items || []) {
    console.log(`${d.dispute_id}  ${d.status}  ${d.reason}  $${d.dispute_amount?.value}  ${d.create_time}`);
  }
  if (!list.items?.length) console.log('No disputes yet. They can take a few minutes to appear after filing.');
} else {
  const d = await api('GET', `/v1/customer/disputes/${id}`);
  const rels = (d.links || []).map((l) => l.rel);
  console.log(`${d.dispute_id}: ${d.status}, stage ${d.dispute_life_cycle_stage}, reason ${d.reason}`);
  console.log(`Seller response due: ${d.seller_response_due_date || 'n/a'}`);
  console.log(`Actions available now: ${rels.join(', ') || 'none'}`);
  console.log(rels.includes('provide_evidence') ? 'Evidence can be filed now.' : 'Evidence cannot be filed yet.');
}
