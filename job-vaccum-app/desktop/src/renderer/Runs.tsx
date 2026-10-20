import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { call, type ApiError, type RunDetail, type RunParameters, type RunSummary, type RunTask, type TaskCounts } from "./api";
import { useApp, type SettingsSection } from "./context";
import { formatRunTime, formatTime, isActiveRun, plural, runStageLabels, runStatusLabels, runStatusTone, siteLabel } from "./format";
import { AlertIcon, ChevronLeft, ChevronRight, RunsIcon } from "./icons";
import type { TopbarSlots } from "./ListView";
import { ErrorText } from "./Settings";
import { useToast } from "./toasts";

// Layout to be confirmed: SPEC has no Runs design yet, so this page reuses the
// list/settings building blocks (card, side list, rows, tables, banners).

interface Preview {
  task_count: number;
  parameters: RunParameters;
  auto_score_enabled: boolean;
}

const TASK_PAGE_SIZE = 50;

export function Runs({ slots }: { slots: TopbarSlots }) {
  const { api, catalog, runs, refreshRuns, runVersion, navigate } = useApp();
  const toast = useToast();
  const [preview, setPreview] = useState<{ data?: Preview; error?: ApiError }>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  // The plan follows the saved settings; it never touches the network.
  useEffect(() => {
    let current = true;
    void call(() => api.previewRun()).then((response) => {
      if (current) setPreview(response.ok ? { data: response.result } : { error: response.error });
    });
    return () => {
      current = false;
    };
  }, [api, catalog.settings, catalog.directions]);

  const selected = runs.items.find((run) => run.id === selectedId) ?? runs.items[0] ?? null;
  const active = runs.active;

  const start = async () => {
    setStarting(true);
    const response = await call(() => api.startRun());
    setStarting(false);
    // A start that timed out may still have begun; the refreshed status shows it.
    refreshRuns();
    if (!response.ok) {
      toast({ text: `Couldn't start the run. ${response.error.message}`, code: response.error.code, error: true });
      return;
    }
    setSelectedId(response.result.run_id);
  };
  const stop = async () => {
    if (!active) return;
    setStopping(true);
    const response = await call(() => api.stopRun({ run_id: active.run_id }));
    setStopping(false);
    refreshRuns();
    if (!response.ok) toast({ text: `Couldn't stop the run. ${response.error.message}`, code: response.error.code, error: true });
  };

  const blocked = active ? "A run is already in progress" : preview.error ? preview.error.message : undefined;
  const actions = (
    <>
      {active ? (
        <button type="button" className="button" disabled={stopping || active.status === "stopping"} onClick={() => void stop()} title="Stop dispatching tasks; finished tasks are kept">
          {active.status === "stopping" ? "Stopping…" : "Stop"}
        </button>
      ) : null}
      <button type="button" className="button button-primary" disabled={starting || !!active || !preview.data} onClick={() => void start()} title={blocked ?? "Search now with the current settings"}>
        {starting ? "Starting…" : "Run now"}
      </button>
    </>
  );
  const subtitle = runs.loaded ? plural(runs.total, "run") : "";

  return (
    <section className="runs-view" aria-label="Runs">
      {slots.actions ? createPortal(actions, slots.actions) : null}
      {slots.subtitle ? createPortal(subtitle, slots.subtitle) : null}
      <RunPlan preview={preview} onEdit={(section) => navigate("settings", section)} />
      {runs.error ? (
        <div className="banner" role="alert">
          <AlertIcon />
          <span className="banner-text">
            Couldn't load runs. {runs.error.message}
            <span className="error-code"> {runs.error.code}</span>
          </span>
          <button type="button" className="button" onClick={refreshRuns}>
            Try again
          </button>
        </div>
      ) : null}
      {!runs.loaded ? (
        runs.error ? null : (
          <div className="empty">
            <p className="muted">Loading runs…</p>
          </div>
        )
      ) : !selected ? (
        <div className="empty">
          <span className="empty-icon">
            <RunsIcon size={28} />
          </span>
          <h2>No runs yet</h2>
          <p className="muted">{preview.data ? "Click Run now to search with your current settings." : "Set up a search with a query and a location, then run it here."}</p>
        </div>
      ) : (
        <div className="runs-body">
          <nav className="run-list" aria-label="Run history">
            {runs.items.map((run) => (
              <RunItem key={run.id} run={run} current={run.id === selected.id} onSelect={() => setSelectedId(run.id)} />
            ))}
            {runs.total > runs.items.length ? <p className="muted small run-list-note">Showing the newest {runs.items.length} runs.</p> : null}
          </nav>
          <RunDetailView key={selected.id} summary={selected} version={runVersion} />
        </div>
      )}
    </section>
  );
}

