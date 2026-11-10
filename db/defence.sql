-- AI dispute defence. Safe to run on every start: the live database already has schema.sql.

-- One row per attempt, whatever happened to it. Buyer text is never stored here, only fixed fields.
CREATE TABLE IF NOT EXISTS dispute_drafts (
  id             text PRIMARY KEY,                  -- dft_...
  dispute_id     text NOT NULL REFERENCES disputes(id),
  milestone_id   text NOT NULL REFERENCES milestones(id),
  status         text NOT NULL,                     -- ready, denied, escalated, filed, rejected
  evidence_type  text,
  notes          text,
  cited_file_ids jsonb NOT NULL DEFAULT '[]',
  buyer_fields   jsonb,
  verdict        jsonb NOT NULL,                    -- decision, who decided, each check, reason
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz                        -- when the person filed or rejected it
);

-- The database refuses a second filing on one dispute.
CREATE UNIQUE INDEX IF NOT EXISTS one_filing_per_dispute ON dispute_drafts (dispute_id) WHERE status = 'filed';
