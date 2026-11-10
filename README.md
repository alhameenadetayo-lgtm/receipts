# Receipts

Freelance jobs paid stage by stage with PayPal. Each stage's money is held until the client accepts the work, every delivered file gets a fingerprint, and if a payment is disputed, AI drafts the evidence from the record while the freelancer decides whether to file it.

Built for the PayPal AI Hackathon. Everything runs on PayPal's sandbox, so no real money moves.

**Live demo:** https://receipts-web-01ou.onrender.com

The demo runs on Render's free plan. If nobody has used it for a while, the first page can take up to a minute to load while the server wakes up.

## Try it

1. Open the demo and scope a job: an optional deposit, then stages with a price and a list of checks each. The page estimates PayPal's fees before anything is sent.
2. You get two private links, one for you and one for your client. Open the client link in another browser or a private window.
3. As the client, pay the deposit and approve each stage's payment with a PayPal sandbox buyer account. The login is in the Devpost submission text. PayPal holds the money without taking it.
4. As the freelancer, deliver files against the agreed checks. Each file gets a SHA-256 fingerprint when it is uploaded.
5. As the client, accept the stage. Accepting captures the payment. Cancelling instead voids the hold and the client is not charged.
6. Open the Console for the ledger of every payment with its PayPal ids, and the Trust Packet for a printable record of what was agreed, delivered, accepted and paid.

## What it does

- **Staged payments.** PayPal Orders v2 with the AUTHORIZE intent: a stage is authorized when the client approves, captured when they accept, and voided if the freelancer cancels.
- **Proof of delivery.** Each uploaded file is fingerprinted, and each acceptance records who accepted it and when.
- **Agent acceptance.** A client can let their own AI agent accept stages for them, with a cap per stage and an expiry. The agent gets its own key that can only accept, and one button cancels every agent permission on the job.
- **AI dispute defence.** When the buyer opens a PayPal dispute, the freelancer presses "Draft my defence". Three Claude models and a set of fixed rules check each other, and nothing reaches PayPal until the freelancer presses File.
- **A record of everything.** The console, built with AG Grid, shows a reason for every decision.

## How the dispute defence resists prompt injection

The buyer's dispute message is the one input anyone can write anything into, including orders aimed at an AI. So we keep it away from anything that can act.

1. **Claude Haiku reads it with no tools.** It can only fill in a few fixed answers: the kind of complaint, whether the buyer admits receiving the work, whether they want a refund, and whether the message tries to give orders to an AI.
2. **Claude Sonnet writes the evidence note** from the job record only: the agreed checks, file fingerprints, who accepted and when, and the PayPal capture. It never sees the buyer's words.
3. **Plain code checks the draft.** Evidence only, the right dispute and capture, no links, only files the client accepted, and before PayPal's deadline.
4. **Claude Opus reviews the filing** against the record, on a second key. A refusal, an error or an answer in the wrong shape all count as no.
5. **The freelancer decides.** The note and accepted files go to PayPal's provide-evidence endpoint only after they press File.

Each dispute gets three AI attempts. `test/attacks.ts` holds 20 injection strings, and `spike/08-redteam-live.ts` runs them against the real models.

## Run it yourself

You need Node 24 (22.18 or newer works for the backend), a Postgres database, a free PayPal sandbox app, and optionally an Anthropic API key.

```bash
git clone https://github.com/alhameenadetayo-lgtm/receipts.git
cd receipts
npm install
cp .env.example .env
```

Fill in `.env`:

| Name | What it is |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | From developer.paypal.com, Apps and Credentials, Sandbox, a Merchant app |
| `DATABASE_URL` | A Postgres connection string. Tables are created on first start |
| `APP_URL` | The public https address of the screens, used for PayPal return links |
| `PAYPAL_WEBHOOK_ID` | Optional. Filled in after you register a webhook with `node spike/06-webhook.mjs register` |
| `ANTHROPIC_API_KEY` | Optional. Without it the dispute defence answers 503 and everything else works |

Start the backend:

```bash
npm start
```

Start the screens in a second terminal. They proxy `/api` to the backend:

```bash
cd web
npm install
API_ORIGIN=http://localhost:3001 npm run dev
```

Open http://localhost:3000.

Never commit `.env`. It is already in `.gitignore`.

## Tests

```bash
npm test
```

There are 49 tests, running against an in-memory Postgres (PGlite), so they need no database or keys. They cover the payment state machine, webhook verification, the API routes and the dispute defence including the injection strings. On Windows, "system cannot find the path" lines come from PGlite and are harmless.

## How it is built

- `server.ts`: a plain Node server around one `handle(Request) -> Response` function.
- `lib/api.ts`: every backend route. `lib/contract.ts` is the shared contract with the screens.
- `lib/ledger.ts`, `lib/webhook.ts`: the payment state machine and PayPal webhook verification. The app re-reads the resource from PayPal before acting on a webhook.
- `lib/paypal.ts`, `lib/db.ts`: the PayPal client and the database adapters.
- `lib/defence.ts`: the AI dispute defence.
- `db/`: the Postgres schema.
- `web/`: the Next.js screens.
- `spike/`: step-by-step PayPal sandbox scripts, one per API we use.

There are no accounts. Creating a job returns a freelancer key and a client key once, and the server keeps only their hashes. Links carry the key after the `#`, which browsers never send to a server.

## Licence

MIT. See [LICENSE](LICENSE).
