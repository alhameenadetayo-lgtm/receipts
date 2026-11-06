# Receipts

Work in progress for the PayPal AI Hackathon. The public README is written at the end and humanised before submission.

## For the team

- `db/schema.sql`: the Postgres ledger.
- `lib/contract.ts`: the shared contract between the PayPal backend and the app screens. Change it only when both of us agree.
- `lib/ledger.ts`, `lib/webhook.ts`: payment state machine and PayPal webhook verification.
- `lib/api.ts`: every backend route, as one `handle(Request) -> Response` function. In Next.js, serve it from `app/api/[...path]/route.ts` with `export const GET = handle, POST = handle`. Without Next.js, `npm start` runs `server.ts`.
- `lib/paypal.ts`, `lib/db.ts`: PayPal client and database adapters (node-postgres in production, PGlite in tests).
- `lib/defence.ts`: AI dispute defence. Haiku reads the buyer's text into fixed fields, Sonnet drafts from those fields and the job record, fixed rules and Opus at high effort review it, and only the freelancer's tap files it. `db/defence.sql` runs on every server start. `spike/08-redteam-live.ts` runs the attack strings in `test/attacks.ts` against the real models.
- `spike/`: step-by-step PayPal sandbox scripts. Copy `.env.example` to `.env` first. `spike/07-live-check.ts` runs the backend against the sandbox without moving money.
- Live API (sandbox): https://receipts-api-2n1g.onrender.com, deployed from `main` by `render.yaml`. The free server sleeps when idle, so the first call can take up to a minute. The PayPal webhook points at `/api/paypal/webhook`. The free Postgres expires on 2 Dec 2026: upgrade it before judging.
- Tests: `npm test` (Node 22.18 or newer). The "system cannot find the path" lines on Windows come from PGlite and are harmless.

Never commit `.env` or paste keys into chat. Share PayPal and Anthropic keys through a password manager.
