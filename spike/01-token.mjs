// Step 1: prove the credentials work and the app has the dispute scopes. Prints no secrets.
import { token } from './paypal.mjs';

const t = await token();
const scopes = t.scope.split(' ');
const need = [
  'https://uri.paypal.com/services/disputes/read-seller',
  'https://uri.paypal.com/services/disputes/update-seller',
];
console.log(`Token OK, expires in ${Math.round((t.expires - Date.now()) / 60000)} min, ${scopes.length} scopes.`);
for (const s of need) console.log(`${scopes.includes(s) ? 'OK     ' : 'MISSING'} ${s}`);
