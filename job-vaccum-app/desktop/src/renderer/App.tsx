import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { call, type ApiResult, type AppInfo, type ConnectionState, type JobVaccumApi, type ServiceEvent } from "./api";
import { AppContext, type AppContextValue, type Catalog, type OperationResult, type Page, type RunsState, type SettingsSection } from "./context";
import { BackendStopped, StartupFailure } from "./Failure";
import { formatRunTime, runStageLabels, runStatusLabels } from "./format";
import { JobsIcon, RunsIcon, SearchesIcon, SearchIcon, SettingsIcon, ShortlistIcon, SidebarIcon } from "./icons";
import type { ListPage } from "./listModel";
import { ListView, type TopbarSlots } from "./ListView";
import { updateList, useNarrow, usePrefs, type UiPrefs, type UpdatePrefs } from "./prefs";
import { Runs } from "./Runs";
import { Settings } from "./Settings";
import { ToastProvider, useToast } from "./toasts";
import { Menu, Popover } from "./ui";

const pageNames: Record<Page, string> = { jobs: "Jobs", shortlist: "Shortlist", runs: "Runs", settings: "Settings" };

export function App() {
  const api = window.jobVaccum;
  if (!api) {
    return (
      <div className="failure-window">
        <div className="drag-strip" />
        <main className="failure" role="alert">
          <h1>Open Job Vaccum from the application</h1>
          <p className="failure-reason">
            This window can't reach the Job Vaccum desktop process, so it can't use the local backend.
          </p>
        </main>
      </div>
    );
  }
  return <Root api={api} />;
}

function Root({ api }: { api: JobVaccumApi }) {
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [prefs, updatePrefs] = usePrefs();

  useEffect(() => {
    let received = false;
    const unsubscribe = api.onConnectionChange((state) => {
      received = true;
      setConnection(state);
    });
    api.getConnection().then(
      (state) => {
        if (!received) setConnection(state);
      },
      (error: unknown) => setConnection({ phase: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    api.getAppInfo().then(setInfo, () => setInfo(null));
    return unsubscribe;
  }, [api]);

  if (connection?.phase === "failed") return <StartupFailure api={api} message={connection.message} info={info} />;
  return (
    <ToastProvider>
      <Shell api={api} connection={connection} info={info} prefs={prefs} updatePrefs={updatePrefs} />
    </ToastProvider>
  );
}

const emptyCatalog: Catalog = { directions: [], settings: null, retentionDays: null, jobs: null, shortlist: null, byDirection: {} };

/** Searches, retention and the sidebar counts (Jobs, Shortlist, each search). */
function useCatalog(api: JobVaccumApi, ready: boolean) {
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    if (!ready) return;
    const id = ++sequence.current;
    const count = (params: Parameters<JobVaccumApi["listJobs"]>[0]) =>
      call(() => api.listJobs({ ...params, page_size: 1 })).then((response) => (response.ok ? response.result.total : null));
    void (async () => {
      const [settings, jobs, shortlist] = await Promise.all([
        call(() => api.getSettings()),
        count({ scope: "discover" }),
        count({ scope: "applications" }),
      ]);
      const directions = settings.ok ? settings.result.directions : null;
      const totals = await Promise.all((directions ?? []).map((direction) => count({ scope: "discover", direction_ids: [direction.id] })));
      if (id !== sequence.current) return;
      setCatalog((previous) => ({
        directions: directions ?? previous.directions,
        settings: settings.ok ? settings.result : previous.settings,
        retentionDays: settings.ok ? settings.result.retention_days : previous.retentionDays,
        jobs,
        shortlist,
        byDirection: Object.fromEntries((directions ?? []).map((direction, index) => [direction.id, totals[index] ?? 0])),
        error: settings.ok ? undefined : settings.error,
      }));
    })();
  }, [api, ready]);
  useEffect(refresh, [refresh]);
  return [catalog, refresh] as const;
}

const RUN_PAGE_SIZE = 200;

/** Retrieval runs for Runs, batch filters and the sidebar; the active run comes from app.status. */
function useRuns(api: JobVaccumApi, ready: boolean) {
  const [runs, setRuns] = useState<RunsState>({ items: [], total: 0, active: null, loaded: false });
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    if (!ready) return;
    const id = ++sequence.current;
    void Promise.all([call(() => api.listRuns({ page_size: RUN_PAGE_SIZE })), call(() => api.getStatus())]).then(([list, status]) => {
      if (id !== sequence.current) return;
      setRuns((previous) => ({
        items: list.ok ? list.result.items : previous.items,
        total: list.ok ? list.result.total : previous.total,
        active: status.ok ? status.result.active_run : previous.active,
        loaded: previous.loaded || list.ok,
        error: list.ok ? undefined : list.error,
      }));
    });
  }, [api, ready]);
  useEffect(refresh, [refresh]);
  return [runs, refresh] as const;
}