/** What Run now will do with the saved settings, or why it can't run yet. */
function RunPlan({ preview, onEdit }: { preview: { data?: Preview; error?: ApiError }; onEdit: (section: SettingsSection) => void }) {
  if (preview.error) {
    const { code, message } = preview.error;
    const section: SettingsSection = code === "PROXY_ERROR" || /proxy/i.test(message) ? "proxy" : /scor/i.test(message) ? "filters" : "searches";
    const label = { proxy: "Proxy settings", filters: "Filters & scoring", searches: "Edit searches" }[section as "proxy" | "filters" | "searches"];
    return (
      <div className="run-plan" data-tone="error">
        <span>
          <strong>Can't run yet.</strong> {message} <span className="error-code">{code}</span>
        </span>
        <button type="button" className="link-button" onClick={() => onEdit(section)}>
          {label}
        </button>
      </div>
    );
  }
  if (!preview.data) return <div className="run-plan muted">Checking settings…</div>;
  const { task_count: count, parameters, auto_score_enabled: scoring } = preview.data;
  const days = parameters.hours_old > 0 ? Math.round(parameters.hours_old / 24) : null;
  return (
    <div className="run-plan">
      <span>
        <strong>Next run: {plural(count, "task")}</strong> — every enabled query × location × site. Up to {parameters.results_wanted.linkedin} LinkedIn and{" "}
        {parameters.results_wanted.indeed} Indeed results per task{days ? `, posted in the last ${plural(days, "day")}` : ""}. Auto-scoring {scoring ? "on" : "off"}.
      </span>
      <button type="button" className="link-button" onClick={() => onEdit("searches")}>
        Edit searches
      </button>
    </div>
  );
}

function StatusLabel({ run }: { run: Pick<RunSummary, "status" | "stage"> }) {
  return (
    <span className="status-text run-status" data-tone={runStatusTone(run.status)}>
      <span className="dot" aria-hidden="true" />
      {runStatusLabels[run.status]}
      {run.stage && run.status === "running" ? ` · ${runStageLabels[run.stage]}` : ""}
    </span>
  );
}

function RunItem({ run, current, onSelect }: { run: RunSummary; current: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="run-item" aria-current={current ? "true" : undefined} onClick={onSelect}>
      <span className="run-item-time">{formatRunTime(run.started_at)}</span>
      <span className="run-item-meta">
        <StatusLabel run={run} />
        <span className="muted">{run.new_job_count.toLocaleString("en-US")} new</span>
      </span>
    </button>
  );
}

