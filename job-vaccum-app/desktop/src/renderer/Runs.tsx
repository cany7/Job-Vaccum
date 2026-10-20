import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, type ApiError, type ApiResult, type JobVaccumApi, type RunDetail, type RunParameters, type RunSnapshot, type RunSummary, type RunTask, type Settings, type TaskCounts } from "./api";
import { useApp, type Catalog, type SettingsSection } from "./context";
import { formatClock, formatDay, formatRunTime, formatTime, isActiveRun, plural, runStageLabels, runStatusLabels, runStatusTone, siteLabel } from "./format";
import { AlertIcon } from "./icons";
import { ErrorText } from "./Settings";
import { useToast } from "./toasts";
import { Popover } from "./ui";

// SPEC «运行计划与进度» Runs layout: the left column holds Schedules (+) above a
// divider and the history cards below; the right column shows one run, or the
// new-run panel. Schedules themselves arrive with M7, so + only opens the panel.

interface Preview {
  task_count: number;
  parameters: RunParameters;
  auto_score_enabled: boolean;
}

const TASK_PAGE_SIZE = 200;
const RUN_LIMIT = 200;

/** Why runs can't start with the saved settings, as one short line and where to fix it. */
interface Setup {
  text: string;
  section: SettingsSection;
  link: string;
}

function setupOf(error: ApiError, settings: Settings | null): Setup {
  const searches = { section: "searches" as const, link: "Set up searches" };
  if (settings) {
    if (!settings.directions.some((d) => d.enabled && d.queries.some((q) => q.enabled))) return { text: "add a query", ...searches };
    if (!settings.cities.some((c) => c.enabled)) return { text: "add a location", ...searches };
    if (!settings.platforms.length) return { text: "choose a site", ...searches };
  }
  const { code, message } = error;
  if (code === "PROXY_ERROR" || /proxy/i.test(message)) return { text: "set up the proxy", section: "proxy", link: "Proxy settings" };
  if (code === "AUTH_ERROR" || /api key/i.test(message)) return { text: "save an API key", section: "model", link: "Model settings" };
  if (/scor|rubric|model/i.test(message)) return { text: "set up scoring or turn auto-scoring off", section: "filters", link: "Filters & scoring" };
  return { text: "check your search settings", ...searches };
}

/** "All searches", or the chosen searches by the names they had when the run started. */
const searchesLabel = (run: Pick<RunSummary, "searches">) =>
  run.searches == null ? "All searches" : run.searches.map((search) => search.name || "Deleted search").join(", ");

const doneOf = (counts: TaskCounts) => counts.succeeded + counts.failed + counts.cancelled;

