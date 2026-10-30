# Receipts

Work in progress for the PayPal AI Hackathon. The public README is written at the end and humanised before submission.

## For the team

- `db/schema.sql`: the Postgres ledger.
- `lib/contract.ts`: the shared contract between the PayPal backend and the app screens. Change it only when both of us agree.
- `lib/ledger.ts`, `lib/webhook.ts`: payment state machine and PayPal webhook verification.
- `spike/`: step-by-step PayPal sandbox scripts. Copy `.env.example` to `.env` first.
- Tests: `npm test` (Node 22.18 or newer).

Never commit `.env` or paste keys into chat. Share PayPal and Anthropic keys through a password manager.
