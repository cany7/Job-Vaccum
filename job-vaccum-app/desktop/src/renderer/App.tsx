import { useEffect, useState, type ReactNode } from "react";
import type { AppInfo, ConnectionState, JobVaccumApi } from "./api";
import { BackendStopped, StartupFailure } from "./Failure";
import { JobsIcon, SearchIcon, SettingsIcon, ShortlistIcon, SidebarIcon } from "./icons";
import { useNarrow, usePrefs } from "./prefs";
import { Settings } from "./Settings";

type Page = "jobs" | "shortlist" | "settings";
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
  return <Shell api={api} connection={connection} info={info} prefs={prefs} updatePrefs={updatePrefs} />;
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
  prefs: ReturnType<typeof usePrefs>[0];
  updatePrefs: ReturnType<typeof usePrefs>[1];
}) {
  const [page, setPage] = useState<Page>("jobs");
  const narrow = useNarrow();
  // Narrow windows collapse automatically; expanding there lasts until the window widens.
  const [expandedWhileNarrow, setExpandedWhileNarrow] = useState(false);
  useEffect(() => {
    if (!narrow) setExpandedWhileNarrow(false);
  }, [narrow]);
  const collapsed = narrow ? !expandedWhileNarrow : prefs.sidebarCollapsed;
  const stopped = connection?.phase === "exited" ? connection : null;

  const toggleSidebar = () => {
    if (narrow) setExpandedWhileNarrow(collapsed);
    else updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.metaKey && !event.altKey && !event.shiftKey && event.code === "KeyS") {
        event.preventDefault();
        if (!stopped) toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
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
        <div className="topbar-actions" />
      </header>
      <Sidebar collapsed={collapsed} page={page} onNavigate={setPage} connection={connection} inert={stopped !== null} />
      <main className="card" aria-label={pageNames[page]}>
        {stopped ? (
          <BackendStopped api={api} state={stopped} />
        ) : page === "settings" ? (
          <Settings api={api} connection={connection} info={info} prefs={prefs} updatePrefs={updatePrefs} />
        ) : page === "jobs" ? (
          <Empty icon={<JobsIcon size={28} />} title="No jobs yet">
            Jobs appear here after your first run.
          </Empty>
        ) : (
          <Empty icon={<ShortlistIcon size={28} />} title="Your Shortlist is empty">
            Select jobs in Jobs, then click Add to Shortlist.
          </Empty>
        )}
      </main>
    </div>
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

function Sidebar({
  collapsed,
  page,
  onNavigate,
  connection,
  inert,
}: {
  collapsed: boolean;
  page: Page;
  onNavigate: (page: Page) => void;
  connection: ConnectionState | null;
  inert: boolean;
}) {
  const status = statusOf(connection);
  const item = (id: Page, icon: ReactNode) => (
    <button
      type="button"
      className="nav-item"
      aria-current={page === id ? "page" : undefined}
      aria-label={collapsed ? pageNames[id] : undefined}
      title={collapsed ? pageNames[id] : undefined}
      onClick={() => onNavigate(id)}
    >
      {icon}
      {collapsed ? null : <span className="nav-label">{pageNames[id]}</span>}
    </button>
  );
  return (
    <aside id="sidebar" className="sidebar" inert={inert}>
      {/* Search is wired to job data in the list step; until then it is a disabled placeholder. */}
      {collapsed ? (
        <button type="button" className="nav-item" disabled aria-label="Search" title="Search (⌘F)">
          <SearchIcon />
        </button>
      ) : (
        <label className="search-field">
          <SearchIcon />
          <input type="search" placeholder="Search" aria-label="Search jobs" disabled />
          <kbd>⌘F</kbd>
        </label>
      )}
      <nav className="nav" aria-label="Main">
        {item("jobs", <JobsIcon />)}
        {item("shortlist", <ShortlistIcon />)}
      </nav>
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

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </div>
  );
}
