import type { ApplicationStatus, FilterSpec, ScoreState, Scope, Sort } from "./api";
import { formatCalendarDay, isoDay, jobTypeLabel, salaryIntervals, scoreStateLabels, scoreStates, siteLabel, statusLabels, statuses } from "./format";

export type ListPage = "jobs" | "shortlist";
export const scopeOf = (page: ListPage): Scope => (page === "jobs" ? "discover" : "applications");

/** Relative ranges (last N days, including today) stay relative across restarts; custom ranges are inclusive local dates. */
export type DateRange = { days: number } | { from?: string; to?: string };
export interface Salary {
  presence?: "known" | "unknown";
  min?: number;
  max?: number;
  currency?: string;
  interval?: string;
}

/** What a page remembers about its filters. Converted to a FilterSpec for each request. */
export interface ListFilter {
  text?: string;
  direction_ids?: string[];
  /** Jobs only: retrieval runs (batches); a job belongs to the run that first found it. */
  run_ids?: string[];
  sources?: string[];
  companies?: string[];
  locations?: string[];
  job_types?: string[];
  score_min?: number;
  score_max?: number;
  score_states?: ScoreState[];
  in_applications?: boolean;
  application_statuses?: ApplicationStatus[];
  first_seen?: DateRange;
  date_posted?: DateRange;
  date_posted_unknown?: boolean;
  added?: DateRange;
  updated?: DateRange;
  salary?: Salary;
}

export type FilterKey =
  | "text"
  | "direction_ids"
  | "run_ids"
  | "score"
  | "in_applications"
  | "application_statuses"
  | "companies"
  | "locations"
  | "job_types"
  | "sources"
  | "first_seen"
  | "date_posted"
  | "added"
  | "updated"
  | "salary";

export const filterNames: Record<FilterKey, string> = {
  text: "Search",
  direction_ids: "Searches",
  run_ids: "Batch",
  score: "Score",
  in_applications: "In Shortlist",
  application_statuses: "Status",
  companies: "Company",
  locations: "Location",
  job_types: "Type",
  sources: "Source",
  first_seen: "Found",
  date_posted: "Posted",
  added: "Added",
  updated: "Updated",
  salary: "Salary",
};

/** Dimensions offered by + Filter on each page; batches are a Jobs filter. */
export const filterMenus: Record<ListPage, FilterKey[]> = {
  jobs: ["direction_ids", "run_ids", "score", "in_applications", "companies", "locations", "job_types", "sources", "first_seen", "date_posted", "salary"],
  shortlist: ["direction_ids", "application_statuses", "score", "companies", "locations", "job_types", "sources", "added", "updated", "first_seen", "date_posted", "salary"],
};

export function activeKeys(filter: ListFilter): FilterKey[] {
  const keys: FilterKey[] = [];
  if (filter.text) keys.push("text");
  if (filter.direction_ids?.length) keys.push("direction_ids");
  if (filter.run_ids?.length) keys.push("run_ids");
  if (filter.score_min != null || filter.score_max != null || filter.score_states?.length) keys.push("score");
  if (filter.in_applications != null) keys.push("in_applications");
  if (filter.application_statuses?.length) keys.push("application_statuses");
  for (const key of ["companies", "locations", "job_types", "sources"] as const) if (filter[key]?.length) keys.push(key);
  if (filter.first_seen) keys.push("first_seen");
  if (filter.date_posted || filter.date_posted_unknown) keys.push("date_posted");
  if (filter.added) keys.push("added");
  if (filter.updated) keys.push("updated");
  if (filter.salary) keys.push("salary");
  return keys;
}

export function withoutKey(filter: ListFilter, key: FilterKey): ListFilter {
  const next = { ...filter };
  switch (key) {
    case "score":
      delete next.score_min;
      delete next.score_max;
      delete next.score_states;
      break;
    case "date_posted":
      delete next.date_posted;
      delete next.date_posted_unknown;
      break;
    default:
      delete next[key];
  }
  return next;
}

function addDays(day: string, count: number) {
  const [year, month, date] = day.split("-").map(Number);
  return isoDay(new Date(year, month - 1, date + count));
}
const startOfDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
};

