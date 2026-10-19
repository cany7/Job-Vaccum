import type { ApplicationStatus, JobSummary, ScoreState } from "./api";

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

const thisYear = new Date().getFullYear();
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dayYearFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function shortDay(date: Date) {
  return date.getFullYear() === thisYear ? dayFormat.format(date) : dayYearFormat.format(date);
}

/** UTC milliseconds shown as a short local date. */
export const formatDay = (ms: number | null | undefined) => (ms == null ? "" : shortDay(new Date(ms)));
export const formatTime = (ms: number | null | undefined) => (ms == null ? "" : timeFormat.format(new Date(ms)));

/** Source dates stay calendar dates (YYYY-MM-DD); never shifted through a time zone. */
export function formatPosted(date: string | null | undefined) {
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  return shortDay(new Date(year, month - 1, day));
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDay(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
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
