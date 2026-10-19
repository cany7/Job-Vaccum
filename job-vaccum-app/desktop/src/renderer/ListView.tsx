import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { call, type ApiError, type ApplicationStatus, type JobDetail, type JobSummary, type RestoreItem } from "./api";
import { useApp } from "./context";
import { Detail, postingUrl } from "./Detail";
import { ExportDialog, ShortcutsDialog } from "./dialogs";
import { FilterEditor } from "./FilterEditor";
import { plural, statusLabels, statuses } from "./format";
import { AlertIcon, ChevronDown, ChevronLeft, ChevronRight, CloseIcon, JobsIcon, SearchIcon, ShortlistIcon } from "./icons";
import { JobTable } from "./JobTable";
import {
  activeKeys,
  chipLabel,
  columns,
  defaultListPrefs,
  filterMenus,
  filterNames,
  pageColumns,
  pageSizes,
  scopeOf,
  toFilterSpec,
  withoutKey,
  type ColumnKey,
  type FilterKey,
  type ListFilter,
  type ListPage,
  type ListPrefs,
} from "./listModel";
import { useToast } from "./toasts";
import { isTypingTarget, Menu, type MenuEntry } from "./ui";

export interface TopbarSlots {
  actions: HTMLElement | null;
  subtitle: HTMLElement | null;
}

interface ListData {
  items: JobSummary[];
  total: number;
}

const pageLabels: Record<ListPage, string> = { jobs: "Jobs", shortlist: "Shortlist" };

/**
 * One list page (Jobs or Shortlist). Both pages stay mounted so switching keeps
 * the page number, scroll position, selection focus and open details.
 */
