# Receipts screens (Lane B)

Next.js app with the screens for Receipts. It only calls the routes in `../lib/contract.ts`, and it imports the contract's types directly. The contract itself is not changed.

| Page | Who | What |
|---|---|---|
| `/` | freelancer | Scope a job: deposit, stages, acceptance criteria, revision rounds, fee preview. Creates the job and gives the private client link. |
| `/jobs/:id` | both | Shared progress bar. Freelancer: request payment, deliver files matched to criteria, cancel before acceptance. Client: pay or reserve in PayPal, accept, request changes, create an agent mandate. |
| `/console` | freelancer | AG Grid ledger (`GET /api/ledger`), click a row for its audit trail (`GET /api/audit`). |

## How it talks to the backend

The browser calls `/api/*` on this app's own address, and Next.js rewrites those calls to the backend (`API_ORIGIN`, default `https://receipts-api-2n1g.onrender.com`). The browser never makes a cross-origin call, so the backend needs no CORS change.

Keys: `createJob` returns a freelancer key and a client key once. The freelancer key is kept in this browser's localStorage. The client key goes in the client link's `#fragment`, which browsers never send to a server; the job page saves it and removes it from the address bar.

## Run

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000. The free backend sleeps when idle, so the first call can take about a minute.

## Deploy

1. Deploy `web/` as its own Render web service: root directory `web`, build `npm ci && npm run build`, start `npm start`, env `API_ORIGIN=https://receipts-api-2n1g.onrender.com`.
2. **Set the backend's `APP_URL` to this app's address.** The backend builds PayPal's return link from `APP_URL` (`/api/paypal/return`) and then redirects the client to `APP_URL/jobs/:id`. That page lives here, and the return call reaches the backend through the proxy.

## Not done yet

- AI dispute screens: waiting on alhameenadetayo-lgtm/receipts#2 and Anthropic credit.
- Sonnet-drafted stages on the scope page: needs a backend route, which isn't in the contract yet.
- The client's-agent demo script and the Trust Packet page.
