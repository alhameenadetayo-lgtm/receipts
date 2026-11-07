"use client";
import { useEffect, useMemo, useState } from "react";
import { api, privateLink, feePreview, FEE_RATES, saveJob, savedJobs, toMoney, type JobResponse, type SavedJob } from "../components/api";

type Draft = { title: string; amount: string; criteria: string };

const EXAMPLE: Draft[] = [
  { title: "Prototype", amount: "80", criteria: "Three rough concepts that match the brief" },
  { title: "Refinement", amount: "120", criteria: "Chosen direction applied\nAgreed revisions done" },
  { title: "Final files", amount: "80", criteria: "SVG and PNG files\nCommercial licence included" },
];

export default function Home() {
  const [jobs, setJobs] = useState<SavedJob[]>([]);
  useEffect(() => setJobs(savedJobs()), []);
  return (
    <main className="wrap">
      <h1>Receipts</h1>
      <p className="muted">Scope the job, get money reserved up front, and get paid stage by stage as the client confirms.</p>
      <NewJob onCreated={() => setJobs(savedJobs())} />
      <div className="panel">
        <h2>Jobs on this device</h2>
        {!jobs.length && <p className="muted">None yet. Keys are kept only in this browser.</p>}
        {jobs.map((j) => (
          <div key={j.jobId + j.role} className="ms row">
            <a className="grow" href={`/jobs/${j.jobId}`}>{j.title || j.jobId}</a>
            <span className="pill">{j.role}</span>
            {j.role === "freelancer" && <a href={`/console?job=${j.jobId}`}>Console</a>}
          </div>
        ))}
      </div>
    </main>
  );
}

function NewJob({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("Logo for a Lagos bakery");
  const [clientName, setClientName] = useState("Demo Client");
  const [clientEmail, setClientEmail] = useState("client-demo@example.com");
  const [deposit, setDeposit] = useState("120");
  const [maxRevisions, setMaxRevisions] = useState(2);
  const [stages, setStages] = useState<Draft[]>(EXAMPLE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [made, setMade] = useState<{ jobId: string; clientLink: string; backup: string } | null>(null);

  const amounts = useMemo(() => {
    const list = [deposit.trim() ? toMoney(deposit) : null, ...stages.map((s) => toMoney(s.amount))];
    return list.filter((x): x is string => !!x);
  }, [deposit, stages]);
  const fees = feePreview(amounts, FEE_RATES.NG);
  const sandboxFees = feePreview(amounts, FEE_RATES.SANDBOX);

  const set = (i: number, patch: Partial<Draft>) => setStages((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function create() {
    setErr("");
    const dep = deposit.trim() ? toMoney(deposit) : undefined;
    if (deposit.trim() && !dep) return setErr("Deposit must be an amount like 120 or 120.00");
    const milestones = [];
    for (const [i, s] of stages.entries()) {
      const amount = toMoney(s.amount);
      const criteria = s.criteria.split("\n").map((c) => c.trim()).filter(Boolean);
      if (!s.title.trim()) return setErr(`Stage ${i + 1} needs a title`);
      if (!amount) return setErr(`Stage ${i + 1} needs an amount like 80 or 80.00`);
      if (!criteria.length) return setErr(`Stage ${i + 1} needs at least one acceptance criterion`);
      milestones.push({ title: s.title.trim(), amount, criteria });
    }
    setBusy(true);
    try {
      const r = await api<JobResponse & { freelancerKey: string; clientKey: string }>("/api/jobs", {
        json: { title, clientName, clientEmail, ...(dep ? { deposit: dep } : {}), maxRevisions, milestones },
      });
      const now = new Date().toISOString();
      saveJob({ jobId: r.job.id, title: r.job.title, role: "freelancer", key: r.freelancerKey, savedAt: now });
      setMade({ jobId: r.job.id, clientLink: privateLink(r.job.id, r.clientKey), backup: privateLink(r.job.id, r.freelancerKey) });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Scope a new job</h2>
      <div className="row">
        <div className="grow"><label>Job title</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      </div>
      <div className="row">
        <div className="grow"><label>Client name</label><input value={clientName} onChange={(e) => setClientName(e.target.value)} /></div>
        <div className="grow"><label>Client email</label><input type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} /></div>
      </div>
      <div className="row">
        <div className="grow"><label>Deposit, paid at kickoff (USD, optional)</label><input inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} /></div>
        <div className="grow"><label>Revision rounds per stage</label>
          <select value={maxRevisions} onChange={(e) => setMaxRevisions(Number(e.target.value))}>
            {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      <h2 style={{ marginTop: 16 }}>Stages</h2>
      {stages.map((s, i) => (
        <div key={i} className="ms">
          <div className="row">
            <div className="grow"><label>Stage {i + 1} title</label><input value={s.title} onChange={(e) => set(i, { title: e.target.value })} /></div>
            <div style={{ width: 140 }}><label>Amount (USD)</label><input inputMode="decimal" value={s.amount} onChange={(e) => set(i, { amount: e.target.value })} /></div>
          </div>
          <label>What the client checks (one per line)</label>
          <textarea value={s.criteria} onChange={(e) => set(i, { criteria: e.target.value })} />
          {stages.length > 1 && <button className="danger" onClick={() => setStages((x) => x.filter((_, j) => j !== i))}>Remove stage</button>}
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => setStages((x) => [...x, { title: "", amount: "", criteria: "" }])}>Add stage</button>
      </div>

      <p className="muted">
        Total ${fees.gross}. For a freelancer in Nigeria, PayPal&apos;s published fee for receiving from abroad is {FEE_RATES.NG.label} per payment (about ${fees.fee}), so you&apos;d keep about <b>${fees.net}</b>.
        {" "}This demo runs on a US sandbox account, which PayPal charges {FEE_RATES.SANDBOX.label} (about ${sandboxFees.fee}), so the fee on each test payment is lower. Each payment shows the fee PayPal actually took.
      </p>
      <button className="primary" disabled={busy} onClick={create}>{busy ? "Creating… (the server may take a minute to wake)" : "Create job"}</button>
      {err && <p className="err">{err}</p>}
      {made && (
        <div className="note">
          <p className="ok" style={{ margin: 0 }}>Job created. <a href={`/jobs/${made.jobId}`}>Open it</a></p>
          <p style={{ margin: "6px 0 0" }}>Send the client this private link. It contains their key, so share it only with them:</p>
          <p className="mono" style={{ margin: "4px 0" }}>{made.clientLink}</p>
          <button onClick={() => navigator.clipboard?.writeText(made.clientLink)}>Copy client link</button>
          <p style={{ margin: "10px 0 0" }}>Keep your own backup link somewhere private. This browser holds your only key, and this link is how you get back in:</p>
          <button style={{ marginTop: 4 }} onClick={() => navigator.clipboard?.writeText(made.backup)}>Copy my backup link</button>
        </div>
      )}
    </div>
  );
}