/** Inclusive local dates → half-open [from, to) bounds; relative N days starts N−1 days before today. */
function bounds(range: DateRange): { from?: string; to?: string } {
  if ("days" in range) return { from: addDays(isoDay(new Date()), 1 - range.days) };
  return { from: range.from, to: range.to ? addDays(range.to, 1) : undefined };
}

export function toFilterSpec(page: ListPage, filter: ListFilter): FilterSpec {
  const spec: FilterSpec = { scope: scopeOf(page) };
  if (filter.text) spec.text = filter.text;
  for (const key of ["direction_ids", "sources", "companies", "locations", "job_types", "score_states"] as const) {
    if (filter[key]?.length) (spec[key] as string[]) = filter[key]!;
  }
  if (filter.score_min != null) spec.score_min = filter.score_min;
  if (filter.score_max != null) spec.score_max = filter.score_max;
  if (page === "jobs" && filter.in_applications != null) spec.in_applications = filter.in_applications;
  if (page === "jobs" && filter.run_ids?.length) spec.run_ids = filter.run_ids;
  if (page === "shortlist" && filter.application_statuses?.length) spec.application_statuses = filter.application_statuses;
  const timed = [["first_seen", filter.first_seen]] as [string, DateRange | undefined][];
  if (page === "shortlist") timed.push(["added", filter.added], ["updated", filter.updated]);
  for (const [prefix, range] of timed) {
    if (!range) continue;
    const { from, to } = bounds(range);
    if (from) (spec as Record<string, number>)[`${prefix}_from`] = startOfDay(from);
    if (to) (spec as Record<string, number>)[`${prefix}_to`] = startOfDay(to);
  }
  if (filter.date_posted_unknown) spec.date_posted_unknown = true;
  else if (filter.date_posted) {
    const { from, to } = bounds(filter.date_posted);
    if (from) spec.date_posted_from = from;
    if (to) spec.date_posted_to = to;
  }
  const salary = filter.salary;
  if (salary?.presence) spec.salary_presence = salary.presence;
  if (salary && (salary.min != null || salary.max != null)) {
    if (salary.min != null) spec.salary_min = salary.min;
    if (salary.max != null) spec.salary_max = salary.max;
    spec.salary_currency = salary.currency;
    spec.salary_interval = salary.interval;
  }
  return spec;
}

const list = (values: string[], label: (value: string) => string = (value) => value) => {
  const names = values.map(label);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
};

const quickRanges = [1, 3, 7, 14, 30];
export const quickRangeLabel = (days: number) => (days === 1 ? "Today" : `Last ${days} days`);
export { quickRanges };

function rangeLabel(range: DateRange) {
  if ("days" in range) return quickRangeLabel(range.days);
  const show = formatCalendarDay;
  if (range.from && range.to) return range.from === range.to ? show(range.from) : `${show(range.from)} – ${show(range.to)}`;
  if (range.from) return `since ${show(range.from)}`;
  return range.to ? `until ${show(range.to)}` : "";
}

/** Display names for IDs held in filters (searches and batches). */
export interface FilterNames {
  direction: (id: string) => string;
  run: (id: string) => string;
}