function Shell({
  api,
  connection,
  info,
  prefs,
  updatePrefs,
}: {
  api: JobVaccumApi;
  connection: ConnectionState | null;
  info: AppInfo | null;
  prefs: UiPrefs;
  updatePrefs: UpdatePrefs;
}) {
  const toast = useToast();
  const [page, setPage] = useState<Page>("jobs");
  const [section, setSection] = useState<SettingsSection>("searches");
  const [lastList, setLastList] = useState<ListPage>("jobs");
  const narrow = useNarrow();
  // Narrow windows collapse automatically without changing the preference; expanding
  // there lasts until the window widens. Every manual toggle saves the preference.
  const [expandedWhileNarrow, setExpandedWhileNarrow] = useState(false);
  useEffect(() => {
    if (!narrow) setExpandedWhileNarrow(false);
  }, [narrow]);
  const collapsed = narrow ? !expandedWhileNarrow : prefs.sidebarCollapsed;
  const stopped = connection?.phase === "exited" ? connection : null;
  const ready = connection?.phase === "ready";
  const activeList: ListPage = page === "settings" || page === "runs" ? lastList : page;

  const [catalog, refreshCatalog] = useCatalog(api, ready);
  const [runs, refreshRuns] = useRuns(api, ready);
  const [runVersion, setRunVersion] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);
  const [outsideChanges, setOutsideChanges] = useState(0);
  // jobs.changed events still expected for this window's own successful requests.
  const ownChanges = useRef(0);
  const operations = useRef(new Map<string, OperationResult>());
  const waiting = useRef(new Map<string, (result: OperationResult) => void>());

  useEffect(
    () =>
      api.onServiceEvent((event: ServiceEvent) => {
        if (event.name === "jobs.changed") {
          if (ownChanges.current > 0) ownChanges.current -= 1;
          else setOutsideChanges((value) => value + 1);
          refreshCatalog();
        } else if (event.name === "run.updated" || event.name === "run.stats" || event.name === "cleanup.completed") {
          refreshRuns();
          setRunVersion((value) => value + 1);
        } else if (event.name === "operation.completed" || event.name === "operation.failed") {
          const result: OperationResult =
            event.name === "operation.completed" ? { ok: true, row_count: event.data.row_count } : { ok: false, error: event.data.error };
          const resolve = waiting.current.get(event.data.operation_id);
          if (resolve) {
            waiting.current.delete(event.data.operation_id);
            resolve(result);
          } else operations.current.set(event.data.operation_id, result);
        }
      }),
    [api, refreshCatalog, refreshRuns],
  );

  const navigate = useCallback((next: Page, nextSection?: SettingsSection) => {
    setPage(next);
    if (next === "jobs" || next === "shortlist") setLastList(next);
    if (nextSection) setSection(nextSection);
  }, []);
  const openBatch = useCallback(
    (runId: string) => {
      updateList(updatePrefs, "jobs", { filter: { run_ids: [runId] } });
      navigate("jobs");
    },
    [updatePrefs, navigate],
  );

  const context = useMemo<AppContextValue>(
    () => ({
      api,
      catalog,
      refreshCatalog,
      runs,
      refreshRuns,
      runVersion,
      mutate: async <T,>(request: () => Promise<ApiResult<T>>, emitsChange = true) => {
        if (emitsChange) ownChanges.current += 1;
        const response = await call(request);
        if (!emitsChange) return response;
        if (response.ok) setDataVersion((value) => value + 1);
        else ownChanges.current = Math.max(0, ownChanges.current - 1);
        return response;
      },
      dataVersion,
      outsideChanges,
      waitForOperation: (operationId) => {
        const done = operations.current.get(operationId);
        if (done) {
          operations.current.delete(operationId);
          return Promise.resolve(done);
        }
        return new Promise((resolve) => waiting.current.set(operationId, resolve));
      },
      navigate,
      openBatch,
      narrow,
    }),
    [api, catalog, refreshCatalog, runs, refreshRuns, runVersion, dataVersion, outsideChanges, navigate, openBatch, narrow],
  );

  // Filters on a search that no longer exists are dropped, with a note.
  useEffect(() => {
    if (catalog.error || catalog.jobs === null) return;
    const known = new Set(catalog.directions.map((direction) => direction.id));
    let removed = false;
    for (const list of ["jobs", "shortlist"] as const) {
      const ids = prefs.lists[list].filter.direction_ids;
      if (!ids?.some((id) => !known.has(id))) continue;
      const kept = ids.filter((id) => known.has(id));
      updateList(updatePrefs, list, { filter: { ...prefs.lists[list].filter, direction_ids: kept.length ? kept : undefined } });
      removed = true;
    }
    if (removed) toast({ text: "A filter for a search that no longer exists was removed." });
    // Only a changed set of searches can make a filter stale.
  }, [catalog.directions]);

  // Batch filters on runs removed by cleanup are dropped, with a note. Runs past the
  // listed newest ones are checked one by one before they count as gone.
  useEffect(() => {
    if (!runs.loaded || runs.error) return;
    const chosen = prefs.lists.jobs.filter.run_ids ?? [];
    const listed = new Set(runs.items.map((run) => run.id));
    const unlisted = chosen.filter((id) => !listed.has(id));
    if (!unlisted.length) return;
    let cancelled = false;
    void (async () => {
      const gone = new Set<string>();
      for (const id of unlisted) {
        if (runs.total <= runs.items.length) gone.add(id);
        else {
          const response = await call(() => api.getRunDetail({ run_id: id, task_page_size: 1 }));
          if (!response.ok && response.error.code === "NOT_FOUND") gone.add(id);
        }
      }
      if (cancelled || !gone.size) return;
      updatePrefs((previous) => {
        const filter = previous.lists.jobs.filter;
        const kept = (filter.run_ids ?? []).filter((id) => !gone.has(id));
        return { lists: { ...previous.lists, jobs: { ...previous.lists.jobs, filter: { ...filter, run_ids: kept.length ? kept : undefined } } } };
      });
      toast({ text: "A batch filter for a run that no longer exists was removed." });
    })();
    return () => {
      cancelled = true;
    };
    // Only a changed run list can make a batch filter stale.
  }, [runs]);

  const toggleSidebar = () => {
    updatePrefs({ sidebarCollapsed: !collapsed });
    if (narrow) setExpandedWhileNarrow(collapsed);
  };

  const searchInput = useRef<HTMLInputElement>(null);
  const [railSearch, setRailSearch] = useState(false);
  const focusSearch = () => {
    if (page === "settings" || page === "runs") navigate(lastList);
    if (collapsed) setRailSearch(true);
    else searchInput.current?.focus();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (stopped || document.querySelector("dialog[open]")) return;
      if (event.ctrlKey && event.metaKey && !event.altKey && !event.shiftKey && event.code === "KeyS") {
        event.preventDefault();
        toggleSidebar();
      } else if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.code === "KeyF" && ready) {
        event.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const [slots, setSlots] = useState<TopbarSlots>({ actions: null, subtitle: null });
  const actionsRef = useCallback((element: HTMLDivElement | null) => setSlots((current) => ({ ...current, actions: element })), []);
  const subtitleRef = useCallback((element: HTMLSpanElement | null) => setSlots((current) => ({ ...current, subtitle: element })), []);

  const searchText = prefs.lists[activeList].filter.text ?? "";
  const setSearchText = (text: string) =>
    updateList(updatePrefs, activeList, { filter: { ...prefs.lists[activeList].filter, text: text || undefined } });
  const chooseDirection = (id: string | null) => {
    const list = activeList;
    updateList(updatePrefs, list, { filter: { ...prefs.lists[list].filter, direction_ids: id ? [id] : undefined } });
    if (page === "settings" || page === "runs") navigate(list);
  };

  return (
    <AppContext.Provider value={context}>
      <div className="shell" data-sidebar={collapsed ? "collapsed" : "expanded"}>
        <header className="topbar">
          <div className="topbar-lead">
            <button
              type="button"
              className="icon-button"
              onClick={toggleSidebar}
              disabled={stopped !== null}
              aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
              aria-expanded={!collapsed}
              aria-controls="sidebar"
              title={`${collapsed ? "Show" : "Hide"} sidebar (⌃⌘S)`}
            >
              <SidebarIcon />
            </button>
          </div>
          <h1 className="page-title">{pageNames[page]}</h1>
          <span className="page-subtitle" ref={subtitleRef} hidden={page === "settings" || !ready || stopped !== null} />
          <div className="topbar-actions" ref={actionsRef} hidden={page === "settings" || stopped !== null} />
        </header>
        <Sidebar
          collapsed={collapsed}
          page={page}
          activeList={activeList}
          onNavigate={navigate}
          connection={connection}
          inert={stopped !== null}
          ready={ready}
          catalog={catalog}
          runs={runs}
          selectedDirections={prefs.lists[activeList].filter.direction_ids ?? []}
          onDirection={chooseDirection}
          searchText={searchText}
          onSearch={setSearchText}
          searchInput={searchInput}
          railSearch={railSearch}
          setRailSearch={setRailSearch}
        />
        <main className="card" aria-label={pageNames[page]}>
          {stopped ? (
            <BackendStopped api={api} state={stopped} />
          ) : (
            <>
              {ready ? (
                (["jobs", "shortlist"] as const).map((list) => (
                  <ListView
                    key={list}
                    page={list}
                    active={page === list}
                    prefs={prefs.lists[list]}
                    update={(change) => updateList(updatePrefs, list, change)}
                    detailWidth={prefs.detailWidth}
                    onDetailWidth={(detailWidth) => updatePrefs({ detailWidth })}
                    slots={slots}
                    onEditSearch={focusSearch}
                  />
                ))
              ) : page !== "settings" ? (
                <div className="empty">
                  <p className="muted">Starting Job Vaccum…</p>
                </div>
              ) : null}
              {ready && page === "runs" ? <Runs slots={slots} /> : null}
              {page === "settings" ? (
                <Settings
                  api={api}
                  connection={connection}
                  info={info}
                  prefs={prefs}
                  updatePrefs={updatePrefs}
                  section={section}
                  onSection={setSection}
                />
              ) : null}
            </>
          )}
        </main>
      </div>
    </AppContext.Provider>
  );
}