function duration(from: number, to: number) {
  const minutes = Math.round((to - from) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return plural(minutes, "minute");
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function RunDetailView({ summary, version }: { summary: RunSummary; version: number }) {
  const { api, openBatch } = useApp();
  const [taskPage, setTaskPage] = useState(1);
  const [state, setState] = useState<{ data?: RunDetail; error?: ApiError; loading: boolean }>({ loading: true });
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const id = ++sequence.current;
    setState((previous) => ({ ...previous, loading: true }));
    void call(() => api.getRunDetail({ run_id: summary.id, task_page: taskPage, task_page_size: TASK_PAGE_SIZE })).then((response) => {
      if (id !== sequence.current) return;
      setState((previous) => (response.ok ? { data: response.result, loading: false } : { data: previous.data, error: response.error, loading: false }));
    });
  }, [api, summary.id, taskPage, version, reload]);

  // The list summary updates with every run event; the detail adds the snapshot and tasks.
  const run = { ...state.data, ...summary };
  const stats = run.stats;
  const scoringOff = state.data ? !state.data.config_snapshot.auto_score_enabled : null;
  const retrievalTasks = (state.data?.tasks ?? []).filter((task): task is Extract<RunTask, { kind: "retrieval" }> => task.kind === "retrieval");
  const lastTaskPage = Math.max(1, Math.ceil(stats.retrieval.total / TASK_PAGE_SIZE));

  return (
    <div className="run-detail" aria-label="Run details" role="region">
      <header className="run-header">
        <h2>{formatTime(run.started_at)}</h2>
        <StatusLabel run={run} />
        <p className="muted">
          {run.finished_at != null ? `Finished ${formatTime(run.finished_at)} · took ${duration(run.started_at, run.finished_at)}` : isActiveRun(run.status) ? "In progress" : ""}
        </p>
      </header>
      {run.error ? <ErrorText error={run.error} block /> : null}
      {state.error ? (
        <div className="banner" role="alert">
          <AlertIcon />
          <span className="banner-text">
            Couldn't load this run. {state.error.message}
            <span className="error-code"> {state.error.code}</span>
          </span>
          <button type="button" className="button" disabled={state.loading} onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : null}

      <div className="run-progress">
        <Progress label="Retrieval" counts={stats.retrieval} />
        {scoringOff ? (
          <div className="progress-row">
            <span className="progress-label">Scoring</span>
            <span className="muted">Auto-scoring was off for this run; new jobs are unscored.</span>
          </div>
        ) : scoringOff === false ? (
          <Progress label="Scoring" counts={stats.scoring} />
        ) : null}
      </div>

      <dl className="run-totals">
        <Total label="Received">{stats.received_count.toLocaleString("en-US")}</Total>
        <Total label="Filtered out">{stats.filtered_count.toLocaleString("en-US")}</Total>
        <Total label="Matched jobs" hint="Jobs this run found, including ones already saved">
          {stats.matched_job_count.toLocaleString("en-US")}
        </Total>
        <Total label="New jobs">
          {summary.new_job_count ? (
            <button type="button" className="link-button" onClick={() => openBatch(summary.id)} title="Show the jobs first found by this run in Jobs">
              {summary.new_job_count.toLocaleString("en-US")} new
            </button>
          ) : (
            "0"
          )}
        </Total>
      </dl>

      <section aria-labelledby="filter-reasons-title" className="run-section">
        <h3 id="filter-reasons-title">Filtered by rule</h3>
        {Object.keys(stats.filter_reasons ?? {}).length ? (
          <dl className="run-totals">
            {Object.entries(stats.filter_reasons ?? {}).map(([reason, count]) => (
              <Total key={reason} label={filterReasonLabels[reason] ?? reason}>{count.toLocaleString("en-US")}</Total>
            ))}
          </dl>
        ) : <p className="muted">No jobs filtered out.</p>}
      </section>

      <section aria-labelledby="by-search-title" className="run-section">
        <h3 id="by-search-title">By search</h3>
        {stats.directions.length ? (
          <>
            <div className="run-table-scroll">
              <table className="settings-table run-table" aria-labelledby="by-search-title">
                <thead>
                  <tr>
                    <th>Search</th>
                    <th className="number-cell">Received</th>
                    <th className="number-cell">Filtered out</th>
                    <th className="number-cell">Matched</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.directions.map((direction) => (
                    <tr key={direction.direction_id}>
                      <td className="name-cell">{direction.name}</td>
                      <td className="number-cell">{direction.received_count.toLocaleString("en-US")}</td>
                      <td className="number-cell">{direction.filtered_count.toLocaleString("en-US")}</td>
                      <td className="number-cell">{direction.matched_job_count.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Received counts repeats. A job found by several searches counts under each.</p>
          </>
        ) : (
          <p className="muted">No results by search yet.</p>
        )}
      </section>

      <section aria-labelledby="tasks-title" className="run-section">
        <div className="run-section-header">
          <h3 id="tasks-title">Tasks</h3>
          {lastTaskPage > 1 ? (
            <div className="pager">
              <span className="muted small">
                Page {taskPage} of {lastTaskPage}
              </span>
              <button type="button" className="icon-button" aria-label="Previous tasks" disabled={taskPage <= 1} onClick={() => setTaskPage(taskPage - 1)}>
                <ChevronLeft />
              </button>
              <button type="button" className="icon-button" aria-label="Next tasks" disabled={taskPage >= lastTaskPage} onClick={() => setTaskPage(taskPage + 1)}>
                <ChevronRight />
              </button>
            </div>
          ) : null}
        </div>
        {!state.data && state.loading ? (
          <p className="muted">Loading tasks…</p>
        ) : retrievalTasks.length ? (
          <div className="run-table-scroll">
            <table className="settings-table run-table" aria-labelledby="tasks-title">
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Location</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th className="number-cell">Tries</th>
                  <th className="number-cell">Received</th>
                  <th className="number-cell">Filtered</th>
                  <th className="number-cell">Matched</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {retrievalTasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No tasks.</p>
        )}
      </section>
    </div>
  );
}

function Total({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div title={hint}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Task counts as text plus a bar; no motion, the numbers change with each event. */
function Progress({ label, counts }: { label: string; counts: TaskCounts }) {
  const done = counts.succeeded + counts.failed + counts.cancelled;
  const share = (value: number) => (counts.total ? `${(value / counts.total) * 100}%` : "0%");
  const parts = [
    counts.failed ? `${counts.failed} failed` : "",
    counts.active ? `${counts.active} running` : "",
    counts.pending ? `${counts.pending} waiting` : "",
    counts.cancelled ? `${counts.cancelled} cancelled` : "",
  ].filter(Boolean);
  return (
    <div className="progress-row">
      <span className="progress-label">{label}</span>
      <div
        className="progress-bar"
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={counts.total}
        aria-valuenow={done}
      >
        <span className="progress-ok" style={{ width: share(counts.succeeded) }} />
        <span className="progress-failed" style={{ width: share(counts.failed) }} />
      </div>
      <span className="progress-text">
        {counts.total ? `${done} of ${plural(counts.total, "task")} done` : "No tasks"}
        {parts.length ? <span className="muted"> · {parts.join(" · ")}</span> : null}
      </span>
    </div>
  );
}

const taskStatusLabels: Record<RunTask["status"], string> = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
const taskTone = (status: RunTask["status"]) => (status === "succeeded" ? "ok" : status === "failed" ? "error" : status === "cancelled" ? "neutral" : "pending");

const filterReasonLabels: Record<string, string> = {
  company: "Excluded company",
  empty_record: "Missing title or description",
  part_time: "Part-time",
  test_jobs: "Test posting",
  senior_title: "Senior title",
  experience: "Experience",
  authorization: "Work authorization",
  language: "Language",
  graduation: "Graduation date",
  degree: "Degree",
};

function TaskRow({ task }: { task: Extract<RunTask, { kind: "retrieval" }> }) {
  const stats = task.stats;
  const notes: string[] = [];
  if (task.status === "succeeded" && stats.received_count === 0) notes.push("No results");
  if (stats.missing_jd_count) notes.push(`${stats.missing_jd_count} without description`);
  if (stats.http_429) notes.push(`Rate limited ${stats.http_429}×`);
  if (stats.warnings?.length) notes.push(plural(stats.warnings.length, "warning"));
  const reasons = Object.entries(stats.filter_reasons ?? {})
    .map(([reason, count]) => `${filterReasonLabels[reason] ?? reason}: ${count}`)
    .join("\n");
  const show = (value: number | undefined) => (value == null ? "—" : value.toLocaleString("en-US"));
  return (
    <tr>
      <td className="name-cell">{task.spec.expression}</td>
      <td>
        {task.spec.location}
        {task.spec.distance_miles ? <span className="muted"> · {task.spec.distance_miles} mi</span> : null}
      </td>
      <td>{siteLabel(task.spec.site)}</td>
      <td>
        <span className="status-text" data-tone={taskTone(task.status)}>
          <span className="dot" aria-hidden="true" />
          {taskStatusLabels[task.status]}
        </span>
      </td>
      <td className="number-cell">{task.attempt_count}</td>
      <td className="number-cell">{show(stats.received_count)}</td>
      <td className="number-cell" title={reasons || undefined}>
        {show(stats.filtered_count)}
      </td>
      <td className="number-cell">{show(stats.matched_job_count)}</td>
      <td className="task-notes" title={stats.warnings?.join("\n") || undefined}>
        {task.error ? (
          <span className="error-text">
            {task.error.message} <span className="error-code">{task.error.code}</span>
          </span>
        ) : null}
        {task.error && notes.length ? " · " : null}
        {notes.length ? <span className="muted">{notes.join(" · ")}</span> : null}
      </td>
    </tr>
  );
}
