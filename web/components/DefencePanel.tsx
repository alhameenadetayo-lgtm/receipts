"use client";
import { useCallback, useEffect, useState } from "react";
import type { BuyerFields, DefenceDraft, DefenceStatus } from "../../lib/contract.ts";
import { api, ApiError } from "./api";

type State = { draft: DefenceDraft | null; attemptsLeft: number };
type Mark = "pass" | "stop" | "wait" | "you" | "";

const COMPLAINT: Record<BuyerFields["complaint"], string> = {
  not_received: "says the work wasn't received",
  not_as_described: "says the work wasn't as described",
  unauthorised: "says they didn't authorise the payment",
  refund_not_received: "says a promised refund didn't arrive",
  duplicate: "says they were charged twice",
  wrong_amount: "says the amount was wrong",
  other: "has another complaint",
  unclear: "has an unclear complaint",
};

const STATUS: Record<DefenceStatus, { label: string; pill: string }> = {
  ready: { label: "Ready to file", pill: "pill paid" },
  escalated: { label: "Needs a closer look", pill: "pill warn" },
  denied: { label: "Stopped", pill: "pill bad" },
  filed: { label: "Filed with PayPal", pill: "pill paid" },
  rejected: { label: "Rejected by you", pill: "pill" },
};

const CHECKS: [keyof DefenceDraft["verdict"]["checks"], string][] = [
  ["amountMatches", "Amount matches the payment"],
  ["payeeMatches", "Payment went to this freelancer"],
  ["evidenceSupports", "Evidence backs up the note"],
  ["noInjectionInfluence", "Not swayed by the buyer's message"],
];

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

  const hint = busy === "draft" ? null
    : !canProvideEvidence && !draft ? "PayPal isn't asking for evidence on this dispute right now."
    : draft?.status === "ready" ? "Every check passed. Read the note, then file it or turn it down."
    : draft?.status === "escalated" ? "The final check wants a person to look harder, so this can't be filed from here. Reject it to try again, or answer in PayPal."
    : draft?.status === "filed" ? "PayPal has your evidence."
    : left === 0 && state ? "All AI attempts on this dispute are used. Answer it directly in PayPal."
    : state ? `Nothing goes to PayPal until you press File. ${left} attempt${left === 1 ? "" : "s"} left on this dispute.`
    : null;

  return (
    <section className="defence" aria-label="AI dispute defence">
      <div className="defence-head">
        <div className="row">
          <h3 className="grow">Defend this dispute</h3>
          {draft && <span className={STATUS[draft.status].pill}>{STATUS[draft.status].label}</span>}
        </div>
        <p>Three AI models and a set of fixed rules check each other. You make the final call.</p>
      </div>

      {!state && !err ? <p className="muted" style={{ padding: "14px 18px", margin: 0 }}>Loading…</p> : <Chain draft={draft} criteria={criteria} />}

      <div className="defence-foot">
        {busy === "draft" ? <span className="working">Reading, drafting and checking. This takes a minute or two.</span>
          : busy === "file" ? <span className="working">Sending to PayPal…</span>
          : hint && <p className="hint">{hint}</p>}
        {canDraft && (
          <button className="primary" onClick={() => run("draft", () => api(`/api/milestones/${msId}/defence`, { key: keyValue, json: {} }))}>
            {draft ? "Draft again" : "Draft my defence"}
          </button>
        )}
        {(draft?.status === "ready" || draft?.status === "escalated") && !busy && (
          <button className="danger" onClick={() => run("reject", () => api(`/api/milestones/${msId}/defence/reject`, { key: keyValue, json: { draftId: draft.id } }))}>
            Reject
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
      </div>
      {err && <p className="err" style={{ padding: "0 18px 14px", margin: 0 }}>{err}</p>}
    </section>
  );
}

function Step({ mark, title, who, children }: { mark: Mark; title: string; who: string; children?: React.ReactNode }) {
  return (
    <li className={mark}>
      <span className="dot" aria-hidden />
      <div className="step-title">
        {title} <span className="step-who">{who}</span>
        {mark === "pass" && <span className="sr-only"> (passed)</span>}
        {mark === "stop" && <span className="pill bad">Stopped here</span>}
        {mark === "wait" && <span className="pill warn">Wants a person</span>}
      </div>
      {children && <div className="step-body">{children}</div>}
    </li>
  );
}

function Chain({ draft, criteria }: { draft: DefenceDraft | null; criteria: { id: string; text: string }[] }) {
  const f = draft?.buyerFields ?? null;
  const v = draft?.verdict;
  const failedAt = v?.by === "system" ? (f ? "draft" : "read") : null;
  const reader: Mark = !draft ? "" : f ? "pass" : "stop";
  const drafter: Mark = !draft ? "" : draft.notes ? "pass" : failedAt === "draft" ? "stop" : "";
  const rules: Mark = !draft?.notes ? "" : v?.by === "rules" ? "stop" : "pass";
  const second: Mark = v?.by !== "second_key" ? "" : v.decision === "approve" ? "pass" : v.decision === "escalate" ? "wait" : "stop";
  const you: Mark = draft?.status === "filed" ? "pass" : draft?.status === "ready" ? "you" : "";

  return (
    <ol className="chain">
      <Step mark={reader} title="Read the buyer's message" who="Claude Haiku, no tools">
        {!draft && <span className="muted">Turns the buyer&apos;s words into a few fixed answers. Nothing they write can pass through as an instruction.</span>}
        {f && (
          <>
            <ul>
              <li>The buyer {COMPLAINT[f.complaint]}{f.disputedCriteria.length > 0 && `: ${f.disputedCriteria.map((id) => criteria.find((c) => c.id === id)?.text ?? id).join("; ")}`}.</li>
              <li>Admits receiving the work: {f.saysWorkWasDelivered}. Wants a refund: {f.asksSellerForRefund ? "yes" : "no"}.</li>
            </ul>
            {f.containsInstructionsToAi && <div className="alert">The buyer&apos;s message tried to give orders to an AI. It was flagged and ignored.</div>}
          </>
        )}
        {reader === "stop" && v && <span className="err">{v.reason}</span>}
      </Step>

      <Step mark={drafter} title="Draft the evidence" who="Claude Sonnet, sees only the job record">
        {!draft && <span className="muted">Writes your evidence from what the record shows: what was agreed, delivered and accepted.</span>}
        {draft?.notes && (
          <>
            <div className="quote">{draft.notes}</div>
            {draft.citedFiles.map((c) => (
              <div key={c.id} style={{ fontSize: 13.5 }}>
                Attached: {c.filename} <span className="mono muted">sha256 {c.sha256.slice(0, 16)}…</span>
              </div>
            ))}
          </>
        )}
        {drafter === "stop" && v && <span className="err">{v.reason}</span>}
      </Step>

      <Step mark={rules} title="Fixed rules" who="Plain code">
        {!draft && <span className="muted">Evidence only, for the right dispute and amount, no links, only files the client accepted, before PayPal&apos;s deadline.</span>}
        {rules === "stop" && v && <span className="err">{v.reason}</span>}
      </Step>

      <Step mark={second} title="Final check" who="Claude Opus, a second key">
        {!draft && <span className="muted">Checks the amount, the payee and the evidence against the record before you see it.</span>}
        {v?.by === "second_key" && (
          <>
            <ul className="checks">
              {CHECKS.map(([k, label]) => (
                <li key={k}>{v.checks[k] ? <span className="ok" aria-label="passed">✓</span> : <span className="err" aria-label="failed">✕</span>} {label}</li>
              ))}
            </ul>
            <div>{v.reason}</div>
          </>
        )}
      </Step>

      <Step mark={you} title="Your decision" who="Only you can send it">
        {draft?.status === "filed" && <span>Filed with PayPal on {new Date(draft.decidedAt ?? draft.createdAt).toLocaleString()}.</span>}
        {draft?.status === "rejected" && <span className="muted">You turned this draft down.</span>}
      </Step>
    </ol>
  );
}
