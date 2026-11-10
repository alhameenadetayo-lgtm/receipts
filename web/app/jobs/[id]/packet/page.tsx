"use client";
import { use, useEffect, useState } from "react";
import { api, keyFor, type JobResponse, type SavedJob } from "../../../../components/api";
import { pillClass } from "../../../../components/status";

type AuditRow = { at: string; actor: string; action: string; decision: string; reason: string; model: string | null };

/**
 * Trust Packet: one page with the scope, what was delivered (with fingerprints), who accepted what and when,
 * and the PayPal ids. It is the page we'd want a PayPal reviewer to see before holding the freelancer's money.
 * Print it or save it as PDF from the browser.
 */
export default function TrustPacket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [me, setMe] = useState<SavedJob | null | undefined>(undefined);
  const [data, setData] = useState<JobResponse | null>(null);
  const [audit, setAudit] = useState<Record<string, AuditRow[]>>({});
  const [err, setErr] = useState("");

  useEffect(() => setMe(keyFor(id) ?? null), [id]);

  useEffect(() => {
    if (!me) return;
    (async () => {
      try {
        const r = await api<JobResponse>(`/api/jobs/${id}`, { key: me.key });
        setData(r);
        if (me.role === "freelancer") {
          const entries = await Promise.all(
            r.milestones.map(async (m) => [m.id, (await api<{ rows: AuditRow[] }>(`/api/audit?milestoneId=${m.id}`, { key: me.key })).rows] as const),
          );
          setAudit(Object.fromEntries(entries));
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [id, me]);

  if (me === undefined) return null;
  if (me === null) return <main className="wrap"><p className="err">This browser has no key for this job.</p></main>;
  if (!data) return <main className="wrap"><p className="muted">{err || "Loading…"}</p></main>;

  const generated = new Date();
  return (
    <main className="wrap packet">
      <div className="row noprint" style={{ justifyContent: "space-between" }}>
        <a href={`/jobs/${id}`}>← Back to the job</a>
        <button className="primary" onClick={() => window.print()}>Print or save as PDF</button>
      </div>

      <h1>Trust Packet</h1>
      <p className="muted">
        {data.job.title} · client {data.job.clientName} · job <span className="mono">{data.job.id}</span> · created {new Date(data.job.createdAt).toLocaleDateString()} · generated {generated.toLocaleString()}
      </p>

      <div className="panel">
        <h2>Summary</h2>
        <p style={{ margin: 0 }}>
          ${data.progress.paid} of ${data.progress.total} paid across {data.progress.stagesPaid} of {data.progress.stages} payments; ${data.progress.reserved} reserved.
          Every payment below was agreed in scope before any money moved. Each delivered file was fingerprinted (SHA-256) when it was uploaded,
          and each acceptance records who accepted and when.
        </p>
      </div>

      {data.milestones.map((m) => (
        <div key={m.id} className="panel">
          <div className="row">
            <h2 className="grow" style={{ margin: 0 }}>{m.position}. {m.title} · ${m.amount}</h2>
            <span className={pillClass(m.status)}>{m.statusLabel}</span>
          </div>

          <table className="kv">
            <tbody>
              <tr><th>Agreed criteria</th><td>{m.criteria.length ? m.criteria.map((c) => <div key={c.id}>{c.id}: {c.text}</div>) : "—"}</td></tr>
              <tr><th>Delivered files</th><td>
                {m.files.length ? m.files.map((f) => (
                  <div key={f.id}>{f.filename}{f.criterionId ? ` (for ${f.criterionId})` : ""}<div className="mono muted">sha256 {f.sha256}</div></div>
                )) : "—"}
              </td></tr>
              <tr><th>Changes requested</th><td>{m.changeRequests.length ? `${m.changeRequests.length} of ${m.maxRevisions} agreed rounds` : "none"}</td></tr>
              <tr><th>Accepted</th><td>{m.accepted ? `${m.accepted.by === "client_agent" ? "by the client's agent, under the client's mandate" : "by the client"} on ${new Date(m.accepted.at).toLocaleString()}` : "not yet"}</td></tr>
              <tr><th>PayPal</th><td>
                {m.capture ? <>capture <span className="mono">{m.capture.id}</span>, gross ${m.capture.gross}{m.capture.fee ? `, fee $${m.capture.fee}, net $${m.capture.net}` : ""}{m.capture.heldReason ? `, held: ${m.capture.heldReason}` : ""}</> : m.reservedUntil ? `reserved until ${new Date(m.reservedUntil).toLocaleString()}` : "—"}
              </td></tr>
              {m.dispute && <tr><th>Dispute</th><td><span className="mono">{m.dispute.id}</span> · {m.dispute.status.replace(/_/g, " ").toLowerCase()}</td></tr>}
            </tbody>
          </table>

          {audit[m.id]?.length ? (
            <>
              <h3 style={{ fontSize: 14, margin: "12px 0 4px" }}>Audit trail</h3>
              <table className="audit">
                <tbody>
                  {audit[m.id].map((a, i) => (
                    <tr key={i}>
                      <td className="muted">{new Date(a.at).toLocaleString()}</td>
                      <td>{a.actor}</td>
                      <td>{a.action}</td>
                      <td className="muted">{a.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </div>
      ))}

      <p className="muted" style={{ fontSize: 13 }}>
        A fingerprint proves a file hasn&apos;t changed since it was delivered; it doesn&apos;t prove the work was good. This packet is a record for review, not a decision.
        Sandbox only: no real money.
      </p>
    </main>
  );
}
