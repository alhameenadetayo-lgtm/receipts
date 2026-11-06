"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, colorSchemeDarkBlue, type ColDef, type CellStyle } from "ag-grid-community";
import { api, savedJobs, type LedgerRow, type SavedJob } from "../../components/api";

ModuleRegistry.registerModules([AllCommunityModule]);

type AuditRow = { at: string; actor: string; action: string; decision: string; reason: string; model: string | null };

export default function ConsolePage() {
  return (
    <main className="wrap" style={{ maxWidth: 1280 }}>
      <h1>Console</h1>
      <p className="muted">Every payment, its PayPal ids and status, and every decision with its reason.</p>
      <Suspense fallback={null}>
        <Console />
      </Suspense>
    </main>
  );
}

function useDark() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(q.matches);
    const f = (e: MediaQueryListEvent) => setDark(e.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);
  return dark;
}

const statusStyle = (s: string): CellStyle | null =>
  s === "captured" ? { color: "var(--paid)", fontWeight: "600" } : s === "disputed" || s === "capture_failed" ? { color: "var(--bad)", fontWeight: "600" } : s === "reserved" ? { color: "var(--accent)" } : null;

function Console() {
  const sp = useSearchParams();
  const [jobs, setJobs] = useState<SavedJob[]>([]);
  const [jobId, setJobId] = useState(sp.get("job") ?? "");
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [audit, setAudit] = useState<{ ms: LedgerRow; rows: AuditRow[] } | null>(null);
  const [err, setErr] = useState("");
  const dark = useDark();
  const theme = useMemo(() => (dark ? themeQuartz.withPart(colorSchemeDarkBlue) : themeQuartz), [dark]);

  useEffect(() => {
    const list = savedJobs().filter((j) => j.role === "freelancer");
    setJobs(list);
    if (!jobId && list[0]) setJobId(list[0].jobId);
  }, [jobId]);

  const key = jobs.find((j) => j.jobId === jobId)?.key;

  useEffect(() => {
    if (!jobId || !key) return;
    const load = () =>
      api<{ rows: LedgerRow[] }>(`/api/ledger?jobId=${encodeURIComponent(jobId)}`, { key })
        .then((r) => (setRows(r.rows), setErr("")))
        .catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [jobId, key]);

  async function openAudit(ms: LedgerRow) {
    if (!key) return;
    try {
      const r = await api<{ rows: AuditRow[] }>(`/api/audit?milestoneId=${encodeURIComponent(ms.milestoneId)}`, { key });
      setAudit({ ms, rows: r.rows });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const cols = useMemo<ColDef<LedgerRow>[]>(
    () => [
      { field: "position", headerName: "#", width: 70, sort: "asc" },
      { field: "title", headerName: "Payment", width: 170, filter: true },
      { field: "kind", headerName: "Kind", width: 100 },
      { field: "amount", headerName: "Amount", width: 110, type: "rightAligned", valueFormatter: (p) => (p.value ? `$${p.value}` : "") },
      { field: "statusLabel", headerName: "Status", width: 190, filter: true, cellStyle: (p) => statusStyle(p.data?.status ?? "") },
      { field: "reviewState", headerName: "Review", width: 150 },
      { field: "revisionRound", headerName: "Rounds used", width: 120 },
      { field: "fee", headerName: "PayPal fee", width: 110, valueFormatter: (p) => (p.value ? `$${p.value}` : "") },
      { field: "net", headerName: "Net", width: 100, valueFormatter: (p) => (p.value ? `$${p.value}` : "") },
      { field: "orderId", headerName: "Order", width: 180, cellClass: "mono" },
      { field: "authorizationId", headerName: "Authorization", width: 180, cellClass: "mono" },
      { field: "captureId", headerName: "Capture", width: 180, cellClass: "mono" },
      { field: "disputeStatus", headerName: "Dispute", width: 150 },
      { field: "updatedAt", headerName: "Updated", width: 180, valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : "") },
    ],
    [],
  );

  const auditCols = useMemo<ColDef<AuditRow>[]>(
    () => [
      { field: "at", headerName: "When", width: 180, valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : "") },
      { field: "actor", headerName: "Actor", width: 120 },
      { field: "action", headerName: "Action", width: 200 },
      { field: "decision", headerName: "Decision", width: 110 },
      { field: "reason", headerName: "Reason", flex: 1, minWidth: 260, tooltipField: "reason" },
      { field: "model", headerName: "Model", width: 160 },
    ],
    [],
  );

  if (!jobs.length) return <p className="muted">No jobs on this device yet. <a href="/">Create one</a> as the freelancer to see its ledger.</p>;

  return (
    <>
      <div className="row">
        <div className="grow" style={{ maxWidth: 480 }}>
          <label>Job</label>
          <select value={jobId} onChange={(e) => (setJobId(e.target.value), setAudit(null))}>
            {jobs.map((j) => <option key={j.jobId} value={j.jobId}>{j.title || j.jobId}</option>)}
          </select>
        </div>
        <a href={`/jobs/${jobId}`} style={{ alignSelf: "flex-end", paddingBottom: 10 }}>Open job</a>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="panel">
        <h2>Ledger</h2>
        <div className="grid-h">
          <AgGridReact<LedgerRow> theme={theme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.milestoneId} enableCellTextSelection onRowClicked={(e) => e.data && openAudit(e.data)} />
        </div>
        <p className="muted">Click a payment to see its audit trail.</p>
      </div>
      {audit && (
        <div className="panel">
          <h2>Audit: {audit.ms.title}</h2>
          <div style={{ height: 300 }}>
            <AgGridReact<AuditRow> theme={theme} rowData={audit.rows} columnDefs={auditCols} tooltipShowDelay={300} enableCellTextSelection />
          </div>
        </div>
      )}
    </>
  );
}