export function chipLabel(key: FilterKey, filter: ListFilter, names: FilterNames): string {
  switch (key) {
    case "text":
      return `Search: ${filter.text}`;
    case "direction_ids":
      return `Searches: ${list(filter.direction_ids!, names.direction)}`;
    case "run_ids":
      return `Batch: ${list(filter.run_ids!, names.run)}`;
    case "score": {
      const parts: string[] = [];
      const { score_min: min, score_max: max } = filter;
      if (min != null && max != null) parts.push(min === max ? `Score ${min}` : `Score ${min}–${max}`);
      else if (min != null) parts.push(`Score ≥ ${min}`);
      else if (max != null) parts.push(`Score ≤ ${max}`);
      if (filter.score_states?.length) parts.push(list(filter.score_states, (state) => scoreStateLabels[state as ScoreState]));
      return parts.length === 1 && min == null && max == null ? `Score: ${parts[0]}` : parts.join(" · ");
    }
    case "in_applications":
      return filter.in_applications ? "In Shortlist" : "Not in Shortlist";
    case "application_statuses":
      return `Status: ${list(filter.application_statuses!, (status) => statusLabels[status as ApplicationStatus])}`;
    case "companies":
      return `Company: ${list(filter.companies!)}`;
    case "locations":
      return `Location: ${list(filter.locations!)}`;
    case "job_types":
      return `Type: ${list(filter.job_types!, jobTypeLabel)}`;
    case "sources":
      return `Source: ${list(filter.sources!, siteLabel)}`;
    case "date_posted":
      return filter.date_posted_unknown ? "Posted: unknown" : `Posted: ${rangeLabel(filter.date_posted!)}`;
    case "first_seen":
    case "added":
    case "updated":
      return `${filterNames[key]}: ${rangeLabel(filter[key]!)}`;
    case "salary": {
      const salary = filter.salary!;
      if (salary.min == null && salary.max == null) return salary.presence === "unknown" ? "No salary" : "Has salary";
      const amount = (value: number) => value.toLocaleString("en-US");
      const range =
        salary.min != null && salary.max != null
          ? `${amount(salary.min)}–${amount(salary.max)}`
          : salary.min != null
            ? `≥ ${amount(salary.min)}`
            : `≤ ${amount(salary.max!)}`;
      return `Salary: ${salary.currency} ${range} / ${salary.interval}`;
    }
  }
}

// ---- Sorting and columns ----

export type ColumnKey =
  | "score"
  | "title"
  | "company"
  | "reason"
  | "directions"
  | "location"
  | "date_posted"
  | "job_type"
  | "sources"
  | "first_seen"
  | "status"
  | "notes"
  | "added"
  | "updated"
  | "link";

export interface ColumnDef {
  label: string;
  width: number;
  /** Sort key; missing means the column can't be sorted (several values or free text). */
  sort?: string;
  /** Scores and times sort newest/highest first on the first click; text sorts A→Z. */
  descFirst?: boolean;
  align?: "end";
}

export const columns: Record<ColumnKey, ColumnDef> = {
  score: { label: "Score", width: 64, sort: "score", descFirst: true },
  title: { label: "Role", width: 240, sort: "title" },
  company: { label: "Company", width: 170, sort: "company" },
  reason: { label: "Why", width: 300 },
  directions: { label: "Searches", width: 170 },
  location: { label: "Location", width: 150, sort: "location" },
  date_posted: { label: "Posted", width: 84, sort: "date_posted", descFirst: true },
  job_type: { label: "Type", width: 100, sort: "job_type" },
  sources: { label: "Source", width: 120 },
  first_seen: { label: "Found", width: 84, sort: "first_seen", descFirst: true },
  status: { label: "Status", width: 140, sort: "status" },
  notes: { label: "Notes", width: 260 },
  added: { label: "Added", width: 84, sort: "added", descFirst: true },
  updated: { label: "Updated", width: 88, sort: "updated", descFirst: true },
  link: { label: "Link", width: 90 },
};

/** Column order on each page; the menu only shows or hides them. */
export const pageColumns: Record<ListPage, ColumnKey[]> = {
  jobs: ["score", "title", "company", "reason", "directions", "location", "job_type", "sources", "date_posted", "first_seen"],
  shortlist: ["score", "title", "company", "status", "notes", "reason", "directions", "location", "job_type", "sources", "link", "date_posted", "first_seen", "added", "updated"],
};

export const defaultVisible: Record<ListPage, ColumnKey[]> = {
  jobs: ["score", "title", "company", "reason", "directions", "location", "date_posted"],
  shortlist: ["score", "title", "company", "status", "notes", "directions", "location", "added"],
};

export const defaultSort: Record<ListPage, Sort> = { jobs: "first_seen_desc", shortlist: "added_desc" };
export const pageSizes = [50, 100, 200] as const;
export const MIN_COLUMN_WIDTH = 48;

export interface ListPrefs {
  filter: ListFilter;
  sort: Sort;
  pageSize: number;
  visible: ColumnKey[];
  widths: Partial<Record<ColumnKey, number>>;
}

export const defaultListPrefs = (page: ListPage): ListPrefs => ({
  filter: {},
  sort: defaultSort[page],
  pageSize: 50,
  visible: defaultVisible[page],
  widths: {},
});

// ---- Validation of stored preferences (they are local and may be stale or edited) ----

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isScore = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10;

