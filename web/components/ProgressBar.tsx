import type { JobProgress, MilestoneView } from "../../lib/contract.ts";
import { PAID, HELD } from "./status";
import { cents } from "./api";

/** The shared bar: client and freelancer see the same thing. Width per stage = its share of the total. */
export function ProgressBar({ milestones, progress }: { milestones: MilestoneView[]; progress: JobProgress }) {
  const total = cents(progress.total) || 1;
  const w = (m: MilestoneView) => `${(cents(m.amount) / total) * 100}%`;
  return (
    <div>
      <div className="bar" role="img" aria-label={`$${progress.paid} of $${progress.total} paid`}>
        {milestones.map((m) => (
          <div key={m.id} style={{ width: w(m) }} className={PAID.includes(m.status) ? "paid" : HELD.includes(m.status) ? "held" : "todo"} title={`${m.title}: ${m.statusLabel}`} />
        ))}
      </div>
      <div className="barlabels">
        {milestones.map((m) => (
          <div key={m.id} style={{ width: w(m) }}>
            {m.title} · ${m.amount}
          </div>
        ))}
      </div>
      <p className="muted" style={{ margin: "6px 0 0" }}>
        ${progress.paid} of ${progress.total} paid ({progress.percentPaid}%) · ${progress.reserved} reserved · {progress.stagesPaid} of {progress.stages} stages paid
      </p>
    </div>
  );
}
