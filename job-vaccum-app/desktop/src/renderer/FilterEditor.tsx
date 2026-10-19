import { useState, type FormEvent, type ReactNode } from "react";
import type { ApplicationStatus, Direction, JobSummary, ScoreState } from "./api";
import type { RunsState } from "./context";
import { batchLabel, jobTypeLabel, knownJobTypes, knownSites, salaryIntervals, scoreStateLabels, scoreStates, siteLabel, statusLabels, statuses } from "./format";
import { filterNames, quickRangeLabel, quickRanges, withoutKey, type DateRange, type FilterKey, type ListFilter, type Salary } from "./listModel";
import { Popover } from "./ui";

interface EditorProps {
  field: FilterKey;
  filter: ListFilter;
  anchor: HTMLElement;
  directions: Direction[];
  counts: Record<string, number>;
  /** Retrieval runs offered as batches (Jobs only). */
  runs: RunsState;
  /** Rows on the current page, used to offer company, location, type and source values. */
  items: JobSummary[];
  onApply: (filter: ListFilter) => void;
  onClose: () => void;
}

/**
 * One popover per filter dimension. Changes are a draft until Apply (or
 * Return); Esc or a click elsewhere leaves the filter as it was.
 */
export function FilterEditor(props: EditorProps) {
  const { field, filter, onApply, onClose } = props;
  const active = JSON.stringify(withoutKey(filter, field)) !== JSON.stringify(filter);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ListFilter>(filter);
  const change = (next: Partial<ListFilter>) => {
    setError(null);
    setDraft((current) => ({ ...current, ...next }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = validate(field, draft);
    if (problem) {
      setError(problem);
      return;
    }
    onApply(normalize(field, draft));
    onClose();
  };

  return (
    <Popover anchor={props.anchor} onClose={onClose} label={`${filterNames[field]} filter`} className="filter-editor">
      <form onSubmit={submit} noValidate>
        <h3 className="editor-title">{filterNames[field]}</h3>
        <EditorBody {...props} draft={draft} change={change} />
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="editor-footer">
          {active ? (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                onApply(withoutKey(filter, field));
                onClose();
              }}
            >
              Remove filter
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            Apply
          </button>
        </div>
      </form>
    </Popover>
  );
}

function toggle<T>(values: T[] | undefined, value: T, on: boolean): T[] {
  const set = new Set(values ?? []);
  if (on) set.add(value);
  else set.delete(value);
  return [...set];
}

function Checks<T extends string>({
  options,
  values,
  label,
  onChange,
  render,
}: {
  options: T[];
  values: T[] | undefined;
  label: string;
  onChange: (values: T[]) => void;
  render?: (value: T) => ReactNode;
}) {
  if (!options.length) return <p className="muted small">Nothing to choose from on this page yet.</p>;
  return (
    <div className="check-list" role="group" aria-label={label}>
      {options.map((option) => (
        <label key={option} className="check-row">
          <input
            type="checkbox"
            className="checkbox"
            checked={values?.includes(option) ?? false}
            onChange={(event) => onChange(toggle(values, option, event.target.checked))}
          />
          <span className="check-label">{render ? render(option) : option}</span>
        </label>
      ))}
    </div>
  );
}

/** Values seen on the current page plus already chosen ones, for exact-match filters. */
function pageValues(items: JobSummary[], pick: (job: JobSummary) => (string | null)[], chosen: string[] = [], known: string[] = []) {
  const values = new Set<string>([...known, ...chosen]);
  for (const job of items) for (const value of pick(job)) if (value) values.add(value);
  return [...values].sort((a, b) => a.localeCompare(b));
}

function EditorBody({
  field,
  draft,
  change,
  directions,
  counts,
  runs,
  items,
}: EditorProps & { draft: ListFilter; change: (next: Partial<ListFilter>) => void }) {
  switch (field) {
    case "direction_ids":
      return directions.length ? (
        <Checks
          label="Searches"
          options={directions.map((direction) => direction.id)}
          values={draft.direction_ids}
          onChange={(direction_ids) => change({ direction_ids })}
          render={(id) => (
            <>
              {directions.find((direction) => direction.id === id)?.name}
              <span className="muted"> {counts[id] ?? ""}</span>
            </>
          )}
        />
      ) : (
        <p className="muted small">No searches yet.</p>
      );
    case "run_ids":
      return <BatchBody runs={runs} values={draft.run_ids} onChange={(run_ids) => change({ run_ids })} />;
    case "score":
      return <ScoreBody draft={draft} change={change} />;
    case "in_applications":
      return (
        <div className="check-list" role="radiogroup" aria-label="In Shortlist">
          {(
            [
              [undefined, "Any"],
              [false, "Not in Shortlist"],
              [true, "In Shortlist"],
            ] as const
          ).map(([value, label]) => (
            <label key={label} className="check-row">
              <input type="radio" name="in-applications" checked={draft.in_applications === value} onChange={() => change({ in_applications: value })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      );
    case "application_statuses":
      return (
        <Checks
          label="Status"
          options={statuses}
          values={draft.application_statuses}
          onChange={(application_statuses) => change({ application_statuses: application_statuses as ApplicationStatus[] })}
          render={(status) => (
            <span className="status-option">
              <span className="status-dot" data-status={status} aria-hidden="true" />
              {statusLabels[status as ApplicationStatus]}
            </span>
          )}
        />
      );
    case "companies":
    case "locations":
      return (
        <ValuesBody
          label={filterNames[field]}
          values={draft[field]}
          options={pageValues(items, (job) => [field === "companies" ? job.company : job.location], draft[field])}
          onChange={(values) => change({ [field]: values })}
        />
      );
    case "job_types":
      return (
        <Checks
          label="Type"
          options={pageValues(items, (job) => [job.job_type], draft.job_types, knownJobTypes)}
          values={draft.job_types}
          onChange={(job_types) => change({ job_types })}
          render={jobTypeLabel}
        />
      );
    case "sources":
      return (
        <Checks
          label="Source"
          options={pageValues(items, (job) => job.sources.map((source) => source.site), draft.sources, knownSites)}
          values={draft.sources}
          onChange={(sources) => change({ sources })}
          render={siteLabel}
        />
      );
    case "first_seen":
    case "added":
    case "updated":
      return <RangeBody label={filterNames[field]} range={draft[field]} onChange={(range) => change({ [field]: range })} />;
    case "date_posted":
      return (
        <RangeBody
          label="Posted"
          range={draft.date_posted}
          unknown={draft.date_posted_unknown ?? false}
          onChange={(range, unknown) => change({ date_posted: range, date_posted_unknown: unknown || undefined })}
        />
      );
    case "salary":
      return <SalaryBody salary={draft.salary} onChange={(salary) => change({ salary })} />;
    case "text":
      return null;
  }
}

/** All, or one or more runs; each job belongs to the run that first found it. */
function BatchBody({ runs, values, onChange }: { runs: RunsState; values: string[] | undefined; onChange: (values: string[]) => void }) {
  if (runs.error && !runs.items.length) return <p className="field-error">Couldn't load runs. {runs.error.message}</p>;
  if (!runs.loaded) return <p className="muted small">Loading runs…</p>;
  // A chosen run that is no longer listed stays visible so it can be unchecked.
  const listed = new Set(runs.items.map((run) => run.id));
  const extra = (values ?? []).filter((id) => !listed.has(id));
  return (
    <>
      <label className="check-row">
        <input type="checkbox" className="checkbox" checked={!values?.length} onChange={() => onChange([])} />
        <span className="check-label">All batches</span>
      </label>
      {runs.items.length || extra.length ? (
        <div className="scroll-list">
          <Checks
            label="Batches"
            options={[...runs.items.map((run) => run.id), ...extra]}
            values={values}
            onChange={onChange}
            render={(id) => {
              const run = runs.items.find((item) => item.id === id);
              return run ? batchLabel(run) : "Earlier run";
            }}
          />
        </div>
      ) : (
        <p className="muted small">No runs yet.</p>
      )}
      <p className="muted small">Shows jobs first found by the chosen runs. Jobs found again later stay with their first run.</p>
    </>
  );
}

function ScoreBody({ draft, change }: { draft: ListFilter; change: (next: Partial<ListFilter>) => void }) {
  const number = (value: string) => (value.trim() === "" ? undefined : Number(value));
  // Raw text keeps what was typed visible; validation reports anything that isn't 0–10.
  const [minText, setMinText] = useState(draft.score_min?.toString() ?? "");
  const [maxText, setMaxText] = useState(draft.score_max?.toString() ?? "");
  return (
    <>
      <div className="quick-row" role="group" aria-label="Score shortcuts">
        {(
          [
            ["8+", 8, undefined],
            ["6+", 6, undefined],
            ["0–5", 0, 5],
          ] as const
        ).map(([label, min, max]) => (
          <button
            key={label}
            type="button"
            className="button button-small"
            aria-pressed={draft.score_min === min && draft.score_max === max}
            onClick={() => {
              setMinText(min.toString());
              setMaxText(max?.toString() ?? "");
              change({ score_min: min, score_max: max });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="inline-fields">
        <label>
          From
          <input
            className="text-input number-input"
            inputMode="numeric"
            value={minText}
            aria-label="Lowest score"
            onChange={(event) => {
              setMinText(event.target.value);
              change({ score_min: number(event.target.value) });
            }}
          />
        </label>
        <label>
          to
          <input
            className="text-input number-input"
            inputMode="numeric"
            value={maxText}
            aria-label="Highest score"
            onChange={(event) => {
              setMaxText(event.target.value);
              change({ score_max: number(event.target.value) });
            }}
          />
        </label>
      </div>
      <p className="muted small">A range only matches jobs that have a score.</p>
      <h4 className="editor-subtitle">Scoring status</h4>
      <Checks
        label="Scoring status"
        options={scoreStates}
        values={draft.score_states}
        onChange={(score_states) => change({ score_states: score_states as ScoreState[] })}
        render={(state) => scoreStateLabels[state as ScoreState]}
      />
    </>
  );
}

function ValuesBody({ label, values, options, onChange }: { label: string; values: string[] | undefined; options: string[]; onChange: (values: string[]) => void }) {
  const [typed, setTyped] = useState("");
  const add = () => {
    const value = typed.trim();
    if (value) onChange(toggle(values, value, true));
    setTyped("");
  };
  return (
    <>
      <div className="add-value">
        <input
          className="text-input"
          value={typed}
          placeholder={`Add ${label.toLowerCase()}…`}
          aria-label={`Add ${label.toLowerCase()}`}
          data-autofocus
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed.trim()) {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="button button-small" disabled={!typed.trim()} onClick={add}>
          Add
        </button>
      </div>
      <p className="muted small">Matches the exact {label.toLowerCase()} name.</p>
      <div className="scroll-list">
        <Checks label={label} options={options} values={values} onChange={onChange} />
      </div>
    </>
  );
}

function RangeBody({
  label,
  range,
  unknown,
  onChange,
}: {
  label: string;
  range: DateRange | undefined;
  unknown?: boolean;
  onChange: (range: DateRange | undefined, unknown?: boolean) => void;
}) {
  const custom = range && !("days" in range) ? range : undefined;
  const [mode, setMode] = useState<string>(unknown ? "unknown" : range ? ("days" in range ? String(range.days) : "custom") : "");
  const choose = (value: string) => {
    setMode(value);
    if (value === "unknown") onChange(undefined, true);
    else if (value === "custom") onChange(custom ?? {}, false);
    else onChange({ days: Number(value) }, false);
  };
  return (
    <div className="check-list" role="radiogroup" aria-label={label}>
      {quickRanges.map((days) => (
        <label key={days} className="check-row">
          <input type="radio" name={`${label}-range`} checked={mode === String(days)} onChange={() => choose(String(days))} />
          <span>{quickRangeLabel(days)}</span>
        </label>
      ))}
      <label className="check-row">
        <input type="radio" name={`${label}-range`} checked={mode === "custom"} onChange={() => choose("custom")} />
        <span>Custom dates</span>
      </label>
      {mode === "custom" ? (
        <div className="inline-fields date-fields">
          <label>
            From
            <input
              type="date"
              className="text-input"
              value={custom?.from ?? ""}
              onChange={(event) => onChange({ ...custom, from: event.target.value || undefined })}
            />
          </label>
          <label>
            to
            <input
              type="date"
              className="text-input"
              value={custom?.to ?? ""}
              onChange={(event) => onChange({ ...custom, to: event.target.value || undefined })}
            />
          </label>
        </div>
      ) : null}
      {unknown !== undefined ? (
        <label className="check-row">
          <input type="radio" name={`${label}-range`} checked={mode === "unknown"} onChange={() => choose("unknown")} />
          <span>Posting date unknown</span>
        </label>
      ) : null}
    </div>
  );
}

function SalaryBody({ salary, onChange }: { salary: Salary | undefined; onChange: (salary: Salary | undefined) => void }) {
  const value = salary ?? {};
  const set = (change: Partial<Salary>) => {
    const next = { ...value, ...change };
    onChange(Object.values(next).some((item) => item !== undefined) ? next : undefined);
  };
  const amount = (text: string) => (text.trim() === "" ? undefined : Number(text.replaceAll(",", "")));
  const [minText, setMinText] = useState(value.min?.toString() ?? "");
  const [maxText, setMaxText] = useState(value.max?.toString() ?? "");
  return (
    <>
      <div className="check-list" role="radiogroup" aria-label="Salary information">
        {(
          [
            [undefined, "Any"],
            ["known", "Has salary"],
            ["unknown", "No salary"],
          ] as const
        ).map(([presence, label]) => (
          <label key={label} className="check-row">
            <input type="radio" name="salary-presence" checked={value.presence === presence} onChange={() => set({ presence })} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <h4 className="editor-subtitle">Range</h4>
      <div className="inline-fields salary-fields">
        <label>
          Min
          <input
            className="text-input"
            inputMode="numeric"
            value={minText}
            onChange={(event) => {
              setMinText(event.target.value);
              set({ min: amount(event.target.value) });
            }}
          />
        </label>
        <label>
          Max
          <input
            className="text-input"
            inputMode="numeric"
            value={maxText}
            onChange={(event) => {
              setMaxText(event.target.value);
              set({ max: amount(event.target.value) });
            }}
          />
        </label>
        <label>
          Currency
          <input
            className="text-input currency-input"
            value={value.currency ?? "USD"}
            maxLength={8}
            onChange={(event) => set({ currency: event.target.value.toUpperCase() || undefined })}
          />
        </label>
        <label>
          Per
          <select className="select" value={value.interval ?? "yearly"} onChange={(event) => set({ interval: event.target.value })}>
            {salaryIntervals.map((interval) => (
              <option key={interval} value={interval}>
                {interval}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">Overlaps the known salary range in this currency and period. No conversion.</p>
    </>
  );
}

function validate(field: FilterKey, draft: ListFilter): string | null {
  if (field === "score") {
    for (const value of [draft.score_min, draft.score_max]) {
      if (value != null && !(Number.isInteger(value) && value >= 0 && value <= 10)) return "Scores are whole numbers from 0 to 10.";
    }
    if (draft.score_min != null && draft.score_max != null && draft.score_min > draft.score_max) return "The lowest score can't be above the highest.";
  }
  if (["first_seen", "date_posted", "added", "updated"].includes(field)) {
    const range = draft[field as "first_seen"];
    if (range && !("days" in range)) {
      if (!range.from && !range.to) return "Choose at least one date.";
      if (range.from && range.to && range.from > range.to) return "The start date must be on or before the end date.";
    }
  }
  if (field === "salary" && draft.salary) {
    const { min, max, presence } = draft.salary;
    for (const value of [min, max]) if (value != null && !(Number.isFinite(value) && value >= 0)) return "Enter amounts as numbers, 0 or more.";
    if (min != null && max != null && min > max) return "Min can't be above max.";
    if ((min != null || max != null) && presence === "unknown") return "A salary range needs jobs that list a salary.";
  }
  return null;
}

/** Drops empty values so an applied editor never leaves a no-op chip. */
function normalize(field: FilterKey, draft: ListFilter): ListFilter {
  const next = { ...draft };
  for (const key of ["direction_ids", "run_ids", "sources", "companies", "locations", "job_types", "score_states", "application_statuses"] as const) {
    if (!next[key]?.length) delete next[key];
  }
  if (next.in_applications === undefined) delete next.in_applications;
  if (next.score_min === undefined) delete next.score_min;
  if (next.score_max === undefined) delete next.score_max;
  if (!next.date_posted_unknown) delete next.date_posted_unknown;
  for (const key of ["first_seen", "date_posted", "added", "updated"] as const) if (!next[key]) delete next[key];
  if (field === "salary" && next.salary) {
    const salary = { ...next.salary };
    if (salary.min == null && salary.max == null) {
      delete salary.currency;
      delete salary.interval;
    } else {
      salary.currency = (salary.currency ?? "USD").trim() || "USD";
      salary.interval = salary.interval ?? "yearly";
    }
    for (const key of Object.keys(salary) as (keyof Salary)[]) if (salary[key] === undefined) delete salary[key];
    if (Object.keys(salary).length) next.salary = salary;
    else delete next.salary;
  }
  return next;
}