export function Runs({ focus }: { focus: { id: string } | null }) {
  const { api, catalog, runs, refreshRuns, navigate } = useApp();
  const toast = useToast();
  const [check, setCheck] = useState<{ ok?: true; error?: ApiError }>({});
  const [selection, setSelection] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Whether any run can start with the saved settings; never touches the network.
  useEffect(() => {
    let current = true;
    void call(() => api.previewRun()).then((response) => {
      if (current) setCheck(response.ok ? { ok: true } : { error: response.error });
    });
    return () => {
      current = false;
    };
  }, [api, catalog.settings, catalog.directions]);

  // Opening a run from elsewhere (a scoring toast) selects it once.
  useEffect(() => {
    if (focus) setSelection(focus.id);
  }, [focus]);

  // Search runs and manual scoring runs share one history, newest first.
  const history = [...runs.items, ...runs.rescores].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const truncated = runs.total > runs.items.length || runs.rescoreTotal > runs.rescores.length;
  const selected = selection === "new" ? null : (history.find((run) => run.id === selection) ?? history[0] ?? null);
  const setup = check.error ? setupOf(check.error, catalog.settings) : null;
  // Every run button shares one reason; the active run wins over settings.
  const blocked = runs.active ? "A run is in progress" : setup ? `Can't run yet: ${setup.text}` : !check.ok ? "Checking settings…" : undefined;

  const start = async (directionIds: string[] | null) => {
    setStarting(true);
    const response = await call(() => api.startRun({ direction_ids: directionIds }));
    setStarting(false);
    // A start that timed out may still have begun; the refreshed status shows it.
    refreshRuns();
    if (!response.ok) {
      toast({ text: `Couldn't start the run. ${response.error.message}`, code: response.error.code, error: true });
      return;
    }
    setSelection(response.result.run_id);
  };

  return (
    <section className="runs-view" aria-label="Runs">
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
      <div className="runs-body">
        <div className="runs-side">
          {setup ? (
            <p className="run-setup">
              <span>Can't run yet: {setup.text}.</span>{" "}
              <button type="button" className="link-button" onClick={() => navigate("settings", setup.section)}>
                {setup.link}
              </button>
            </p>
          ) : null}
          <div className="runs-side-header">
            <h2>Schedules</h2>
            <button
              type="button"
              className="add-button"
              aria-label="New run"
              aria-pressed={!selected}
              title="Choose searches and run them now"
              onClick={() => setSelection("new")}
            >
              +
            </button>
          </div>
          <hr className="runs-divider" />
          <nav className="run-cards" aria-label="Run history">
            {!runs.loaded ? (
              runs.error ? null : <p className="muted small run-cards-note">Loading runs…</p>
            ) : history.length ? (
              history.map((run) => <RunCard key={run.id} run={run} current={run.id === selected?.id} onSelect={() => setSelection(run.id)} />)
            ) : (
              <p className="muted small run-cards-note">No runs yet.</p>
            )}
            {truncated ? <p className="muted small run-cards-note">Showing the newest {RUN_LIMIT} search runs and {RUN_LIMIT} scoring runs.</p> : null}
          </nav>
        </div>
        {selected ? (
          <RunDetailView key={selected.id} summary={selected} blocked={blocked} starting={starting} onRunAgain={start} />
        ) : runs.loaded || runs.error ? (
          <NewRunPanel catalog={catalog} blocked={blocked} starting={starting} onStart={start} onEdit={() => navigate("settings", "searches")} />
        ) : (
          <div className="run-detail" />
        )}
      </div>
    </section>
  );
}

export function RunDot({ tone, ring }: { tone?: string; ring?: boolean }) {
  return <span className="dot" data-run={ring ? "ring" : tone} aria-hidden="true" />;
}

function StatusLabel({ run }: { run: Pick<RunSummary, "status" | "stage"> }) {
  return (
    <span className="status-text run-status">
      <RunDot tone={runStatusTone(run.status)} />
      {runStatusLabels[run.status]}
      {run.stage && run.status === "running" ? ` · ${runStageLabels[run.stage]}` : ""}
    </span>
  );
}

const scoringStatus = (run: RunSummary) =>
  run.status === "running" ? "Scoring in progress" : run.status === "stopping" ? "Stopping scoring" : `Scoring ${runStatusLabels[run.status].toLowerCase()}`;

function RunCard({ run, current, onSelect }: { run: RunSummary; current: boolean; onSelect: () => void }) {
  const active = isActiveRun(run.status);
  const aside =
    run.kind === "rescore"
      ? plural(run.stats.scoring.total, "job")
      : active
        ? `${doneOf(run.stats.retrieval)}/${run.stats.retrieval.total}`
        : `${run.new_job_count.toLocaleString("en-US")} new`;
  const text = run.kind === "rescore" ? scoringStatus(run) : `${runStatusLabels[run.status]} · ${searchesLabel(run)}`;
  return (
    <button type="button" className="run-card" aria-current={current ? "true" : undefined} onClick={onSelect} title={text}>
      <span className="run-card-line">
        <span className="run-card-title">{formatRunTime(run.started_at)}</span>
        <span className="run-card-aside">{aside}</span>
      </span>
      <span className="run-card-line run-card-status">
        <RunDot tone={runStatusTone(run.status)} />
        <span className="run-card-text">{text}</span>
      </span>
    </button>
  );
}

