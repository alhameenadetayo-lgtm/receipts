"use client";
import { use, useCallback, useEffect, useState } from "react";
import { absorbFragment, api, keyFor, saveJob, type JobResponse, type MilestoneView, type Role, type SavedJob } from "../../../components/api";
import { ProgressBar } from "../../../components/ProgressBar";
import { pillClass } from "../../../components/status";

const PAYMENT_MSG: Record<string, string> = {
  reserved: "PayPal approved. The money is reserved: set aside for the freelancer, not taken yet.",
  captured: "PayPal approved. The deposit is paid.",
};

export default function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ payment?: string; as?: string }> }) {
  const { id } = use(params);
  const sp = use(searchParams);
  const [me, setMe] = useState<SavedJob | null | undefined>(undefined);
  const [data, setData] = useState<JobResponse | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState(sp.payment ? PAYMENT_MSG[sp.payment] ?? `PayPal: ${sp.payment.replace(/_/g, " ")}` : "");

  useEffect(() => {
    const fromLink = absorbFragment(id);
    setMe(keyFor(id, fromLink ?? (sp.as === "client" ? "client" : undefined)) ?? null);
  }, [id, sp.as]);

  const load = useCallback(async () => {
    if (!me) return;
    try {
      const r = await api<JobResponse>(`/api/jobs/${id}`, { key: me.key });
      setData(r);
      if (!me.title) saveJob({ ...me, title: r.job.title });
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id, me]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  if (me === undefined) return null;
  if (me === null)
    return (
      <main className="wrap">
        <h1>Job</h1>
        <p className="err">This browser has no key for this job. Open the private link you were sent, or create the job from this device.</p>
      </main>
    );
  if (!data) return <main className="wrap"><p className="muted">{err || "Loading… the server may take a minute to wake up."}</p></main>;

  const role = me.role;
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr("");
    setNote("");
    try {
      await fn();
      if (ok) setNote(ok);
    } catch (e) {
      setErr((e as Error).message);
    }
    await load();
  };

  return (
    <main className="wrap">
      <h1>{data.job.title}</h1>
      <p className="muted">
        {role === "freelancer" ? `For ${data.job.clientName}` : "You are the client"} · {data.milestones.length} payments · <span className="pill">{role}</span>
        {role === "freelancer" && <> · <a href={`/console?job=${id}`}>Console</a></>}
      </p>
      <div className="panel"><ProgressBar milestones={data.milestones} progress={data.progress} /></div>
      {note && <p className="ok">{note}</p>}
      {err && <p className="err">{err}</p>}
      <div className="panel">
        {data.milestones.map((m) => (
          <Milestone key={m.id} m={m} role={role} keyValue={me.key} act={act} />
        ))}
      </div>
      {role === "client" && <MandateBox jobId={id} keyValue={me.key} />}
    </main>
  );
}

function Milestone({ m, role, keyValue, act }: { m: MilestoneView; role: Role; keyValue: string; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [crit, setCrit] = useState("");
  const [chCrit, setChCrit] = useState(m.criteria[0]?.id ?? "");
  const [chNote, setChNote] = useState("");
  const link = m.approveUrl ?? approveUrl;
  const roundsLeft = m.maxRevisions - m.revisionRound;
  const canPayRequest = ["draft", "approval_reversed", "voided", "expired"].includes(m.status);

  return (
    <div className="ms">
      <div className="row">
        <b className="grow">{m.position}. {m.title}{m.kind === "deposit" && !/deposit/i.test(m.title) ? " (deposit)" : ""} · ${m.amount}</b>
        <span className={pillClass(m.status)}>{m.statusLabel}</span>
        {m.kind === "stage" && m.reviewState !== "waiting" && <span className="pill">{m.reviewState === "delivered" ? "Delivered" : "Changes requested"}</span>}
      </div>

      {m.criteria.length > 0 && (
        <ul style={{ margin: "6px 0" }}>
          {m.criteria.map((c) => {
            const fs = m.files.filter((f) => f.criterionId === c.id);
            return (
              <li key={c.id}>
                {c.text} {fs.length ? <span className="ok">✓ {fs.map((f) => f.filename).join(", ")}</span> : <span className="muted">· no file yet</span>}
              </li>
            );
          })}
        </ul>
      )}
      {m.files.length > 0 && (
        <div style={{ fontSize: 13 }}>
          {m.files.map((f) => (
            <div key={f.id}>📎 {f.filename} <span className="mono muted">sha256 {f.sha256.slice(0, 16)}…</span></div>
          ))}
        </div>
      )}
      {m.reservedUntil && <p className="muted" style={{ margin: "4px 0" }}>Reserved until {new Date(m.reservedUntil).toLocaleString()}</p>}
      {m.capture && (
        <p className="muted" style={{ margin: "4px 0" }}>
          Paid ${m.capture.gross}{m.capture.fee ? ` · PayPal fee $${m.capture.fee} · freelancer gets $${m.capture.net}` : ""}{m.capture.heldReason ? ` · held by PayPal: ${m.capture.heldReason}` : ""}
        </p>
      )}
      {m.dispute && <p className="err" style={{ margin: "4px 0" }}>Dispute {m.dispute.status}{m.dispute.responseDue ? `, response due ${new Date(m.dispute.responseDue).toLocaleDateString()}` : ""}</p>}
      {m.accepted && <p className="muted" style={{ margin: "4px 0" }}>Accepted by {m.accepted.by === "client_agent" ? "the client's agent" : "the client"} on {new Date(m.accepted.at).toLocaleString()}</p>}

      {m.changeRequests.length > 0 && (
        <div>
          {m.changeRequests.map((c) => (
            <div key={c.round} className="note">
              <b>Change request, round {c.round}</b> on “{m.criteria.find((x) => x.id === c.criterionId)?.text ?? "a criterion"}”
              {/* The client's own words: shown as plain text only, never passed to an agent. */}
              <div style={{ whiteSpace: "pre-wrap" }}>{c.note}</div>
            </div>
          ))}
        </div>
      )}

      {role === "freelancer" && (
        <div style={{ marginTop: 8 }}>
          {canPayRequest && (
            <button className="primary" onClick={() => act(async () => setApproveUrl((await api<{ approveUrl: string }>(`/api/milestones/${m.id}/request-payment`, { key: keyValue, json: {} })).approveUrl), "Payment link ready. The client pays it from their page.")}>
              Ask the client to {m.kind === "deposit" ? "pay the deposit" : "reserve this stage"}
            </button>
          )}
          {m.status === "awaiting_payment" && link && <p className="muted">Waiting for the client to approve in PayPal. They see the button on their page.</p>}
          {m.kind === "stage" && m.status === "reserved" && (
            <div className="row" style={{ marginTop: 6 }}>
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ maxWidth: 260 }} />
              <select value={crit} onChange={(e) => setCrit(e.target.value)} style={{ maxWidth: 260 }}>
                <option value="">Match to a criterion…</option>
                {m.criteria.map((c) => <option key={c.id} value={c.id}>{c.text}</option>)}
              </select>
              <button className="primary" disabled={!file} onClick={() => act(async () => {
                const fd = new FormData();
                fd.append("file", file!);
                if (crit) fd.append("criterionId", crit);
                await api(`/api/milestones/${m.id}/files`, { key: keyValue, form: fd });
              }, "Delivered. The file is fingerprinted and the client can review it.")}>
                {m.reviewState === "changes_requested" ? "Resubmit" : "Deliver"}
              </button>
            </div>
          )}
          {["awaiting_payment", "reserved"].includes(m.status) && !m.accepted && (
            <button className="danger" style={{ marginTop: 6 }} onClick={() => confirm("Cancel this payment? Any reserved money goes back to the client.") && act(() => api(`/api/milestones/${m.id}/void`, { key: keyValue, json: {} }), "Cancelled.")}>
              Cancel this payment
            </button>
          )}
        </div>
      )}

      {role === "client" && (
        <div style={{ marginTop: 8 }}>
          {m.status === "awaiting_payment" && link && (
            <a href={link}><button className="primary">{m.kind === "deposit" ? "Pay the deposit with PayPal" : "Reserve with PayPal"}</button></a>
          )}
          {m.status === "reserved" && m.reviewState === "delivered" && (
            <>
              <button className="primary" onClick={() => act(() => api(`/api/milestones/${m.id}/accept`, { key: keyValue, json: { by: "client" } }), `${m.title} accepted. The payment is released to the freelancer.`)}>
                Accept and release ${m.amount}
              </button>
              {roundsLeft > 0 ? (
                <div style={{ marginTop: 8 }}>
                  <label>Or say what isn&apos;t right yet ({roundsLeft} revision round{roundsLeft === 1 ? "" : "s"} left)</label>
                  <div className="row">
                    <select value={chCrit} onChange={(e) => setChCrit(e.target.value)} style={{ maxWidth: 260 }}>
                      {m.criteria.map((c) => <option key={c.id} value={c.id}>{c.text}</option>)}
                    </select>
                    <input className="grow" maxLength={1000} value={chNote} onChange={(e) => setChNote(e.target.value)} placeholder="e.g. The colour should be green, not blue" />
                    <button disabled={!chNote.trim() || !chCrit} onClick={() => act(async () => {
                      await api(`/api/milestones/${m.id}/request-changes`, { key: keyValue, json: { criterionId: chCrit, note: chNote.trim() } });
                      setChNote("");
                    }, "Sent to the freelancer.")}>Request change</button>
                  </div>
                </div>
              ) : (
                <p className="muted">All agreed revision rounds are used. Accept, or talk to the freelancer about next steps.</p>
              )}
            </>
          )}
          {m.status === "reserved" && m.reviewState !== "delivered" && <p className="muted">Reserved. Waiting for the freelancer to deliver.</p>}
        </div>
      )}
    </div>
  );
}