function statusOf(connection: ConnectionState | null) {
  switch (connection?.phase) {
    case "ready":
      return { tone: "ok", text: "Backend ready" };
    case "exited":
      return { tone: "error", text: "Backend stopped" };
    case "failed":
      return { tone: "error", text: "Backend failed" };
    default:
      return { tone: "pending", text: "Starting backend…" };
  }
}

/** Run line under the connection status: the active run, else when the last run started. */
function runText(runs: RunsState) {
  if (runs.active) {
    const stage = runs.active.stage ? ` · ${runStageLabels[runs.active.stage]}` : "";
    return runs.active.status === "stopping" ? "Stopping run…" : `Run in progress${stage}`;
  }
  const last = runs.items[0];
  return last ? `Last run ${formatRunTime(last.started_at)} · ${runStatusLabels[last.status]}` : null;
}

function Sidebar(props: {
  collapsed: boolean;
  page: Page;
  activeList: ListPage;
  onNavigate: (page: Page, section?: SettingsSection) => void;
  connection: ConnectionState | null;
  inert: boolean;
  ready: boolean;
  catalog: Catalog;
  runs: RunsState;
  selectedDirections: string[];
  onDirection: (id: string | null) => void;
  searchText: string;
  onSearch: (text: string) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  railSearch: boolean;
  setRailSearch: (open: boolean) => void;
}) {
  const { collapsed, page, catalog } = props;
  const status = statusOf(props.connection);
  const run = runText(props.runs);
  const counts: Partial<Record<Page, number | null>> = { jobs: catalog.jobs, shortlist: catalog.shortlist };
  const searchButton = useRef<HTMLButtonElement>(null);
  const item = (id: Page, icon: ReactNode) => (
    <button
      type="button"
      className="nav-item"
      aria-current={page === id ? "page" : undefined}
      aria-label={collapsed ? pageNames[id] : undefined}
      title={collapsed ? pageNames[id] : undefined}
      onClick={() => props.onNavigate(id)}
    >
      {icon}
      {collapsed ? null : (
        <>
          <span className="nav-label">{pageNames[id]}</span>
          {counts[id] != null ? <span className="nav-count">{counts[id]!.toLocaleString("en-US")}</span> : null}
        </>
      )}
    </button>
  );
  const listName = props.activeList === "jobs" ? "jobs" : "Shortlist";
  return (
    <aside id="sidebar" className="sidebar" inert={props.inert}>
      {collapsed ? (
        <button
          ref={searchButton}
          type="button"
          className="nav-item"
          disabled={!props.ready}
          aria-label="Search"
          aria-haspopup="dialog"
          aria-expanded={props.railSearch}
          title="Search (⌘F)"
          data-active={props.searchText ? true : undefined}
          onClick={() => props.setRailSearch(!props.railSearch)}
        >
          <SearchIcon />
        </button>
      ) : (
        <label className="search-field">
          <SearchIcon />
          <input
            ref={props.searchInput}
            type="search"
            placeholder="Search"
            aria-label={`Search ${listName}`}
            disabled={!props.ready}
            value={props.searchText}
            onChange={(event) => props.onSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.blur();
            }}
          />
          <kbd>⌘F</kbd>
        </label>
      )}
      {collapsed && props.railSearch && searchButton.current ? (
        <Popover anchor={searchButton.current} placement="right-start" label="Search" className="search-popover" onClose={() => props.setRailSearch(false)}>
          <label className="search-field">
            <SearchIcon />
            <input
              type="search"
              placeholder="Search"
              aria-label={`Search ${listName}`}
              value={props.searchText}
              onChange={(event) => props.onSearch(event.target.value)}
            />
            <kbd>Esc</kbd>
          </label>
          <p className="muted small">Title, company or location</p>
        </Popover>
      ) : null}
      <nav className="nav" aria-label="Main">
        {item("jobs", <JobsIcon />)}
        {item("shortlist", <ShortlistIcon />)}
        {item("runs", <RunsIcon />)}
        {collapsed && catalog.directions.length ? <RailSearches {...props} /> : null}
      </nav>
      {!collapsed && catalog.directions.length ? (
        <nav className="searches" aria-label="Searches">
          <h2 className="sidebar-heading">Searches</h2>
          <SearchesList {...props} />
        </nav>
      ) : null}
      <div className="sidebar-footer">
        <nav aria-label="Settings">{item("settings", <SettingsIcon />)}</nav>
        <div
          className="sidebar-status"
          data-tone={status.tone === "ok" && run ? "running" : status.tone}
          title={collapsed ? (run ? `${status.text} · ${run}` : status.text) : undefined}
        >
          <span className="dot" aria-hidden="true" />
          <span className={collapsed ? "visually-hidden" : undefined} role="status">
            {status.text}
          </span>
        </div>
        {!collapsed && props.ready && run ? <div className="sidebar-run">{run}</div> : null}
      </div>
    </aside>
  );
}