/** M7 adds schedules here; until then + chooses searches and runs them once. */
function NewRunPanel({
  catalog,
  blocked,
  starting,
  onStart,
  onEdit,
}: {
  catalog: Catalog;
  blocked?: string;
  starting: boolean;
  onStart: (directionIds: string[] | null) => void;
  onEdit: () => void;
}) {
  const { api } = useApp();
  // null = All searches.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<{ data?: Preview; error?: ApiError }>({});
  const known = chosen?.filter((id) => catalog.directions.some((d) => d.id === id)) ?? null;
  const key = known === null ? "all" : known.join(",");
  useEffect(() => {
    let current = true;
    setPreview({});
    if (known && !known.length) return;
    void call(() => api.previewRun({ direction_ids: known })).then((response) => {
      if (current) setPreview(response.ok ? { data: response.result } : { error: response.error });
    });
    return () => {
      current = false;
    };
    // Searches are re-read with the settings; the key carries the selection.
  }, [api, key, catalog.settings, catalog.directions]);

  const toggle = (id: string) => {
    const next = (known ?? []).includes(id) ? (known ?? []).filter((value) => value !== id) : [...(known ?? []), id];
    setChosen(next.length ? next : null);
  };
  const reason = blocked ?? (preview.error ? preview.error.message : !preview.data ? "Checking settings…" : undefined);
  return (
    <div className="run-detail" role="region" aria-label="New run">
      <header className="run-header">
        <div className="run-heading">
          <h2>New run</h2>
          <p className="muted">Runs once, right away, with the searches you choose.</p>
        </div>
        <div className="run-actions">
          <button type="button" className="button button-primary" disabled={!!reason || starting} title={reason} onClick={() => onStart(known)}>
            {starting ? "Starting…" : "Run now"}
          </button>
        </div>
      </header>
      <div className="run-form">
        <span className="form-label" id="run-searches-label">
          Searches
        </span>
        <div className="toggle-chips" role="group" aria-labelledby="run-searches-label">
          <button type="button" className="toggle-chip" aria-pressed={known === null} onClick={() => setChosen(null)}>
            All searches
          </button>
          {catalog.directions.map((direction) => (
            <button
              key={direction.id}
              type="button"
              className="toggle-chip"
              aria-pressed={!!known?.includes(direction.id)}
              disabled={!direction.enabled}
              title={direction.enabled ? undefined : "This search is turned off in Settings"}
              onClick={() => toggle(direction.id)}
            >
              {direction.name}
            </button>
          ))}
        </div>
      </div>
      <PlanSummary preview={preview} onEdit={onEdit} />
    </div>
  );
}

/** What one run of the chosen searches does, or why it can't run. */
function PlanSummary({ preview, onEdit }: { preview: { data?: Preview; error?: ApiError }; onEdit: () => void }) {
  const edit = (
    <button type="button" className="link-button" onClick={onEdit}>
      Edit searches
    </button>
  );
  if (preview.error) {
    return (
      <p className="run-plan">
        {preview.error.message} {edit}
      </p>
    );
  }
  if (!preview.data) return <p className="run-plan muted">Checking settings…</p>;
  const { task_count: count, parameters, auto_score_enabled: scoring } = preview.data;
  const days = parameters.hours_old > 0 ? Math.round(parameters.hours_old / 24) : null;
  return (
    <p className="run-plan">
      <strong>Each run: {plural(count, "task")}</strong> — every enabled query × location × site in the chosen searches. Up to {parameters.results_wanted.linkedin} LinkedIn and{" "}
      {parameters.results_wanted.indeed} Indeed results per task{days ? `, posted in the last ${plural(days, "day")}` : ""}. Auto-scoring {scoring ? "on" : "off"}. {edit}
    </p>
  );
}