export function ListView({
  page,
  active,
  prefs,
  update,
  slots,
  onEditSearch,
}: {
  page: ListPage;
  active: boolean;
  prefs: ListPrefs;
  update: (change: Partial<ListPrefs>) => void;
  slots: TopbarSlots;
  onEditSearch: () => void;
}) {
  const { api, catalog, mutate, dataVersion, outsideChanges, waitForOperation, navigate, narrow } = useApp();
  const toast = useToast();
  const scope = scopeOf(page);
  const spec = useMemo(() => toFilterSpec(page, prefs.filter), [page, prefs.filter]);
  const specKey = JSON.stringify(spec);

  const [pageNumber, setPageNumber] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const rangeAnchor = useRef<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const currentIndex = useRef(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [reload, setReload] = useState(0);
  const [seenOutside, setSeenOutside] = useState(outsideChanges);
  // After a page, filter or sort change the position starts again from the top.
  const resetPosition = useRef(false);
  const sequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dialog, setDialog] = useState<"export" | "shortcuts" | null>(null);

  const items = data?.items ?? [];
  const pageSize = prefs.pageSize;

  // Filters can also change from the sidebar (search, Searches). Any change to
  // the query starts again at page 1 and clears the selection, so no hidden
  // rows stay selected.
  const queryKey = `${specKey}|${prefs.sort}|${pageSize}`;
  const [shownQuery, setShownQuery] = useState(queryKey);
  if (queryKey !== shownQuery) {
    setShownQuery(queryKey);
    setPageNumber(1);
    setSelected(new Set());
    setEditingNotes(null);
    rangeAnchor.current = null;
    resetPosition.current = true;
  }

  // Any reload shows the latest data, so it also clears "Results updated".
  const outsideNow = useRef(outsideChanges);
  outsideNow.current = outsideChanges;
  useEffect(() => {
    const id = ++sequence.current;
    const outsideAtStart = outsideNow.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      if (id === sequence.current) setSlow(true);
    }, 500);
    void call(() => api.listJobs({ ...(JSON.parse(specKey) as typeof spec), sort: prefs.sort, page: pageNumber, page_size: pageSize })).then((response) => {
      window.clearTimeout(timer);
      if (id !== sequence.current) return;
      setLoading(false);
      setSlow(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      const { items: rows, total } = response.result;
      const lastPage = Math.max(1, Math.ceil(total / pageSize));
      if (pageNumber > lastPage) {
        setPageNumber(lastPage);
        return;
      }
      setError(null);
      setData(response.result);
      setSeenOutside(outsideAtStart);
      const ids = new Set(rows.map((row) => row.id));
      setSelected((previous) => {
        const kept = [...previous].filter((id) => ids.has(id));
        return kept.length === previous.size ? previous : new Set(kept);
      });
      setCurrentId((previous) => {
        if (resetPosition.current) {
          resetPosition.current = false;
          return null;
        }
        if (previous === null || ids.has(previous)) return previous;
        // The job left this view after an action: take the next one, or the previous at the end.
        return rows[Math.min(currentIndex.current, rows.length - 1)]?.id ?? null;
      });
    });
    return () => window.clearTimeout(timer);
  }, [api, specKey, prefs.sort, pageNumber, pageSize, reload, dataVersion]);

  useEffect(() => {
    const index = items.findIndex((job) => job.id === currentId);
    if (index >= 0) currentIndex.current = index;
    if (currentId === null) setDetailOpen(false);
  }, [currentId, items]);

  // ---- Details ----
  const [detail, setDetail] = useState<{ job: JobDetail | null; error: ApiError | null; loading: boolean }>({ job: null, error: null, loading: false });
  const [detailReload, setDetailReload] = useState(0);
  const detailSequence = useRef(0);
  useEffect(() => {
    if (!detailOpen || !currentId) return;
    const id = ++detailSequence.current;
    setDetail((previous) => ({ job: previous.job?.id === currentId ? previous.job : null, error: null, loading: true }));
    void call(() => api.getJobDetail({ job_id: currentId })).then((response) => {
      if (id !== detailSequence.current) return;
      setDetail(response.ok ? { job: response.result, error: null, loading: false } : { job: null, error: response.error, loading: false });
    });
  }, [api, detailOpen, currentId, dataVersion, detailReload]);

  // ---- Position, selection and filters ----
  const clearSelection = () => {
    setSelected(new Set());
    rangeAnchor.current = null;
  };
  const restart = () => {
    clearSelection();
    setEditingNotes(null);
    resetPosition.current = true;
  };
  const changeFilter = (filter: ListFilter) => update({ filter });
  const changeSort = (key: string) => {
    const at = prefs.sort.lastIndexOf("_");
    const current = prefs.sort.slice(0, at);
    const order = prefs.sort.slice(at + 1);
    const column = Object.values(columns).find((def) => def.sort === key);
    const next = current === key ? (order === "asc" ? "desc" : "asc") : column?.descFirst ? "desc" : "asc";
    update({ sort: `${key}_${next}` as ListPrefs["sort"] });
  };
  const goToPage = (number: number) => {
    setPageNumber(number);
    restart();
  };
  const changePageSize = (size: number) => update({ pageSize: size });

  const toggle = (id: string, range: boolean) => {
    const anchor = rangeAnchor.current;
    setSelected((previous) => {
      const next = new Set(previous);
      const on = !previous.has(id);
      const from = items.findIndex((job) => job.id === anchor);
      const to = items.findIndex((job) => job.id === id);
      if (range && from >= 0 && to >= 0) {
        for (const job of items.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          if (on) next.add(job.id);
          else next.delete(job.id);
        }
      } else if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    rangeAnchor.current = id;
  };
  const selectWhere = (predicate: (job: JobSummary) => boolean) => {
    setSelected(new Set(items.filter(predicate).map((job) => job.id)));
    rangeAnchor.current = null;
  };

  const move = (step: number) => {
    if (!items.length) return;
    const index = items.findIndex((job) => job.id === currentId);
    const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, index + step));
    setCurrentId(items[next].id);
    setEditingNotes(null);
  };
  const currentJob = items.find((job) => job.id === currentId) ?? null;
  const currentIndexNow = currentJob ? items.indexOf(currentJob) : -1;

  // ---- Actions ----
  const openLink = useCallback(
    (url: string | null) => {
      if (!url) {
        toast({ text: "This job has no posting link.", error: true });
        return;
      }
      api.openLink(url).catch(() => toast({ text: "Only web links can be opened.", error: true }));
    },
    [api, toast],
  );
  const failed = (what: string, error: ApiError) => toast({ text: `${what} ${error.message}`, code: error.code, error: true });

  const addJobs = async (ids: string[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    const response = await mutate(() => api.addApplications({ job_ids: ids }));
    setBusy(false);
    if (!response.ok) {
      failed("Couldn't add to Shortlist.", response.error);
      return;
    }
    clearSelection();
    const { added, already_present: present, not_found: missing } = response.result.counts;
    const parts = [];
    if (added) parts.push(`Added ${added} to Shortlist`);
    if (present) parts.push(added || missing ? `${present} ${present === 1 ? "was" : "were"} already there` : "Already in Shortlist");
    if (missing) parts.push(`${missing} ${missing === 1 ? "job no longer exists" : "jobs no longer exist"} (removed by cleanup)`);
    toast({
      text: parts.join(" · "),
      error: !added && !present,
      action: added || present ? { label: "View", run: () => navigate("shortlist") } : undefined,
    });
  };

  const restore = async (records: RestoreItem[], done: string) => {
    const response = await mutate(() => api.restoreApplications({ items: records }));
    if (!response.ok) {
      failed("Couldn't undo.", response.error);
      return;
    }
    const { restored, not_found: missing } = response.result.counts;
    if (missing) {
      toast({
        text: `${restored ? `${done} for ${plural(restored, "job")}. ` : ""}${plural(missing, "job")} ${missing === 1 ? "was" : "were"} removed by cleanup and can't be restored.`,
        error: true,
      });
    } else toast({ text: done });
  };

  const setStatus = async (ids: string[], status: ApplicationStatus) => {
    if (!ids.length || busy) return;
    setBusy(true);
    const response = await mutate(() => api.setApplicationStatus({ job_ids: ids, status }));
    setBusy(false);
    if (!response.ok) {
      failed("Couldn't change status.", response.error);
      return;
    }
    clearSelection();
    const updated = response.result.items.flatMap((item) => (item.outcome === "updated" ? [{ job_id: item.job_id, status: item.status, updated_at: item.updated_at }] : []));
    const missing = response.result.counts.not_found;
    toast({
      text: `Status set to ${statusLabels[status]} for ${plural(updated.length, "job")}${missing ? ` · ${missing} no longer in Shortlist` : ""}`,
      error: !updated.length,
      undo: updated.length ? () => void restore(updated, "Status change undone") : undefined,
    });
  };

  const remove = async (ids: string[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    const response = await mutate(() => api.removeApplications({ job_ids: ids }));
    setBusy(false);
    if (!response.ok) {
      failed("Couldn't remove from Shortlist.", response.error);
      return;
    }
    clearSelection();
    const records = response.result.items;
    toast({
      text: records.length ? `Removed ${plural(records.length, "job")} from Shortlist` : "Those jobs were already out of the Shortlist",
      undo: records.length ? () => void restore(records, `Restored ${plural(records.length, "job")} to Shortlist`) : undefined,
    });
  };

  const updateOne = async (jobId: string, change: { status?: ApplicationStatus; notes?: string }) => {
    const response = await mutate(() => api.updateApplication({ job_id: jobId, ...change }));
    if (!response.ok) failed(change.notes !== undefined ? "Couldn't save the note." : "Couldn't change status.", response.error);
    return response.ok;
  };

  const startExport = async (options: { range: "filtered" | "all"; include_jd: boolean }) => {
    const destination = await call(() => api.chooseCsvDestination());
    if (!destination.ok) {
      failed("Couldn't export.", destination.error);
      return;
    }
    if (!destination.result) return;
    const token = destination.result.destination_token;
    setDialog(null);
    setExporting(true);
    const started = await call(() =>
      api.exportCsv({
        scope,
        ...(options.range === "filtered" ? { filter: { ...spec, sort: prefs.sort } } : {}),
        range: options.range,
        include_jd: options.include_jd,
        destination_token: token,
      }),
    );
    if (!started.ok) {
      setExporting(false);
      failed("Couldn't export.", started.error);
      return;
    }
    const outcome = await waitForOperation(started.result.operation_id);
    setExporting(false);
    if (outcome.ok) {
      toast({
        text: `Exported ${plural(outcome.row_count, "job")}`,
        action: { label: "Show in Finder", run: () => void api.showCsvInFinder({ destination_token: token }) },
      });
    } else failed("Export didn't finish; the file may be incomplete.", outcome.error);
  };

  // ---- Keyboard ----
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      // A menu or popover with focus keeps its keys (its Esc is marked handled); one opened by
      // hover without focus does not block the list.
      if (document.querySelector("dialog[open]") || document.activeElement?.closest(".popover")) return;
      const key = event.key;
      // Return on a focused button or link activates it, not the list.
      if (key === "Enter" && (event.target as HTMLElement).closest?.("button, a, [tabindex]:not(.table-scroll)")) return;
      if (key === "ArrowDown" || key === "j") move(1);
      else if (key === "ArrowUp" || key === "k") move(-1);
      else if (key === "Escape" && detailOpen) setDetailOpen(false);
      else if (key === "?") setDialog("shortcuts");
      else if (!currentJob) return;
      else if (key === "x") toggle(currentJob.id, false);
      else if (key === "o") openLink(postingUrl(currentJob));
      else if (key === "Enter" && page === "shortlist" && prefs.visible.includes("notes")) setEditingNotes(currentJob.id);
      else if (key === "Enter") setDetailOpen(true);
      else if (key === "s" && page === "jobs" && !currentJob.in_applications) void addJobs([currentJob.id]);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- Columns and menus ----
  const [menu, setMenu] = useState<{ kind: "select" | "filter" | "columns" | "pages" | "status"; anchor: HTMLElement | { x: number; y: number } } | null>(null);
  const [editor, setEditor] = useState<{ field: FilterKey; anchor: HTMLElement } | null>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  // Widths follow the pointer while dragging and are saved once on release.
  const [draftWidths, setDraftWidths] = useState<Partial<Record<ColumnKey, number>>>({});
  const resize = (key: ColumnKey, width: number, done: boolean) => {
    if (!done) {
      setDraftWidths((current) => ({ ...current, [key]: width }));
      return;
    }
    update({ widths: { ...prefs.widths, [key]: Math.round(width) } });
    setDraftWidths({});
  };

  const directionName = (id: string) => catalog.directions.find((direction) => direction.id === id)?.name ?? "Deleted search";
  const keys = activeKeys(prefs.filter);
  const total = data?.total ?? 0;
  const scopeCount = page === "jobs" ? catalog.jobs : catalog.shortlist;
  const first = total ? (pageNumber - 1) * pageSize + 1 : 0;
  const last = Math.min(total, pageNumber * pageSize);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const selectedIds = items.filter((job) => selected.has(job.id)).map((job) => job.id);
  const stale = outsideChanges !== seenOutside;

  const selectEntries: MenuEntry[] =
    page === "jobs"
      ? [
          { heading: "Select on this page" },
          { key: "all", label: `All (${items.length})`, onSelect: () => selectWhere(() => true) },
          "separator",
          { key: "8", label: "Score 8+", onSelect: () => selectWhere((job) => job.score != null && job.score >= 8) },
          { key: "6", label: "Score 6+", onSelect: () => selectWhere((job) => job.score != null && job.score >= 6) },
          { key: "unscored", label: "Unscored", onSelect: () => selectWhere((job) => job.score_state === "unscored" && job.score == null) },
          { key: "failed", label: "Scoring failed", onSelect: () => selectWhere((job) => job.score_state === "failed") },
          "separator",
          { key: "out", label: "Not in Shortlist", onSelect: () => selectWhere((job) => !job.in_applications) },
          { key: "in", label: "In Shortlist", onSelect: () => selectWhere((job) => job.in_applications) },
        ]
      : [
          { heading: "Select on this page" },
          { key: "all", label: `All (${items.length})`, onSelect: () => selectWhere(() => true) },
          "separator",
          { heading: "By status" },
          ...statuses.map((status) => ({ key: status, label: statusLabels[status], onSelect: () => selectWhere((job) => job.application?.status === status) })),
          "separator",
          {
            key: "stale",
            label: "Applied · no update 14+ days",
            onSelect: () => {
              const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
              selectWhere((job) => job.application?.status === "applied" && job.application.updated_at < cutoff);
            },
          },
        ];

  const subtitle = (() => {
    const ids = prefs.filter.direction_ids ?? [];
    const where = ids.length === 0 ? "All searches" : ids.length === 1 ? directionName(ids[0]) : `${ids.length} searches`;
    return data ? `${where} · ${plural(total, "job")}` : where;
  })();

  const count = selectedIds.length;
  const actions: ReactNode =
    page === "jobs" ? (
      <>
        <button type="button" className="button" disabled={exporting} onClick={() => setDialog("export")} title={exporting ? "An export is in progress" : undefined}>
          Export
        </button>
        <button type="button" className="button button-primary" disabled={!count || busy} onClick={() => void addJobs(selectedIds)} title="Add the selected jobs to your Shortlist">
          {count ? (
            <>
              Add {count}
              <span className="long-label"> to Shortlist</span>
            </>
          ) : (
            "Add to Shortlist"
          )}
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          className="button button-menu"
          disabled={!count || busy}
          aria-haspopup="menu"
          onClick={(event) => setMenu({ kind: "status", anchor: event.currentTarget })}
        >
          Set status <ChevronDown />
        </button>
        <button type="button" className="button" disabled={exporting} onClick={() => setDialog("export")} title={exporting ? "An export is in progress" : undefined}>
          Export
        </button>
        <button type="button" className="button button-danger" disabled={!count || busy} onClick={() => void remove(selectedIds)} title="Remove the selected jobs from your Shortlist (Undo available)">
          {count ? `Remove ${count}` : "Remove"}
        </button>
      </>
    );

  const allSelected = count > 0 && count === items.length;
  const empty = !error && data && items.length === 0 && !loading;

  return (
    <section className="list-view" hidden={!active} aria-label={pageLabels[page]}>
      {active && slots.actions ? createPortal(actions, slots.actions) : null}
      {active && slots.subtitle ? createPortal(subtitle, slots.subtitle) : null}

      <div className="filter-row">
        <div className="select-control">
          <button
            type="button"
            className="select-box"
            role="checkbox"
            aria-checked={allSelected ? true : count ? "mixed" : false}
            aria-label={count ? "Deselect all" : "Select all on this page"}
            title={count ? "Deselect all" : "Select all on this page"}
            disabled={!items.length}
            onClick={() => (count ? clearSelection() : selectWhere(() => true))}
          >
            <span className="box" aria-hidden="true">
              {allSelected ? "✓" : count ? "–" : ""}
            </span>
          </button>
          <button
            type="button"
            className="select-menu-button"
            aria-label="Select by condition"
            aria-haspopup="menu"
            disabled={!items.length}
            onClick={(event) => setMenu({ kind: "select", anchor: event.currentTarget })}
          >
            <ChevronDown />
          </button>
        </div>
        {count ? <span className="selected-count">{count} selected</span> : null}
        <div className="chips" role="list" aria-label="Filters">
          {keys.map((key) => {
            const label = chipLabel(key, prefs.filter, directionName);
            return (
              <span key={key} className="chip" role="listitem">
                <button
                  type="button"
                  className="chip-label"
                  title={label}
                  onClick={(event) => (key === "text" ? onEditSearch() : setEditor({ field: key, anchor: event.currentTarget }))}
                >
                  {label}
                </button>
                <button type="button" className="chip-remove" aria-label={`Remove filter: ${label}`} onClick={() => changeFilter(withoutKey(prefs.filter, key))}>
                  <CloseIcon size={10} />
                </button>
              </span>
            );
          })}
          <button
            ref={filterButton}
            type="button"
            className="add-filter"
            aria-haspopup="menu"
            onClick={(event) => setMenu({ kind: "filter", anchor: event.currentTarget })}
          >
            + Filter
          </button>
          {keys.length ? (
            <button type="button" className="link-button" onClick={() => changeFilter({})}>
              Clear all
            </button>
          ) : null}
        </div>
        <div className="filter-row-end">
          {stale ? (
            <span className="stale-note">
              Results updated ·{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => setReload((value) => value + 1)}
              >
                Refresh
              </button>
            </span>
          ) : null}
          <div className="pager">
            <button
              type="button"
              className="pager-range"
              aria-haspopup="menu"
              aria-label={`Showing ${first}–${last} of ${total}. Rows per page and first or last page`}
              onClick={(event) => setMenu({ kind: "pages", anchor: event.currentTarget })}
            >
              {data ? (total ? `${first.toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : "0 of 0") : "—"}
            </button>
            <button type="button" className="icon-button" aria-label="Previous page" disabled={pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}>
              <ChevronLeft />
            </button>
            <button type="button" className="icon-button" aria-label="Next page" disabled={pageNumber >= lastPage} onClick={() => goToPage(pageNumber + 1)}>
              <ChevronRight />
            </button>
          </div>
          <button
            type="button"
            className="columns-button"
            aria-haspopup="menu"
            onClick={(event) => setMenu({ kind: "columns", anchor: event.currentTarget })}
          >
            Columns <ChevronDown />
          </button>
        </div>
      </div>

      {error ? (
        <div className="banner" role="alert">
          <AlertIcon />
          <span className="banner-text">
            Couldn't load {page === "jobs" ? "jobs" : "your Shortlist"}. {error.message}
            <span className="error-code"> {error.code}</span>
          </span>
          <button type="button" className="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : null}

      <div className={detailOpen ? "list-body with-detail" : "list-body"}>
        {empty ? (
          <EmptyState page={page} filtered={keys.length > 0 && scopeCount !== 0} hidden={scopeCount} onClear={() => changeFilter({})} />
        ) : (
          <JobTable
            page={page}
            label={pageLabels[page]}
            items={items}
            visible={prefs.visible}
            widths={{ ...prefs.widths, ...draftWidths }}
            sort={prefs.sort}
            selected={selected}
            currentId={currentId}
            editingNotes={editingNotes}
            skeleton={!data ? slow || loading : slow}
            onSort={changeSort}
            onResize={resize}
            onHeaderMenu={(point) => setMenu({ kind: "columns", anchor: point })}
            onToggle={toggle}
            onRowClick={(id) => {
              setCurrentId(id);
              setDetailOpen(true);
            }}
            onCurrent={setCurrentId}
            onStatus={(job, status) => void updateOne(job.id, { status })}
            onEditNotes={setEditingNotes}
            onNotes={(job, notes) => {
              setEditingNotes(null);
              void updateOne(job.id, { notes });
            }}
            onOpenLink={(job) => openLink(postingUrl(job))}
          />
        )}
        {detailOpen && currentId ? (
          <Detail
            page={page}
            job={detail.job?.id === currentId ? detail.job : null}
            loading={detail.loading}
            error={detail.error}
            overlay={narrow}
            hasPrevious={currentIndexNow > 0}
            hasNext={currentIndexNow >= 0 && currentIndexNow < items.length - 1}
            adding={busy}
            onPrevious={() => move(-1)}
            onNext={() => move(1)}
            onClose={() => setDetailOpen(false)}
            onRetry={() => setDetailReload((value) => value + 1)}
            onAdd={(job) => void addJobs([job.id])}
            onOpenLink={openLink}
            onStatus={(job, status) => void updateOne(job.id, { status })}
            onNotes={(job, notes) => updateOne(job.id, { notes })}
            onRemove={(job) => void remove([job.id])}
          />
        ) : null}
      </div>

      {menu?.kind === "select" ? <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label="Select by condition" entries={selectEntries} /> : null}
      {menu?.kind === "status" ? (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          label="Set status"
          placement="bottom-end"
          entries={[
            { heading: `Set ${plural(count, "job")} to` },
            ...statuses.map((status) => ({
              key: status,
              label: (
                <span className="status-option">
                  <span className="status-dot" data-status={status} aria-hidden="true" />
                  {statusLabels[status]}
                </span>
              ),
              onSelect: () => void setStatus(selectedIds, status),
            })),
          ]}
        />
      ) : null}
      {menu?.kind === "filter" ? (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          label="Add filter"
          entries={filterMenus[page].map((key) => ({
            key,
            label: filterNames[key],
            hint: keys.includes(key) ? "On" : undefined,
            onSelect: () => setEditor({ field: key, anchor: filterButton.current! }),
          }))}
        />
      ) : null}
      {menu?.kind === "pages" ? (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          label="Pages"
          placement="bottom-end"
          entries={[
            { heading: "Rows per page" },
            ...pageSizes.map((size) => ({ key: String(size), label: String(size), checked: pageSize === size, onSelect: () => changePageSize(size) })),
            "separator",
            { key: "first", label: "First page", disabled: pageNumber <= 1, onSelect: () => goToPage(1) },
            { key: "last", label: "Last page", disabled: pageNumber >= lastPage, onSelect: () => goToPage(lastPage) },
          ]}
        />
      ) : null}
      {menu?.kind === "columns" ? (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          label="Columns"
          placement="bottom-end"
          entries={[
            { heading: "Show columns" },
            ...pageColumns[page].map((key) => ({
              key,
              label: columns[key].label,
              checked: prefs.visible.includes(key),
              // Role always stays so a row can still be identified.
              disabled: key === "title",
              onSelect: () =>
                update({
                  visible: prefs.visible.includes(key)
                    ? prefs.visible.filter((item) => item !== key)
                    : pageColumns[page].filter((item) => item === key || prefs.visible.includes(item)),
                }),
            })),
            "separator",
            {
              key: "reset",
              label: "Reset columns",
              onSelect: () => {
                const defaults = defaultListPrefs(page);
                update({ visible: defaults.visible, widths: defaults.widths });
              },
            },
          ]}
        />
      ) : null}
      {editor ? (
        <FilterEditor
          field={editor.field}
          filter={prefs.filter}
          anchor={editor.anchor}
          directions={catalog.directions}
          counts={catalog.byDirection}
          items={items}
          onApply={changeFilter}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {dialog === "export" ? (
        <ExportDialog
          page={page}
          filteredCount={total}
          allCount={scopeCount}
          summary={keys.length ? keys.map((key) => chipLabel(key, prefs.filter, directionName)).join(" · ") : "No filters"}
          onCancel={() => setDialog(null)}
          onExport={startExport}
        />
      ) : null}
      {dialog === "shortcuts" ? <ShortcutsDialog page={page} onClose={() => setDialog(null)} /> : null}
    </section>
  );
}

function EmptyState({ page, filtered, hidden, onClear }: { page: ListPage; filtered: boolean; hidden: number | null; onClear: () => void }) {
  if (filtered) {
    return (
      <div className="empty">
        <span className="empty-icon">
          <SearchIcon />
        </span>
        <h2>{page === "jobs" ? "No jobs match these filters" : "No Shortlist jobs match these filters"}</h2>
        {hidden ? <p className="muted">{plural(hidden, "job")} {hidden === 1 ? "is" : "are"} hidden by the current filters.</p> : null}
        <button type="button" className="button" onClick={onClear}>
          Clear filters
        </button>
      </div>
    );
  }
  return page === "jobs" ? (
    <div className="empty">
      <span className="empty-icon">
        <JobsIcon size={28} />
      </span>
      <h2>No jobs yet</h2>
      <p className="muted">Jobs appear here after your first run.</p>
    </div>
  ) : (
    <div className="empty">
      <span className="empty-icon">
        <ShortlistIcon size={28} />
      </span>
      <h2>Your Shortlist is empty</h2>
      <p className="muted">Select jobs in Jobs, then click Add to Shortlist.</p>
    </div>
  );
}