function readRange(value: unknown): DateRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const range = value as Record<string, unknown>;
  if (Number.isInteger(range.days) && (range.days as number) >= 1 && (range.days as number) <= 3650) return { days: range.days as number };
  const result: { from?: string; to?: string } = {};
  if (isDay(range.from)) result.from = range.from;
  if (isDay(range.to)) result.to = range.to;
  if (!result.from && !result.to) return undefined;
  if (result.from && result.to && result.from > result.to) return undefined;
  return result;
}

function readFilter(page: ListPage, value: unknown): ListFilter {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const filter: ListFilter = {};
  if (typeof raw.text === "string" && raw.text) filter.text = raw.text;
  for (const key of ["direction_ids", "sources", "companies", "locations", "job_types"] as const) {
    if (isStringArray(raw[key]) && raw[key].length) filter[key] = raw[key];
  }
  if (isStringArray(raw.score_states)) {
    const states = raw.score_states.filter((state): state is ScoreState => scoreStates.includes(state as ScoreState));
    if (states.length) filter.score_states = states;
  }
  if (isScore(raw.score_min)) filter.score_min = raw.score_min;
  if (isScore(raw.score_max) && (filter.score_min == null || raw.score_max >= filter.score_min)) filter.score_max = raw.score_max;
  if (page === "jobs" && typeof raw.in_applications === "boolean") filter.in_applications = raw.in_applications;
  if (page === "jobs" && isStringArray(raw.run_ids) && raw.run_ids.length) filter.run_ids = raw.run_ids;
  if (page === "shortlist" && isStringArray(raw.application_statuses)) {
    const chosen = raw.application_statuses.filter((status): status is ApplicationStatus => statuses.includes(status as ApplicationStatus));
    if (chosen.length) filter.application_statuses = chosen;
  }
  const keys = page === "shortlist" ? (["first_seen", "date_posted", "added", "updated"] as const) : (["first_seen", "date_posted"] as const);
  for (const key of keys) {
    const range = readRange(raw[key]);
    if (range) filter[key] = range;
  }
  if (raw.date_posted_unknown === true) {
    filter.date_posted_unknown = true;
    delete filter.date_posted;
  }
  if (raw.salary && typeof raw.salary === "object") {
    const s = raw.salary as Record<string, unknown>;
    const salary: Salary = {};
    if (s.presence === "known" || s.presence === "unknown") salary.presence = s.presence;
    const amount = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (typeof s.currency === "string" && s.currency && salaryIntervals.includes(s.interval as string) && (amount(s.min) || amount(s.max))) {
      if (amount(s.min)) salary.min = s.min as number;
      if (amount(s.max)) salary.max = s.max as number;
      salary.currency = s.currency;
      salary.interval = s.interval as string;
      if (salary.min != null && salary.max != null && salary.min > salary.max) delete salary.max;
      if (salary.presence === "unknown") delete salary.presence;
    }
    if (Object.keys(salary).length) filter.salary = salary;
  }
  return filter;
}

export function readListPrefs(page: ListPage, value: unknown): ListPrefs {
  const fallback = defaultListPrefs(page);
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;
  const allowed = pageColumns[page];
  const sortable = new Set(allowed.flatMap((key) => (columns[key].sort ? [`${columns[key].sort}_asc`, `${columns[key].sort}_desc`] : [])));
  const visible = isStringArray(raw.visible) ? allowed.filter((key) => (raw.visible as string[]).includes(key)) : fallback.visible;
  const widths: ListPrefs["widths"] = {};
  if (raw.widths && typeof raw.widths === "object") {
    for (const key of allowed) {
      const width = (raw.widths as Record<string, unknown>)[key];
      if (typeof width === "number" && Number.isFinite(width)) widths[key] = Math.max(MIN_COLUMN_WIDTH, Math.min(1200, Math.round(width)));
    }
  }
  return {
    filter: readFilter(page, raw.filter),
    sort: typeof raw.sort === "string" && sortable.has(raw.sort) ? (raw.sort as Sort) : fallback.sort,
    pageSize: pageSizes.includes(raw.pageSize as 50) ? (raw.pageSize as number) : fallback.pageSize,
    visible: visible.length ? visible : fallback.visible,
    widths,
  };
}
