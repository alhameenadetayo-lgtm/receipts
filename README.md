# Receipts

Work in progress for the PayPal AI Hackathon. The public README is written at the end and humanised before submission.

## For the team

- `db/schema.sql`: the Postgres ledger.
- `lib/contract.ts`: the shared contract between the PayPal backend and the app screens. Change it only when both of us agree.
- `lib/ledger.ts`, `lib/webhook.ts`: payment state machine and PayPal webhook verification.
- `lib/api.ts`: every backend route, as one `handle(Request) -> Response` function. In Next.js, serve it from `app/api/[...path]/route.ts` with `export const GET = handle, POST = handle`. Without Next.js, `npm start` runs `server.ts`.
- `lib/paypal.ts`, `lib/db.ts`: PayPal client and database adapters (node-postgres in production, PGlite in tests).
- `spike/`: step-by-step PayPal sandbox scripts. Copy `.env.example` to `.env` first. `spike/07-live-check.ts` runs the backend against the sandbox without moving money.
- Tests: `npm test` (Node 22.18 or newer). The "system cannot find the path" lines on Windows come from PGlite and are harmless.

Never commit `.env` or paste keys into chat. Share PayPal and Anthropic keys through a password manager.
