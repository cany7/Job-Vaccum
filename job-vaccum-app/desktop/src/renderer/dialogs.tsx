import { useRef, useState, type ReactNode } from "react";
import { plural } from "./format";
import type { ListPage } from "./listModel";
import { Dialog } from "./ui";

/**
 * Export: a format switch (hidden while CSV is the only format), the shared
 * "Jobs" range, then the chosen format's own options.
 */
export function ExportDialog({
  page,
  filteredCount,
  allCount,
  summary,
  onCancel,
  onExport,
}: {
  page: ListPage;
  filteredCount: number;
  allCount: number | null;
  summary: string;
  onCancel: () => void;
  /** The dialog stays open if the save panel is cancelled; the caller closes it once a file is chosen. */
  onExport: (options: { range: "filtered" | "all"; include_jd: boolean }) => Promise<void>;
}) {
  const [range, setRange] = useState<"filtered" | "all">("filtered");
  const [includeJd, setIncludeJd] = useState(false);
  const [busy, setBusy] = useState(false);
  const exportButton = useRef<HTMLButtonElement>(null);
  const all = page === "jobs" ? "All jobs" : "All Shortlist jobs";
  return (
    <Dialog
      title={page === "jobs" ? "Export jobs" : "Export Shortlist"}
      onCancel={onCancel}
      initialFocus={exportButton}
      className="export-dialog"
      footer={
        <>
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={exportButton}
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onExport({ range, include_jd: includeJd });
              setBusy(false);
            }}
          >
            Export…
          </button>
        </>
      }
    >
      <fieldset className="dialog-group">
        <legend className="group-label">Jobs</legend>
        <label className="choice">
          <input type="radio" name="export-range" checked={range === "filtered"} onChange={() => setRange("filtered")} />
          <span>
            Current filter — {plural(filteredCount, "job")}
            <span className="choice-note">{summary} · all pages</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="export-range" checked={range === "all"} onChange={() => setRange("all")} />
          <span>
            {all}
            {allCount != null ? ` — ${allCount.toLocaleString("en-US")}` : ""}
            <span className="choice-note">Ignores search and filters</span>
          </span>
        </label>
      </fieldset>
      <fieldset className="dialog-group">
        <legend className="group-label">CSV options</legend>
        <label className="choice">
          <input type="checkbox" className="checkbox" checked={includeJd} onChange={(event) => setIncludeJd(event.target.checked)} />
          <span>
            Include full job descriptions <span className="muted">(much larger file)</span>
          </span>
        </label>
        <p className="muted small">One row per job; multiple searches go in one cell.</p>
      </fieldset>
    </Dialog>
  );
}

/** Destructive confirmation: red action named for what it does, Cancel focused, Esc cancels. */
export function ConfirmDialog({
  title,
  children,
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  action: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title={title}
      onCancel={onCancel}
      initialFocus={cancel}
      className="confirm-dialog"
      footer={
        <>
          <button ref={cancel} type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button button-destructive" disabled={busy} onClick={onConfirm}>
            {action}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

const shortcuts: Record<ListPage, [string, string][]> = {
  jobs: [
    ["↑ ↓ or K J", "Previous or next job"],
    ["Return", "Show details"],
    ["Esc", "Close details"],
    ["X", "Select or deselect the job"],
    ["Shift-click", "Select a range"],
    ["S", "Add to Shortlist"],
    ["O", "Open posting"],
    ["⌘F", "Search"],
    ["⌃⌘S", "Show or hide the sidebar"],
  ],
  shortlist: [
    ["↑ ↓ or K J", "Previous or next job"],
    ["Return", "Edit notes"],
    ["Esc", "Close details"],
    ["X", "Select or deselect the job"],
    ["Shift-click", "Select a range"],
    ["O", "Open posting"],
    ["⌘Z", "Undo remove or status change"],
    ["⌘F", "Search"],
    ["⌃⌘S", "Show or hide the sidebar"],
  ],
};

export function ShortcutsDialog({ page, onClose }: { page: ListPage; onClose: () => void }) {
  const done = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title="Keyboard shortcuts"
      onCancel={onClose}
      initialFocus={done}
      footer={
        <button ref={done} type="button" className="button" onClick={onClose}>
          Done
        </button>
      }
    >
      <dl className="shortcuts">
        {shortcuts[page].map(([keys, action]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
