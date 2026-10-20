import { useRef, useState } from "react";
import type { ActiveRun, FilterSpec, Settings, Sort } from "./api";
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

/** Host of the model service, for saying where scoring sends jobs. */
function serviceHost(settings: Settings | null) {
  try {
    return settings?.model ? new URL(settings.model.base_url).host : "";
  } catch {
    return "";
  }
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
  return { blocked, start, starting, model: catalog.settings?.model?.model_id ?? "", host: serviceHost(catalog.settings) };
}

/** Top bar Score ▾: the selected jobs, or every job matching the filters after a count confirmation. */
export function ScoreMenu({
  scoring,
  selected,
  matching,
  filter,
  summary,
  onStarted,
}: {
  /** Shared with the details' Score button, so one start disables both. */
  scoring: ReturnType<typeof useScoreJobs>;
  selected: string[];
  matching: number;
  filter: FilterSpec & { sort?: Sort };
  summary: string;
  onStarted: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
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
              onSelect: () => setConfirming(matching),
            },
          ]}
        />
      ) : null}
      {confirming !== null ? (
        <ScoreAllDialog
          count={confirming}
          summary={summary}
          model={scoring.model}
          host={scoring.host}
          busy={!!scoring.blocked}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const started = await scoring.start({ filter }, confirming);
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
  count,
  summary,
  model,
  host,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  summary: string;
  model: string;
  host: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title={`Score ${plural(count, "job")}?`}
      onCancel={onCancel}
      initialFocus={cancel}
      footer={
        <>
          <button ref={cancel} type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button button-primary" disabled={busy} onClick={onConfirm}>
            Score {plural(count, "job")}
          </button>
        </>
      }
    >
      <p>
        Every job matching the current filters is scored, on all pages. Each job's title, company and description is sent with your rubric to{" "}
        <strong>{model}</strong>
        {host ? ` at ${host}` : ""}.
      </p>
      <p className="muted small">{summary}</p>
      <p className="muted">A new score replaces the old one only if it succeeds. Progress shows in Runs.</p>
    </Dialog>
  );
}