function duration(from: number, to: number) {
  const minutes = Math.round((to - from) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return plural(minutes, "minute");
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Source and times, e.g. "Manual · 10/19 21:29 – 21:41 · took 12 minutes". */
function timing(run: RunSummary) {
  const source = run.trigger?.source === "schedule" ? "Scheduled" : "Manual";
  if (run.finished_at == null) return `${source} · started ${formatTime(run.started_at)}`;
  const end = formatDay(run.finished_at) === formatDay(run.started_at) ? formatClock(run.finished_at) : formatTime(run.finished_at);
  return `${source} · ${formatTime(run.started_at)} – ${end} · took ${duration(run.started_at, run.finished_at)}`;
}

/** Retrieval runs list every task; the table scrolls on its own, so all pages are read. */
async function loadDetail(api: JobVaccumApi, runId: string, allTasks: boolean): Promise<ApiResult<RunDetail>> {
  const first = await call(() => api.getRunDetail({ run_id: runId, task_page: 1, task_page_size: allTasks ? TASK_PAGE_SIZE : 1 }));
  if (!first.ok || !allTasks) return first;
  const tasks = [...first.result.tasks];
  for (let page = 2; tasks.length < first.result.task_total; page += 1) {
    const next = await call(() => api.getRunDetail({ run_id: runId, task_page: page, task_page_size: TASK_PAGE_SIZE }));
    if (!next.ok) return next;
    if (!next.result.tasks.length) break;
    tasks.push(...next.result.tasks);
  }
  return { ok: true, result: { ...first.result, tasks } };
}

function RunDetailView({
  summary,
  blocked,
  starting,
  onRunAgain,
}: {
  summary: RunSummary;
  blocked?: string;
  starting: boolean;
  onRunAgain: (directionIds: string[] | null) => void;
}) {
  const { api, catalog, runs, runVersion, refreshRuns, openJobs } = useApp();
  const toast = useToast();
  const [state, setState] = useState<{ data?: RunDetail; error?: ApiError; loading: boolean }>({ loading: true });
  const [reload, setReload] = useState(0);
  const [stopping, setStopping] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const id = ++sequence.current;
    setState((previous) => ({ ...previous, loading: true }));
    void loadDetail(api, summary.id, summary.kind === "pipeline").then((response) => {
      if (id !== sequence.current) return;
      setState((previous) => (response.ok ? { data: response.result, loading: false } : { data: previous.data, error: response.error, loading: false }));
    });
  }, [api, summary.id, summary.kind, runVersion, reload]);

  // The list summary updates with every run event; the detail adds the snapshot and tasks.
  const run: RunSummary & Partial<RunDetail> = { ...state.data, ...summary };
  const stats = run.stats;
  const active = isActiveRun(run.status);
  const stop = async () => {
    setStopping(true);
    const response = await call(() => api.stopRun({ run_id: run.id }));
    setStopping(false);
    refreshRuns();
    if (!response.ok) toast({ text: `Couldn't stop the run. ${response.error.message}`, code: response.error.code, error: true });
  };
  // Run again uses this run's searches with the current settings.
  const gone = run.searches != null && !run.searches.some((search) => catalog.directions.some((d) => d.id === search.id));
  const againReason = blocked ?? (gone ? "The searches this run used were deleted" : undefined);
  const actions = active ? (
    <button
      type="button"
      className="button"
      disabled={stopping || run.status === "stopping" || runs.active?.run_id !== run.id}
      onClick={() => void stop()}
      title="Stop dispatching tasks; finished tasks are kept"
    >
      {run.status === "stopping" ? "Stopping…" : "Stop"}
    </button>
  ) : run.kind === "pipeline" ? (
    <button
      type="button"
      className="button"
      disabled={!!againReason || starting}
      title={againReason ?? "Run these searches again with the current settings"}
      onClick={() => onRunAgain(run.searches?.map((search) => search.id) ?? null)}
    >
      {starting ? "Starting…" : "Run again"}
    </button>
  ) : null;
  const loadError = state.error ? (
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
  ) : null;
  const header = (title: string) => (
    <header className="run-header">
      <div className="run-heading">
        <h2>
          <span className="run-title">{title}</span>
          <StatusLabel run={run} />
        </h2>
        <p className="muted">{timing(run)}</p>
      </div>
      {actions ? <div className="run-actions">{actions}</div> : null}
    </header>
  );

  if (run.kind === "rescore") {
    const counts = stats.scoring;
    return (
      <div className="run-detail" aria-label="Run details" role="region">
        {header(`Scoring · ${plural(counts.total, "job")}`)}
        <StoppingNote run={run} />
        {run.error ? <ErrorText error={run.error} block /> : null}
        {loadError}
        <div className="run-progress">
          <Progress label="Scoring" counts={counts} active={active} />
        </div>
        <dl className="run-totals">
          <Total label="Jobs" hint="Fixed when scoring started">
            {counts.total.toLocaleString("en-US")}
          </Total>
          <Total label="Scored">{counts.succeeded.toLocaleString("en-US")}</Total>
          <Total label="Failed" hint="Failed jobs keep their earlier score">
            {counts.failed ? (
              <button type="button" className="link-button" onClick={() => openJobs({ score_states: ["failed"] })} title="Show jobs whose latest scoring failed in Jobs">
                {counts.failed.toLocaleString("en-US")} failed
              </button>
            ) : (
              "0"
            )}
          </Total>
        </dl>
        <p className="muted small">Scores replace earlier ones only when they succeed. A failed job keeps its earlier score and shows “!”.</p>
      </div>
    );
  }

  const scoringOff = state.data ? !state.data.config_snapshot.auto_score_enabled : null;
  const retrievalTasks = (state.data?.tasks ?? []).filter((task): task is Extract<RunTask, { kind: "retrieval" }> => task.kind === "retrieval");
  const seenBefore = Math.max(0, stats.matched_job_count - stats.new_job_count);

  return (
    <div className="run-detail" aria-label="Run details" role="region">
      {header(searchesLabel(run))}
      <StoppingNote run={run} />
      {run.error ? <ErrorText error={run.error} block /> : null}
      {loadError}

      <div className="run-progress">
        <Progress label="Retrieval" counts={stats.retrieval} active={active} />
        {scoringOff ? (
          <div className="progress-row">
            <span className="progress-label">Scoring</span>
            <span className="muted">Auto-scoring was off for this run; new jobs are unscored.</span>
          </div>
        ) : scoringOff === false ? (
          <Progress label="Scoring" counts={stats.scoring} active={active} />
        ) : null}
      </div>

      <dl className="run-totals">
        <Total label="Received">{stats.received_count.toLocaleString("en-US")}</Total>
        <Total label="Filtered out" note={<RuleCounts reasons={stats.filter_reasons ?? {}} snapshot={state.data?.config_snapshot} />}>
          {stats.filtered_count.toLocaleString("en-US")}
        </Total>
        <Total label="Matched" hint="Jobs this run found, including ones already saved" note={`${seenBefore.toLocaleString("en-US")} seen before`}>
          {stats.matched_job_count.toLocaleString("en-US")}
        </Total>
        <Total label="New jobs">
          {summary.new_job_count ? (
            <button type="button" className="link-button" onClick={() => openJobs({ run_ids: [summary.id] })} title="Show the jobs first found by this run in Jobs">
              {summary.new_job_count.toLocaleString("en-US")} new
            </button>
          ) : (
            "0"
          )}
        </Total>
      </dl>

      <section aria-labelledby="by-search-title" className="run-section">
        <h3 id="by-search-title">By search</h3>
        {stats.directions.length ? (
          <>
            <div className="run-table-frame">
              <table className="run-table" aria-labelledby="by-search-title">
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
                      <td title={direction.name}>{direction.name}</td>
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

      <section aria-labelledby="tasks-title" className="run-section run-tasks">
        <h3 id="tasks-title">Tasks</h3>
        {!state.data && state.loading ? (
          <p className="muted">Loading tasks…</p>
        ) : retrievalTasks.length ? (
          <div className="run-table-frame run-tasks-scroll">
            <table className="run-table task-table" aria-labelledby="tasks-title">
              <colgroup>
                <col className="task-col-query" />
                <col className="task-col-location" />
                <col className="task-col-site" />
                <col className="task-col-status" />
                <col className="task-col-tries" />
                <col className="task-col-number" />
                <col className="task-col-number" />
                <col className="task-col-number" />
                <col className="task-col-notes" />
              </colgroup>
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

/** While stopping, model requests already sent finish first (their scores are kept). */
function StoppingNote({ run }: { run: RunSummary }) {
  if (run.status !== "stopping") return null;
  const left = run.stats.retrieval.active + run.stats.scoring.active;
  return (
    <p className="run-plan" role="status">
      Stopping — {left ? `waiting for ${plural(left, "task")} already in progress (${plural(run.stats.scoring.active, "model request")})` : "finishing up"}. Finished tasks are kept.
    </p>
  );
}

function Total({ label, hint, note, children }: { label: string; hint?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div title={hint}>
      <dt>
        {label}
      </dt>
      <dd>{children}</dd>
      {note ? <dd className="total-note">{note}</dd> : null}
    </div>
  );
}

const ruleOrder = ["company", "empty_record", "part_time", "test_jobs", "senior_title", "experience", "authorization", "language", "graduation", "degree"];

/** Rules on for this run (from its snapshot), with how many jobs each filtered out. */
function RuleCounts({ reasons, snapshot }: { reasons: Record<string, number>; snapshot?: RunSnapshot }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const rules = snapshot?.rules;
  // Missing details and part-time are always filtered; older runs list what they counted.
  const on = new Set<string>(["empty_record", "part_time", ...Object.keys(reasons).filter((reason) => reasons[reason] > 0)]);
  if (rules) {
    if (rules.excluded_companies.length) on.add("company");
    rules.enabled_rule_ids.forEach((rule) => on.add(rule));
  }
  const listed = [...ruleOrder.filter((rule) => on.has(rule)), ...[...on].filter((rule) => !ruleOrder.includes(rule))];
  const name = (rule: string) => (rule === "experience" && rules ? `Experience over ${plural(rules.experience_max_years, "year")}` : (filterReasonLabels[rule] ?? rule));
  return (
    <>
      <button ref={button} type="button" className="link-button rule-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        By rule
      </button>
      {open && button.current ? (
        <Popover anchor={button.current} label="Filtered out by rule" className="rule-popover" onClose={() => setOpen(false)}>
          <h3 tabIndex={-1} data-autofocus>
            Filtered out by rule
          </h3>
          <dl>
            {listed.map((rule) => (
              <div key={rule}>
                <dt>{name(rule)}</dt>
                <dd>{(reasons[rule] ?? 0).toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
          <p className="muted small">Rules that were off aren't listed.</p>
        </Popover>
      ) : null}
    </>
  );
}

/** Task counts as text plus a bar; no motion, the numbers change with each event. */
function Progress({ label, counts, active }: { label: string; counts: TaskCounts; active: boolean }) {
  const done = doneOf(counts);
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
        data-active={active || undefined}
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
const taskTone = (status: RunTask["status"]) =>
  status === "succeeded" ? "completed" : status === "failed" ? "failed" : status === "running" ? "running" : "idle";

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

/** One line per task; long text is cut off and shown in full on hover. */
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
  const failure = task.error ? `${task.error.message} ${task.error.code}` : "";
  const noteText = [failure, notes.join(" · ")].filter(Boolean).join(" · ");
  const location = `${task.spec.location}${task.spec.distance_miles ? ` · ${task.spec.distance_miles} mi` : ""}`;
  const show = (value: number | undefined) => (value == null ? "—" : value.toLocaleString("en-US"));
  return (
    <tr>
      <td title={task.spec.expression}>{task.spec.expression}</td>
      <td title={location}>{location}</td>
      <td>{siteLabel(task.spec.site)}</td>
      <td>
        <span className="status-text">
          <RunDot tone={taskTone(task.status)} ring={task.status === "pending"} />
          {taskStatusLabels[task.status]}
        </span>
      </td>
      <td className="number-cell">{task.attempt_count}</td>
      <td className="number-cell">{show(stats.received_count)}</td>
      <td className="number-cell" title={reasons || undefined}>
        {show(stats.filtered_count)}
      </td>
      <td className="number-cell">{show(stats.matched_job_count)}</td>
      <td title={[noteText, ...(stats.warnings ?? [])].filter(Boolean).join("\n") || undefined}>
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