function SearchesList(props: Parameters<typeof Sidebar>[0]) {
  const { catalog, selectedDirections } = props;
  const entry = (id: string | null, name: string, count: number | null | undefined) => {
    const current = id === null ? selectedDirections.length === 0 : selectedDirections.length === 1 && selectedDirections[0] === id;
    return (
      <button
        key={id ?? "all"}
        type="button"
        className="search-item"
        aria-current={current && (props.page === "jobs" || props.page === "shortlist") ? "true" : undefined}
        onClick={() => props.onDirection(id)}
      >
        <span className="nav-label">{name}</span>
        {count != null ? <span className="nav-count">{count.toLocaleString("en-US")}</span> : null}
      </button>
    );
  };
  return (
    <>
      {entry(null, "All searches", catalog.jobs)}
      {catalog.directions.map((direction) => entry(direction.id, direction.name, catalog.byDirection[direction.id]))}
    </>
  );
}

/** Rail: hovering (or clicking) the Searches icon pops out the list of searches. */
function RailSearches(props: Parameters<typeof Sidebar>[0]) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<"hover" | "click" | null>(null);
  const closeTimer = useRef(0);
  const holdOpen = () => window.clearTimeout(closeTimer.current);
  const closeSoon = () => {
    holdOpen();
    closeTimer.current = window.setTimeout(() => setOpen((value) => (value === "hover" ? null : value)), 250);
  };
  const { catalog, selectedDirections } = props;
  const isCurrent = (id: string | null) =>
    (props.page === "jobs" || props.page === "shortlist") && (id === null ? selectedDirections.length === 0 : selectedDirections.length === 1 && selectedDirections[0] === id);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="nav-item"
        aria-label="Searches"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        disabled={!props.ready}
        data-active={selectedDirections.length ? true : undefined}
        onPointerEnter={() => {
          holdOpen();
          setOpen((value) => value ?? "hover");
        }}
        onPointerLeave={closeSoon}
        onClick={() => setOpen((value) => (value === "click" ? null : "click"))}
      >
        <SearchesIcon />
      </button>
      {open && button.current ? (
        <Menu
          anchor={button.current}
          placement="right-start"
          label="Searches"
          className="searches-menu"
          initialFocus={open === "click"}
          onClose={() => setOpen(null)}
          onPointerEnter={holdOpen}
          onPointerLeave={() => {
            if (open === "hover") closeSoon();
          }}
          entries={[
            { heading: "Searches" },
            {
              key: "all",
              label: "All searches",
              checked: isCurrent(null),
              hint: catalog.jobs?.toLocaleString("en-US"),
              onSelect: () => props.onDirection(null),
            },
            ...catalog.directions.map((direction) => ({
              key: direction.id,
              label: direction.name,
              checked: isCurrent(direction.id),
              hint: catalog.byDirection[direction.id]?.toLocaleString("en-US"),
              onSelect: () => props.onDirection(direction.id),
            })),
            "separator" as const,
            { key: "edit", label: "Edit searches…", onSelect: () => props.onNavigate("settings", "searches") },
          ]}
        />
      ) : null}
    </>
  );
}
