import type { ApplicationStatus, JobSummary, RunStage, RunStatus, RunSummary, ScoreState } from "./api";

export const statuses: ApplicationStatus[] = ["new", "applied", "oa", "interviewing", "offer", "rejected", "ghosted"];
export const statusLabels: Record<ApplicationStatus, string> = {
  new: "New",
  applied: "Applied",
  oa: "OA",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  ghosted: "Ghosted",
};
export const scoreStates: ScoreState[] = ["unscored", "pending", "running", "succeeded", "failed"];
export const scoreStateLabels: Record<ScoreState, string> = {
  unscored: "Unscored",
  pending: "Queued",
  running: "Scoring",
  succeeded: "Scored",
  failed: "Failed",
};

const siteLabels: Record<string, string> = { linkedin: "LinkedIn", indeed: "Indeed" };
export const siteLabel = (site: string) => siteLabels[site] ?? site;

const jobTypeLabels: Record<string, string> = {
  fulltime: "Full-time",
  parttime: "Part-time",
  contract: "Contract",
  internship: "Internship",
  temporary: "Temporary",
};
export const jobTypeLabel = (type: string) => jobTypeLabels[type] ?? type;
export const knownJobTypes = Object.keys(jobTypeLabels);
export const knownSites = Object.keys(siteLabels);

export const runStatusLabels: Record<RunStatus, string> = {
  running: "Running",
  stopping: "Stopping",
  succeeded: "Completed",
  partial: "Partly completed",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};
/** Run status color (SPEC: Running blue, Completed green, Partly completed orange, Failed red, others gray). */
export type RunTone = "running" | "completed" | "partial" | "failed" | "idle";
export const runStatusTone = (status: RunStatus): RunTone =>
  status === "running" ? "running" : status === "succeeded" ? "completed" : status === "partial" ? "partial" : status === "failed" ? "failed" : "idle";
export const runStageLabels: Record<Exclude<RunStage, null>, string> = { retrieving: "Searching", scoring: "Scoring", cleaning: "Finishing" };
export const isActiveRun = (status: RunStatus) => status === "running" || status === "stopping";

// Dates are numeric and 24-hour everywhere (SPEC): 10/19 21:29, 10/17, and
// 2025/12/03 outside the current year.
const pad = (value: number) => String(value).padStart(2, "0");
function numericDay(date: Date) {
  const day = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return date.getFullYear() === new Date().getFullYear() ? day : `${date.getFullYear()}/${day}`;
}
/** Local clock time, e.g. 21:29. */
export const formatClock = (ms: number) => {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** UTC milliseconds shown as a local date, e.g. 10/17. */
export const formatDay = (ms: number | null | undefined) => (ms == null ? "" : numericDay(new Date(ms)));
/** UTC milliseconds shown as a local date and time, e.g. 10/19 21:29. */
export const formatTime = (ms: number | null | undefined) => (ms == null ? "" : `${numericDay(new Date(ms))} ${formatClock(ms)}`);
/** A run's start as shown for batches and in Runs. */
export const formatRunTime = (ms: number) => formatTime(ms);
/** Batch option label, e.g. "10/18 09:00 · 42 new". */
export const batchLabel = (run: Pick<RunSummary, "started_at" | "new_job_count">) => `${formatRunTime(run.started_at)} · ${run.new_job_count.toLocaleString("en-US")} new`;

/** Calendar date (YYYY-MM-DD) shown like formatDay, never shifted through a time zone. */
export function formatCalendarDay(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return numericDay(new Date(year, month - 1, day));
}

/** Source dates stay calendar dates (YYYY-MM-DD); never shifted through a time zone. */
export function formatPosted(date: string | null | undefined) {
  return date ? formatCalendarDay(date) : "";
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDay(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const intervalLabels: Record<string, string> = { yearly: "year", monthly: "month", weekly: "week", daily: "day", hourly: "hour" };
export const salaryIntervals = Object.keys(intervalLabels);

export function formatSalary(salary: JobSummary["salary"]) {
  if (salary.min == null && salary.max == null) return "";
  const money = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: salary.currency ? "currency" : "decimal",
      currency: salary.currency ?? undefined,
      maximumFractionDigits: 0,
    }).format(value);
  const range =
    salary.min != null && salary.max != null && salary.min !== salary.max
      ? `${money(salary.min)}–${money(salary.max)}`
      : salary.min != null && salary.max == null
        ? `From ${money(salary.min)}`
        : salary.min == null
          ? `Up to ${money(salary.max!)}`
          : money(salary.min);
  return salary.interval ? `${range} / ${intervalLabels[salary.interval] ?? salary.interval}` : range;
}

export const plural = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? word : many}`;

export type ScoreTone = "high" | "mid" | "low" | "none" | "failed";

/** Chip text and color group for a score cell (SPEC: 8–10, 6–7, 0–5, —, !). */
export function scoreChip(job: Pick<JobSummary, "score" | "score_state">): { text: string; tone: ScoreTone; label: string } {
  const previous = job.score != null ? ` · previous score ${job.score}` : "";
  switch (job.score_state) {
    case "failed":
      return { text: "!", tone: "failed", label: `Scoring failed${previous}` };
    case "pending":
      return { text: "…", tone: "none", label: `Queued for scoring${previous}` };
    case "running":
      return { text: "↻", tone: "none", label: `Scoring${previous}` };
    default:
      if (job.score == null) return { text: "—", tone: "none", label: "Not scored" };
      return {
        text: String(job.score),
        tone: job.score >= 8 ? "high" : job.score >= 6 ? "mid" : "low",
        label: `Score ${job.score} of 10`,
      };
  }
}
