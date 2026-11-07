"use client";
import type { JobProgress, LedgerRow, MilestoneView } from "../../lib/contract.ts";

export type Role = "freelancer" | "client";
export type SavedJob = { jobId: string; title: string; role: Role; key: string; savedAt: string };
export type Job = { id: string; title: string; clientName: string; clientEmail: string; currency: string; createdAt: string };
export type JobResponse = { job: Job; milestones: MilestoneView[]; progress: JobProgress };
export type { LedgerRow, MilestoneView, JobProgress };

// Keys live only in this browser. The backend stores just their sha256, so a lost key can't be recovered.
const STORE = "receipts.jobs";

export function savedJobs(): SavedJob[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]");
  } catch {
    return [];
  }
}

export function saveJob(j: SavedJob) {
  try {
    const list = savedJobs().filter((x) => !(x.jobId === j.jobId && x.role === j.role));
    localStorage.setItem(STORE, JSON.stringify([j, ...list]));
  } catch {}
}

/** Picks the key for a job: the preferred role if saved, else freelancer, else client. */
export function keyFor(jobId: string, prefer?: Role): SavedJob | undefined {
  const list = savedJobs().filter((x) => x.jobId === jobId);
  return list.find((x) => x.role === prefer) ?? list.find((x) => x.role === "freelancer") ?? list[0];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Shared links carry the key in the URL fragment (#k=...), which browsers never send to a server.
 * A link is only a claim: the key is saved only if the backend accepts it for this job, and the backend's answer
 * decides the role. So a crafted link can't replace a saved key, and keys can't be recovered if they're lost.
 * Throws if the backend can't answer yet; the fragment stays, so a reload can try again.
 */
export async function absorbFragment(jobId: string): Promise<Role | null> {
  if (typeof window === "undefined" || !window.location.hash) return null;
  const k = new URLSearchParams(window.location.hash.slice(1)).get("k");
  if (!k) return null;
  const refused = (e: unknown) => e instanceof ApiError && [401, 403, 404].includes(e.status);
  const clear = () => history.replaceState(null, "", window.location.pathname + window.location.search);
  let job: JobResponse;
  try {
    job = await api<JobResponse>(`/api/jobs/${jobId}`, { key: k });
  } catch (e) {
    if (!refused(e)) throw e;
    clear();
    return null;
  }
  // Only the freelancer's key can read the ledger.
  let role: Role = "freelancer";
  try {
    await api(`/api/ledger?jobId=${encodeURIComponent(jobId)}`, { key: k });
  } catch (e) {
    if (!refused(e)) throw e;
    role = "client";
  }
  saveJob({ jobId, title: job.job.title, role, key: k, savedAt: new Date().toISOString() });
  clear();
  return role;
}

/** A link that opens a job with this key: the client's link, or the freelancer's backup. */
export const privateLink = (jobId: string, key: string) => `${window.location.origin}/jobs/${jobId}#k=${key}`;

export async function api<T>(path: string, opts: { key?: string; method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  let r: Response;
  try {
    r = await fetch(path, {
      method: opts.method ?? (opts.json !== undefined || opts.form ? "POST" : "GET"),
      headers,
      body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. It may be waking up, so try again in a minute.");
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (body as { error?: string }).error ?? `Request failed (${r.status})`);
  return body as T;
}

/** Money strings to cents without floats. */
export const cents = (s: string) => Number(s.replace(".", ""));
export const fromCents = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/** "200" / "200.5" / "$200.50" -> "200.50"; null if not a valid amount. */
export function toMoney(input: string): string | null {
  const t = input.trim().replace(/^\$/, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  const [a, b = ""] = t.split(".");
  const v = `${String(Number(a))}.${(b + "00").slice(0, 2)}`;
  return cents(v) > 0 ? v : null;
}

/**
 * Fee preview, a preview and not PayPal's number. Two rates, both PayPal's own:
 * - NG: receiving from abroad into a Nigerian account, PayPal NG merchant fees page (4.90% + $0.30).
 * - SANDBOX: what the US sandbox business account is actually charged in testing (2.90% + $0.30).
 */
export const FEE_RATES = { NG: { bps: 490, fixedCents: 30, label: "4.90% + $0.30" }, SANDBOX: { bps: 290, fixedCents: 30, label: "2.90% + $0.30" } } as const;

export function feePreview(amounts: string[], rate: { bps: number; fixedCents: number } = FEE_RATES.NG) {
  const fee = amounts.reduce((n, a) => n + Math.round((cents(a) * rate.bps) / 10000) + rate.fixedCents, 0);
  const gross = amounts.reduce((n, a) => n + cents(a), 0);
  return { gross: fromCents(gross), fee: fromCents(fee), net: fromCents(Math.max(0, gross - fee)) };
}
