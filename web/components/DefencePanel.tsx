"use client";
import { useCallback, useEffect, useState } from "react";
import type { BuyerFields, DefenceDraft, DefenceStatus } from "../../lib/contract.ts";
import { api, ApiError } from "./api";

type State = { draft: DefenceDraft | null; attemptsLeft: number };

const COMPLAINT: Record<BuyerFields["complaint"], string> = {
  not_received: "says the work wasn't received",
  not_as_described: "says the work wasn't as described",
  unauthorised: "says they didn't authorise the payment",
  refund_not_received: "says a promised refund didn't arrive",
  duplicate: "says they were charged twice",
  wrong_amount: "says the amount was wrong",
  other: "has another complaint",
  unclear: "complaint is unclear",
};

const STATUS: Record<DefenceStatus, { label: string; pill: string; help: string }> = {
  ready: { label: "Ready for you", pill: "pill paid", help: "Every check passed. Nothing is sent to PayPal until you tap File." },
  escalated: { label: "Needs a closer look", pill: "pill warn", help: "The final check wants a person to look harder, so this draft can't be filed from here. Reject it to try again, or answer in PayPal yourself." },
  denied: { label: "Stopped", pill: "pill bad", help: "A check failed, so this draft can't be filed. Nothing was sent to PayPal." },
  filed: { label: "Filed with PayPal", pill: "pill paid", help: "PayPal has the evidence." },
  rejected: { label: "Rejected by you", pill: "pill", help: "You turned this draft down. Nothing was sent to PayPal." },
};

const CHECKS: [keyof DefenceDraft["verdict"]["checks"], string][] = [
  ["amountMatches", "Amount matches the payment"],
  ["payeeMatches", "Payment went to this freelancer"],
  ["evidenceSupports", "Evidence supports the note"],
  ["noInjectionInfluence", "Not swayed by the buyer's message"],
];

const BY = { rules: "the fixed rules", second_key: "the final AI check (Opus)", system: "the system" } as const;

/** The freelancer's view of the AI dispute defence for one disputed stage. */
export function DefencePanel({ msId, keyValue, criteria, canProvideEvidence }: { msId: string; keyValue: string; criteria: { id: string; text: string }[]; canProvideEvidence: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<"" | "draft" | "file" | "reject">("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setState(await api<State>(`/api/milestones/${msId}/defence`, { key: keyValue }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [msId, keyValue]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(kind: "draft" | "file" | "reject", fn: () => Promise<unknown>) {
    setBusy(kind);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 503 ? "The AI isn't switched on for this server yet." : (e as Error).message);
    } finally {
      await load();
      setBusy("");
    }
  }

  const draft = state?.draft ?? null;
  const left = state?.attemptsLeft ?? 0;
  const canDraft = !busy && canProvideEvidence && left > 0 && (!draft || draft.status === "denied" || draft.status === "rejected");

  return (
    <div className="note" style={{ marginTop: 8 }}>
      <b>Defend this dispute with AI</b>
      <p className="muted" style={{ margin: "4px 0" }}>
        One AI reads the buyer&apos;s message, a second drafts your evidence from the job record, then fixed rules and a third AI check it. Nothing goes to PayPal until you tap File.
      </p>

      {!state && !err && <p className="muted">Loading…</p>}
      {!canProvideEvidence && !draft && <p className="muted">PayPal isn&apos;t asking for evidence on this dispute right now.</p>}

      {draft && <DraftView draft={draft} criteria={criteria} />}

      <div className="row" style={{ marginTop: 8 }}>
        {canDraft && (
          <button className="primary" onClick={() => run("draft", () => api(`/api/milestones/${msId}/defence`, { key: keyValue, json: {} }))}>
            {draft ? "Try again" : "Draft my defence"}
          </button>
        )}
        {draft?.status === "ready" && !busy && (
          <button
            className="primary"
            onClick={() => confirm("Send this note and the cited files to PayPal as your evidence?") && run("file", () => api(`/api/milestones/${msId}/defence/file`, { key: keyValue, json: { draftId: draft.id } }))}
          >
            File with PayPal
          </button>
        )}
        {(draft?.status === "ready" || draft?.status === "escalated") && !busy && (
          <button className="danger" onClick={() => run("reject", () => api(`/api/milestones/${msId}/defence/reject`, { key: keyValue, json: { draftId: draft.id } }))}>
            Reject this draft
          </button>
        )}
      </div>
      {busy === "draft" && <p className="muted">The AI is working. This can take a minute or two.</p>}
      {busy === "file" && <p className="muted">Sending to PayPal…</p>}
      {state && !draft?.status.match(/^(ready|filed)$/) && canProvideEvidence && (
        <p className="muted" style={{ margin: "4px 0", fontSize: 13 }}>
          {left > 0 ? `${left} AI attempt${left === 1 ? "" : "s"} left on this dispute.` : "All AI attempts on this dispute are used. Answer it directly in PayPal."}
        </p>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function DraftView({ draft, criteria }: { draft: DefenceDraft; criteria: { id: string; text: string }[] }) {
  const s = STATUS[draft.status];
  const f = draft.buyerFields;
  const v = draft.verdict;
  return (
    <div style={{ marginTop: 6 }}>
      <div className="row">
        <span className={s.pill}>{s.label}</span>
        <span className="muted grow" style={{ fontSize: 13 }}>{new Date(draft.decidedAt ?? draft.createdAt).toLocaleString()}</span>
      </div>
      <p style={{ margin: "4px 0" }}>{s.help}</p>

      {f && (
        <div style={{ margin: "6px 0" }}>
          <b>What the buyer says</b> <span className="muted">(read by the first AI, which can only fill in fixed fields)</span>
          <ul style={{ margin: "4px 0" }}>
            <li>The buyer {COMPLAINT[f.complaint]}.</li>
            {f.disputedCriteria.length > 0 && <li>Disputes: {f.disputedCriteria.map((id) => criteria.find((c) => c.id === id)?.text ?? id).join("; ")}</li>}
            <li>Admits receiving the work: {f.saysWorkWasDelivered}</li>
            <li>Asks for a refund: {f.asksSellerForRefund ? "yes" : "no"}</li>
          </ul>
          {f.containsInstructionsToAi && (
            <p className="err" style={{ margin: "4px 0" }}>⚠ The buyer&apos;s message tried to give orders to an AI. They were ignored: the drafting AI never sees the buyer&apos;s words.</p>
          )}
        </div>
      )}

      {draft.notes && (
        <div style={{ margin: "6px 0" }}>
          <b>Evidence note{draft.evidenceType ? ` (${draft.evidenceType === "PROOF_OF_FULFILLMENT" ? "proof of delivery" : "other"})` : ""}</b>
          <div style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{draft.notes}</div>
          {draft.citedFiles.length > 0 && (
            <div style={{ fontSize: 13 }}>
              {draft.citedFiles.map((c) => (
                <div key={c.id}>📎 {c.filename} <span className="mono muted">sha256 {c.sha256.slice(0, 16)}…</span></div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ margin: "6px 0" }}>
        <b>Final decision by {BY[v.by]}</b>
        {v.by === "second_key" && (
          <ul style={{ margin: "4px 0" }}>
            {CHECKS.map(([k, label]) => (
              <li key={k}>{v.checks[k] ? <span className="ok">✓</span> : <span className="err">✗</span>} {label}</li>
            ))}
          </ul>
        )}
        <div style={{ whiteSpace: "pre-wrap" }}>{v.reason}</div>
      </div>
    </div>
  );
}
