import type { MilestoneStatus } from "../../lib/contract.ts";

export const PAID: MilestoneStatus[] = ["captured", "capture_pending", "disputed", "dispute_closed"];
export const HELD: MilestoneStatus[] = ["reserved", "approved"];
const BAD: MilestoneStatus[] = ["capture_failed", "refunded", "reversed", "voided", "expired", "approval_reversed"];
const WARN: MilestoneStatus[] = ["disputed", "capture_pending"];

export function pillClass(s: MilestoneStatus) {
  if (s === "captured" || s === "dispute_closed") return "pill paid";
  if (WARN.includes(s)) return "pill warn";
  if (HELD.includes(s)) return "pill held";
  if (BAD.includes(s)) return "pill bad";
  return "pill";
}
