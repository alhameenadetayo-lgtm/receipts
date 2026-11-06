# Receipts screens (Lane B)

Next.js app with the screens for Receipts. It only calls the routes in `../lib/contract.ts`, and it imports the contract's types directly. The contract itself is not changed.

| Page | Who | What |
|---|---|---|
| `/` | freelancer | Scope a job: deposit, stages, acceptance criteria, revision rounds, fee preview. Creates the job and gives the private client link. |
| `/jobs/:id` | both | Shared progress bar. Freelancer: request payment, deliver files matched to criteria, cancel before acceptance. Client: pay or reserve in PayPal, accept, request changes, create an agent mandate. |
| `/console` | freelancer | AG Grid ledger (`GET /api/ledger`), click a row for its audit trail (`GET /api/audit`). |
| `/jobs/:id/packet` | both | Trust Packet: scope, criteria, delivered files with SHA-256, acceptances, PayPal ids, audit trail (freelancer). Prints or saves as PDF. |

## How it talks to the backend

The browser calls `/api/*` on this app's own address, and Next.js rewrites those calls to the backend (`API_ORIGIN`, default `https://receipts-api-2n1g.onrender.com`). The browser never makes a cross-origin call, so the backend needs no CORS change.

Keys: `createJob` returns a freelancer key and a client key once. The freelancer key is kept in this browser's localStorage, and the job page offers a private backup link. The client key goes in the client link's `#fragment`, which browsers never send to a server. The job page checks a link's key with the backend, which also decides its role, and saves it only if the backend accepts it. So a crafted link can't replace a saved key.

## Run

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000. The free backend sleeps when idle, so the first call can take about a minute.

## Deploy

1. Deploy `web/` as its own Render web service: leave the root directory blank (the app imports `../lib/contract.ts`, and Render hides files outside a root directory), build `cd web && npm ci --include=dev && npm run build`, start `cd web && npm start`, env `NODE_VERSION=24`, `API_ORIGIN=https://receipts-api-2n1g.onrender.com`.
2. **Set the backend's `APP_URL` to this app's address.** The backend builds PayPal's return link from `APP_URL` (`/api/paypal/return`) and then redirects the client to `APP_URL/jobs/:id`. That page lives here, and the return call reaches the backend through the proxy.

## The client's agent (demo)

`scripts/client-agent.mts` is the client's own agent. The client's side reads the job with the client key and passes the agent only the stages waiting for review. The agent (Claude Sonnet 5.5) has one strict tool, `accept_stage`, which calls `POST /api/milestones/:id/accept` with `{by:'client_agent', mandateId}` and the agent's own key. The backend enforces the mandate's cap and expiry.

```bash
cd web
CLIENT_KEY=... AGENT_KEY=... MANDATE_ID=mdt_... ANTHROPIC_API_KEY=... node scripts/client-agent.mts <jobId> "Accept when every criterion has a file"
```

Add `--offline` to use a plain rule instead of Claude (no Anthropic credit needed).

## Not done yet

- AI dispute screens: waiting on alhameenadetayo-lgtm/receipts#2 and Anthropic credit.
- Sonnet-drafted stages on the scope page: needs a backend route, which isn't in the contract yet.
- Running the agent demo with real Claude (needs Anthropic credit).
