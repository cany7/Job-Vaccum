import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { call, type ApiError, type Direction } from "./api";
import { useApp } from "./context";
import { ConfirmDialog } from "./dialogs";
import { plural } from "./format";
import { GripIcon } from "./icons";
import { ErrorText } from "./Settings";
import { useToast } from "./toasts";

/** Settings › Searches: rename, reorder (drag or ⌥↑↓ on the handle) and delete. */
export function SearchesSection() {
  const { api, catalog, mutate, refreshCatalog } = useApp();
  const toast = useToast();
  const [order, setOrder] = useState<Direction[]>(catalog.directions);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Direction | null>(null);
  const [busy, setBusy] = useState(false);
  const dragged = useRef<string | null>(null);
  useEffect(() => setOrder(catalog.directions), [catalog.directions]);

  const saveOrder = async (next: Direction[]) => {
    const previous = order;
    setOrder(next);
    const response = await mutate(() => api.reorderDirections({ ids: next.map((direction) => direction.id) }));
    if (!response.ok) {
      setOrder(previous);
      toast({ text: `Couldn't reorder searches. ${response.error.message}`, code: response.error.code, error: true });
    }
    refreshCatalog();
  };
  const moveBy = (id: string, step: number) => {
    const index = order.findIndex((direction) => direction.id === id);
    const target = index + step;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    void saveOrder(next);
  };
  const dropOn = (targetId: string) => {
    const id = dragged.current;
    dragged.current = null;
    if (!id || id === targetId) return;
    const next = [...order];
    const [item] = next.splice(order.findIndex((direction) => direction.id === id), 1);
    next.splice(order.findIndex((direction) => direction.id === targetId), 0, item);
    void saveOrder(next);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    const response = await mutate(() => api.deleteDirection({ id: deleting.id }));
    setBusy(false);
    const name = deleting.name;
    setDeleting(null);
    if (!response.ok) toast({ text: `Couldn't delete “${name}”. ${response.error.message}`, code: response.error.code, error: true });
    else toast({ text: `Deleted search “${name}”` });
    refreshCatalog();
  };

  return (
    <section aria-labelledby="searches-title">
      <header className="section-header">
        <h2 id="searches-title">Searches</h2>
        <p className="muted">
          Renaming updates every job's label. Deleting a search removes its queries and labels; jobs and your Shortlist are kept. Drag the handle to
          reorder the sidebar.
        </p>
      </header>
      {catalog.error && !catalog.directions.length ? (
        <ErrorText error={catalog.error} block />
      ) : order.length === 0 ? (
        <div className="settings-empty">
          <h3>No searches yet</h3>
          <p className="muted">Searches you set up appear here.</p>
        </div>
      ) : (
        <table className="settings-table" aria-label="Searches">
          <thead>
            <tr>
              <th className="handle-cell">
                <span className="visually-hidden">Order</span>
              </th>
              <th>Name</th>
              <th className="number-cell">Queries</th>
              <th className="number-cell">Jobs</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {order.map((direction, index) => (
              <tr
                key={direction.id}
                draggable={editing !== direction.id}
                onDragStart={(event: DragEvent) => {
                  dragged.current = direction.id;
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  if (dragged.current) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  dropOn(direction.id);
                }}
                onDragEnd={() => {
                  dragged.current = null;
                }}
              >
                <td className="handle-cell">
                  <button
                    type="button"
                    className="drag-handle"
                    aria-label={`Move ${direction.name}. Use Option and the arrow keys to move it.`}
                    title="Drag to reorder (⌥↑ ⌥↓)"
                    onKeyDown={(event: KeyboardEvent) => {
                      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                      event.preventDefault();
                      moveBy(direction.id, event.key === "ArrowUp" ? -1 : 1);
                    }}
                    disabled={busy}
                    data-position={index}
                  >
                    <GripIcon />
                  </button>
                </td>
                {editing === direction.id ? (
                  <RenameRow
                    direction={direction}
                    onDone={() => {
                      setEditing(null);
                      refreshCatalog();
                    }}
                  />
                ) : (
                  <>
                    <td className="name-cell">{direction.name}</td>
                    <td className="number-cell muted">{plural(direction.queries.length, "query", "queries")}</td>
                    <td className="number-cell muted">{plural(catalog.byDirection[direction.id] ?? 0, "job")}</td>
                    <td className="actions-cell">
                      <button type="button" className="button" onClick={() => setEditing(direction.id)}>
                        Rename
                      </button>
                      <button type="button" className="button button-danger" onClick={() => setDeleting(direction)}>
                        Delete…
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deleting ? (
        <ConfirmDialog title={`Delete search “${deleting.name}”?`} action="Delete" busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()}>
          <p>
            {deleting.queries.length ? `Its ${plural(deleting.queries.length, "query", "queries")} and the ${deleting.name} label are removed.` : `The ${deleting.name} label is removed.`}{" "}
            The {plural(catalog.byDirection[deleting.id] ?? 0, "job")} stay in Jobs, and your Shortlist doesn't change.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

/** Name editing needs Save; an empty name is reported under the field and not saved. */
function RenameRow({ direction, onDone }: { direction: Direction; onDone: () => void }) {
  const { api, mutate } = useApp();
  const [name, setName] = useState(direction.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    if (trimmed === direction.name) {
      onDone();
      return;
    }
    setSaving(true);
    const response = await mutate(() => api.saveDirection({ id: direction.id, name: trimmed }));
    setSaving(false);
    if (!response.ok) {
      setError(`${response.error.message} (${response.error.code})`);
      return;
    }
    onDone();
  };
  return (
    <>
      <td className="name-cell" colSpan={3}>
        <input
          className="text-input rename-input"
          value={name}
          autoFocus
          aria-label="Search name"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `rename-error-${direction.id}` : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") onDone();
          }}
        />
        {error ? (
          <p className="field-error" id={`rename-error-${direction.id}`} role="alert">
            {error}
          </p>
        ) : null}
      </td>
      <td className="actions-cell">
        <button type="button" className="button button-primary" disabled={saving} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
      </td>
    </>
  );
}

interface Preview {
  jobs: number;
  applications: number;
  files: number;
  disabled: boolean;
}

/** Settings › Data: retention days with a preview of the next automatic cleanup, and manual clearing. */
export function DataSection() {
  const { api, catalog, mutate, refreshCatalog, dataVersion } = useApp();
  const toast = useToast();
  const saved = catalog.retentionDays;
  const [days, setDays] = useState(saved?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ data?: Preview; error?: ApiError }>({});
  const [confirm, setConfirm] = useState<{ data?: Preview; error?: ApiError } | null>(null);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    if (saved != null) setDays(saved.toString());
  }, [saved]);

  const loadPreview = useCallback(async () => {
    const response = await call(() => api.previewCleanup({ mode: "automatic" }));
    setPreview(response.ok ? { data: response.result } : { error: response.error });
  }, [api]);
  useEffect(() => {
    void loadPreview();
  }, [loadPreview, saved, dataVersion]);

  const save = async () => {
    if (!/^\d+$/.test(days.trim()) || Number(days) > 2 ** 31 - 1) {
      setError("Enter a whole number of days, 0 or more.");
      return;
    }
    setSaving(true);
    const response = await call(() => api.saveSettings({ retention_days: Number(days) }));
    setSaving(false);
    if (!response.ok) {
      setError(`${response.error.message} (${response.error.code})`);
      return;
    }
    refreshCatalog();
    toast({ text: Number(days) === 0 ? "Automatic cleanup is off" : `Jobs are now kept for ${plural(Number(days), "day")}` });
  };

  const openClear = async () => {
    setConfirm({});
    const response = await call(() => api.previewCleanup({ mode: "manual" }));
    setConfirm(response.ok ? { data: response.result } : { error: response.error });
  };
  const clear = async () => {
    setClearing(true);
    const response = await mutate(() => api.executeCleanup({ mode: "manual" }));
    setClearing(false);
    setConfirm(null);
    if (!response.ok) {
      toast({ text: `Couldn't clear job data. ${response.error.message}`, code: response.error.code, error: true });
      return;
    }
    const { deleted_jobs: deleted, failed_files: failedFiles } = response.result;
    if (failedFiles.length) {
      toast({
        text: `Cleared ${plural(deleted, "job")}, but ${plural(failedFiles.length, "file")} couldn't be removed: ${failedFiles.slice(0, 3).join(", ")}${failedFiles.length > 3 ? "…" : ""}`,
        error: true,
      });
    } else toast({ text: `Cleared ${plural(deleted, "job")}` });
    refreshCatalog();
    void loadPreview();
  };

  const dirty = saved == null || days.trim() !== saved.toString();
  return (
    <section aria-labelledby="data-title">
      <header className="section-header">
        <h2 id="data-title">Automatic cleanup</h2>
        <p className="muted">Jobs not in your Shortlist are removed a set number of days after they were first found. Logs follow the same limit.</p>
      </header>
      <div className="retention-row">
        <label htmlFor="retention-days">Keep jobs for</label>
        <input
          id="retention-days"
          className="text-input days-input"
          inputMode="numeric"
          value={days}
          aria-invalid={error ? true : undefined}
          aria-describedby="retention-help"
          onChange={(event) => {
            setDays(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && dirty) void save();
          }}
        />
        <span>days</span>
        <span className="muted" id="retention-help">
          · 0 turns automatic cleanup off
        </span>
        <span className="spacer" />
        <button type="button" className="button button-primary" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="note-box" aria-live="polite">
        {preview.error ? (
          <ErrorText error={preview.error} />
        ) : !preview.data ? (
          <span className="muted">Checking…</span>
        ) : preview.data.disabled ? (
          "Automatic cleanup is off. Jobs are kept until you clear them."
        ) : (
          <>
            Cleanup checks about once a minute. The next check will remove <strong>{plural(preview.data.jobs, "job")}</strong> first found more than{" "}
            {plural(saved ?? 0, "day")} ago. <strong>{plural(preview.data.applications, "Shortlist job")}</strong> {preview.data.applications === 1 ? "is" : "are"} always kept.
          </>
        )}
      </div>
      <hr className="divider" />
      <header className="section-header">
        <h2>Clear job data</h2>
        <p className="muted">Removes every job that isn't in your Shortlist, plus logs and temporary files. Your Shortlist and settings stay.</p>
      </header>
      <div>
        <button type="button" className="button button-danger" onClick={() => void openClear()}>
          Clear job data…
        </button>
      </div>
      {confirm ? (
        <ConfirmDialog
          title="Clear job data?"
          action="Clear job data"
          busy={clearing || !confirm.data}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void clear()}
        >
          {confirm.error ? (
            <ErrorText error={confirm.error} block />
          ) : confirm.data ? (
            <p>
              This deletes <strong>{plural(confirm.data.jobs, "job")}</strong> that {confirm.data.jobs === 1 ? "isn't" : "aren't"} in your Shortlist, plus logs and
              temporary files. Your <strong>{plural(confirm.data.applications, "Shortlist job")}</strong> (with details, status and notes) and settings are kept.
              This can't be undone.
            </p>
          ) : (
            <p className="muted">Counting jobs…</p>
          )}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
