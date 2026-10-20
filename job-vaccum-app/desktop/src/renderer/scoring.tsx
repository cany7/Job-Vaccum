import { useEffect, useRef, useState } from "react";
import type { ActiveRun, FilterSpec, Settings, Sort } from "./api";
import { call } from "./api";
import { useApp } from "./context";
import { plural } from "./format";
import { ChevronDown } from "./icons";
import { useToast } from "./toasts";
import { Dialog, Menu } from "./ui";

/** Why Score can't be used right now, or null when it can. */
export function scoringBlocker(settings: Settings | null, active: ActiveRun | null): string | null {
  if (!settings) return "Loading settings…";
  if (!settings.model) return "Set up a model connection in Settings › Model to score jobs.";
  if (settings.model_key_error) return "The saved API key can't be read. Enter it again in Settings › Model.";
  if (!settings.has_key) return "Save an API key in Settings › Model to score jobs.";
  if (!settings.rubric.trim()) return "Write a scoring rubric in Settings › Filters & scoring to score jobs.";
  if (active) return "A run is in progress. Score after it finishes.";
  return null;
}

type ScoreParams = { job_ids: string[] } | { filter: FilterSpec & { sort?: Sort } };

/**
 * Starts manual scoring (a scoring run). The request is never resent: while it
 * is out the Score controls stay disabled, and the run list is re-read after,
 * because a timed-out start may still have begun.
 */
export function useScoreJobs() {
  const { api, catalog, runs, mutate, refreshRuns, openRun } = useApp();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const blocked = starting ? "Starting scoring…" : scoringBlocker(catalog.settings, runs.active);
  const start = async (params: ScoreParams, expected?: number) => {
    if (blocked) return false;
    setStarting(true);
    const response = await mutate(() => api.scoreJobs(params as Parameters<typeof api.scoreJobs>[0]));
    setStarting(false);
    refreshRuns();
    if (!response.ok) {
      toast({ text: `Couldn't start scoring. ${response.error.message}`, code: response.error.code, error: true });
      return false;
    }
    const { run_id: runId, job_count: count } = response.result;
    const changed = expected !== undefined && expected !== count ? " (the matching jobs changed since you confirmed)" : "";
    toast({ text: `Scoring ${plural(count, "job")}${changed}`, action: { label: "View progress", run: () => openRun(runId) } });
    return true;
  };
  return { blocked, start, starting };
}

/** Top bar Score ▾: the selected jobs, or every job matching the filters after a count confirmation. */
export function ScoreMenu({
  scoring,
  selected,
  matching,
  filter,
  labels,
  page,
  onStarted,
}: {
  /** Shared with the details' Score button, so one start disables both. */
  scoring: ReturnType<typeof useScoreJobs>;
  selected: string[];
  matching: number;
  filter: FilterSpec & { sort?: Sort };
  labels: string[];
  page: "jobs" | "shortlist";
  onStarted: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<{ filter: typeof filter; labels: string[] } | null>(null);
  const count = selected.length;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="button button-menu"
        disabled={!!scoring.blocked}
        aria-haspopup="menu"
        aria-expanded={open}
        title={scoring.blocked ?? "Score with your current model and rubric"}
        onClick={() => setOpen(!open)}
      >
        Score <ChevronDown />
      </button>
      {open && button.current ? (
        <Menu
          anchor={button.current}
          onClose={() => setOpen(false)}
          label="Score"
          placement="bottom-end"
          entries={[
            {
              key: "selected",
              label: `Score selected (${count})`,
              disabled: !count,
              onSelect: () => {
                void scoring.start({ job_ids: selected }).then((started) => {
                  if (started) onStarted();
                });
              },
            },
            {
              key: "all",
              label: `Score all ${matching.toLocaleString("en-US")} matching…`,
              disabled: !matching,
              onSelect: () => setConfirming({ filter, labels }),
            },
          ]}
        />
      ) : null}
      {confirming !== null ? (
        <ScoreAllDialog
          filter={confirming.filter}
          labels={confirming.labels}
          page={page}
          busy={!!scoring.blocked}
          onCancel={() => setConfirming(null)}
          onConfirm={async (count) => {
            const started = await scoring.start({ filter: confirming.filter }, count);
            setConfirming(null);
            if (started) onStarted();
          }}
        />
      ) : null}
    </>
  );
}

/** Confirms how many jobs Score all sends to the model; Cancel has focus. */
function ScoreAllDialog({
  filter, labels, page, busy, onCancel, onConfirm,
}: {
  filter: FilterSpec & { sort?: Sort };
  labels: string[];
  page: "jobs" | "shortlist";
  busy: boolean;
  onCancel: () => void;
  onConfirm: (count: number) => void;
}) {
  const { api } = useApp();
  const cancel = useRef<HTMLButtonElement>(null);
  const [counts, setCounts] = useState<{ total: number; scored: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      call(() => api.listJobs({ ...filter, page: 1, page_size: 1 })),
      // Keep any narrower score range in the confirmed filter.
      call(() => api.listJobs({ ...filter, score_min: filter.score_min ?? 0, page: 1, page_size: 1 })),
    ]).then(([all, scored]) => {
      if (cancelled) return;
      if (!all.ok) setError(all.error.message);
      else if (!scored.ok) setError(scored.error.message);
      else setCounts({ total: all.result.total, scored: scored.result.total });
    });
    return () => { cancelled = true; };
  }, [api, filter]);
  return (
    <Dialog
      title={counts ? `Score ${plural(counts.total, "job")}?` : "Score jobs?"}
      onCancel={onCancel}
      initialFocus={cancel}
      footer={
        <>
          <button ref={cancel} type="button" className="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="button button-primary" disabled={busy || !counts?.total || !!error} onClick={() => counts && onConfirm(counts.total)}>
            {counts ? `Score ${plural(counts.total, "job")}` : "Score jobs"}
          </button>
        </>
      }
    >
      {error ? <p role="alert" className="field-error">Couldn't count matching jobs. {error}</p> : !counts ? <p role="status" className="muted">Counting matching jobs…</p> : <>
        <p><strong>{counts.scored.toLocaleString("en-US")} already scored will be rescored</strong> · {(counts.total - counts.scored).toLocaleString("en-US")} unscored</p>
        <p>{labels.length ? "Every job matching these filters is scored, on all pages." : `Every job in ${page === "jobs" ? "Jobs" : "Shortlist"} (${counts.total.toLocaleString("en-US")}) is scored.`}</p>
        {labels.length ? <div className="score-filter-tags" aria-label="Filters">{labels.map(label => <span className="chip" key={label}>{label}</span>)}</div> : null}
        <p className="muted">Each job's title, company and description is sent with your rubric to your model service.</p>
        <p className="muted">A new score replaces the old one only if it succeeds. Progress shows in Runs.</p>
      </>}
    </Dialog>
  );
}
