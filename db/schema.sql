-- Receipts ledger, Postgres. Append-only where it matters: webhook_events, acceptances, evidence_files, audit_log.
-- Money is stored as text decimals exactly as PayPal returns them ("11.00"), never as floats.

CREATE TABLE jobs (
  id            text PRIMARY KEY,                 -- job_...
  title         text NOT NULL,
  client_name   text NOT NULL,
  client_email  text NOT NULL,
  currency      text NOT NULL DEFAULT 'USD',
  freelancer_key_hash text NOT NULL,              -- sha256 of the freelancer's bearer key; the key itself is never stored
  client_key_hash     text NOT NULL,              -- sha256 of the client's bearer key
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE milestones (
  id                  text PRIMARY KEY,           -- ms_..., also PayPal custom_id and invoice_id
  job_id              text NOT NULL REFERENCES jobs(id),
  position            int  NOT NULL,
  title               text NOT NULL,
  amount              text NOT NULL,              -- "200.00"
  criteria            jsonb NOT NULL,             -- [{id, text}]
  status              text NOT NULL DEFAULT 'draft',
  paypal_order_id     text UNIQUE,
  approve_url         text,                       -- PayPal payer-action link while awaiting_payment
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, position)
);

-- One row per PayPal authorization; reauthorize creates a new row pointing at its parent.
CREATE TABLE authorizations (
  id                     text PRIMARY KEY,        -- PayPal authorization id
  milestone_id           text NOT NULL REFERENCES milestones(id),
  parent_authorization_id text REFERENCES authorizations(id),
  status                 text NOT NULL,           -- CREATED, CAPTURED, VOIDED, EXPIRED, ...
  amount                 text NOT NULL,
  expiration_time        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- At most one capture per milestone: the database refuses a double capture.
CREATE TABLE captures (
  id              text PRIMARY KEY,               -- PayPal capture id
  milestone_id    text NOT NULL UNIQUE REFERENCES milestones(id),
  authorization_id text NOT NULL REFERENCES authorizations(id),
  status          text NOT NULL,                  -- COMPLETED, PENDING, DECLINED, ...
  status_reason   text,                           -- PENDING reason from PayPal
  gross           text NOT NULL,
  paypal_fee      text,
  net             text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Every webhook delivery, verified or not. The UNIQUE event id is the de-duplication.
CREATE TABLE webhook_events (
  event_id      text PRIMARY KEY,
  event_type    text NOT NULL,
  resource_id   text,
  verified      boolean NOT NULL,
  raw_body      text NOT NULL,                    -- kept byte-for-byte for re-verification
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  outcome       text                              -- applied, ignored_stale, ignored_unknown, rejected_signature
);

CREATE TABLE disputes (
  id                       text PRIMARY KEY,      -- PayPal dispute id
  milestone_id             text REFERENCES milestones(id),
  capture_id               text REFERENCES captures(id),
  status                   text NOT NULL,
  stage                    text,
  reason                   text,
  seller_response_due      timestamptz,
  can_provide_evidence     boolean NOT NULL DEFAULT false,
  buyer_text_fields        jsonb,                 -- quarantined reader output only, never raw text
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Files are stored in the database because Render's free disk is wiped on restart.
CREATE TABLE evidence_files (
  id            text PRIMARY KEY,
  milestone_id  text NOT NULL REFERENCES milestones(id),
  criterion_id  text,
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  sha256        text NOT NULL,
  bytes         bytea NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mandates (
  id            text PRIMARY KEY,
  job_id        text NOT NULL REFERENCES jobs(id),
  max_amount    text NOT NULL,
  key_hash      text NOT NULL,                    -- sha256 of the agent's bearer key
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE acceptances (
  id             text PRIMARY KEY,
  milestone_id   text NOT NULL UNIQUE REFERENCES milestones(id),
  accepted_by    text NOT NULL,                   -- 'client' or 'client_agent'
  mandate_id     text REFERENCES mandates(id),
  file_hashes    jsonb NOT NULL,                  -- the sha256 list the client saw when accepting
  accepted_at    timestamptz NOT NULL DEFAULT now()
);

-- Every decision an agent or a person makes, with its reason. Shown in the AG Grid console.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,                    -- system, freelancer, client, client_agent, haiku, sonnet, opus_second_key
  action        text NOT NULL,
  milestone_id  text,
  decision      text,                             -- approve, deny, escalate, n/a
  reason        text,
  model         text,
  detail        jsonb
);