function MandateBox({ jobId, keyValue }: { jobId: string; keyValue: string }) {
  const [max, setMax] = useState("500.00");
  const [days, setDays] = useState(7);
  const [out, setOut] = useState<{ mandateId: string; agentKey: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState("");
  return (
    <div className="panel">
      <h2>Let your own AI agent accept stages</h2>
      <p className="muted">Your agent can accept a delivered stage up to the limit you set, and nothing else. It can&apos;t refund, cancel or raise its own limit.</p>
      <div className="row">
        <div className="grow"><label>Max per stage (USD)</label><input value={max} onChange={(e) => setMax(e.target.value)} /></div>
        <div style={{ width: 140 }}><label>Valid for (days)</label><input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} /></div>
      </div>
      <button style={{ marginTop: 8 }} onClick={async () => {
        setErr("");
        try {
          setOut(await api(`/api/jobs/${jobId}/mandates`, { key: keyValue, json: { maxAmount: max, days } }));
        } catch (e) {
          setErr((e as Error).message);
        }
      }}>Create mandate</button>
      {err && <p className="err">{err}</p>}
      {out && (
        <div className="note">
          Give these to your agent. The key is shown once.
          <div className="mono">mandateId: {out.mandateId}</div>
          <div className="mono">agentKey: {out.agentKey}</div>
          <div className="muted">Expires {new Date(out.expiresAt).toLocaleString()}</div>
        </div>
      )}
    </div>
  );
}
