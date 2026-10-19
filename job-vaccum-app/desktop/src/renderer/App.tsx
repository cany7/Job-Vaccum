import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { call, type ApiResult, type AppInfo, type ConnectionState, type JobVaccumApi, type ServiceEvent } from "./api";
import { AppContext, type AppContextValue, type Catalog, type OperationResult, type Page, type SettingsSection } from "./context";
import { BackendStopped, StartupFailure } from "./Failure";
import { JobsIcon, SearchesIcon, SearchIcon, SettingsIcon, ShortlistIcon, SidebarIcon } from "./icons";
import type { ListPage } from "./listModel";
import { ListView, type TopbarSlots } from "./ListView";
import { updateList, useNarrow, usePrefs, type UiPrefs, type UpdatePrefs } from "./prefs";
import { Settings } from "./Settings";
import { ToastProvider, useToast } from "./toasts";
import { Menu, Popover } from "./ui";

const pageNames: Record<Page, string> = { jobs: "Jobs", shortlist: "Shortlist", settings: "Settings" };

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

const emptyCatalog: Catalog = { directions: [], retentionDays: null, jobs: null, shortlist: null, byDirection: {} };

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
  const activeList: ListPage = page === "settings" ? lastList : page;

  const [catalog, refreshCatalog] = useCatalog(api, ready);
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
    [api, refreshCatalog],
  );

  const navigate = useCallback((next: Page, nextSection?: SettingsSection) => {
    setPage(next);
    if (next !== "settings") setLastList(next);
    if (nextSection) setSection(nextSection);
  }, []);

  const context = useMemo<AppContextValue>(
    () => ({
      api,
      catalog,
      refreshCatalog,
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
      narrow,
    }),
    [api, catalog, refreshCatalog, dataVersion, outsideChanges, navigate, narrow],
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

  const toggleSidebar = () => {
    updatePrefs({ sidebarCollapsed: !collapsed });
    if (narrow) setExpandedWhileNarrow(collapsed);
  };

  const searchInput = useRef<HTMLInputElement>(null);
  const [railSearch, setRailSearch] = useState(false);
  const focusSearch = () => {
    if (page === "settings") navigate(lastList);
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
    if (page === "settings") navigate(list);
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

function Sidebar(props: {
  collapsed: boolean;
  page: Page;
  activeList: ListPage;
  onNavigate: (page: Page, section?: SettingsSection) => void;
  connection: ConnectionState | null;
  inert: boolean;
  ready: boolean;
  catalog: Catalog;
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
        <div className="sidebar-status" data-tone={status.tone} title={collapsed ? status.text : undefined}>
          <span className="dot" aria-hidden="true" />
          <span className={collapsed ? "visually-hidden" : undefined} role="status">
            {status.text}
          </span>
        </div>
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
        aria-current={current && props.page !== "settings" ? "true" : undefined}
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
    props.page !== "settings" && (id === null ? selectedDirections.length === 0 : selectedDirections.length === 1 && selectedDirections[0] === id);
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
