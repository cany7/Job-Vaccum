import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ApiError, AppInfo, ConnectionState, JobVaccumApi } from "./api";
import { themes, type Mode, type Theme, type UiPrefs } from "./prefs";
import { useRequest } from "./requests";

type Section = "appearance" | "about";
const sections: [Section, string][] = [
  ["appearance", "Appearance"],
  ["about", "About"],
];

export function Settings(props: {
  api: JobVaccumApi;
  connection: ConnectionState | null;
  info: AppInfo | null;
  prefs: UiPrefs;
  updatePrefs: (change: Partial<UiPrefs>) => void;
}) {
  const [section, setSection] = useState<Section>("appearance");
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {sections.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="settings-nav-item"
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === "appearance" ? (
          <Appearance prefs={props.prefs} updatePrefs={props.updatePrefs} />
        ) : (
          <About api={props.api} connection={props.connection} info={props.info} />
        )}
      </div>
    </div>
  );
}

const modeLabels: [Mode, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const themeLabels: Record<Theme, string> = { graphite: "Graphite", pine: "Pine", ink: "Ink" };

function Appearance({ prefs, updatePrefs }: { prefs: UiPrefs; updatePrefs: (change: Partial<UiPrefs>) => void }) {
  return (
    <section aria-labelledby="appearance-title">
      <header className="section-header">
        <h2 id="appearance-title">Appearance</h2>
        <p className="muted">Changes apply right away and are remembered on this Mac.</p>
      </header>
      <div className="form-grid">
        <span className="form-label" id="mode-label">
          Mode
        </span>
        <div className="mode-row">
          <div className="segmented" role="radiogroup" aria-labelledby="mode-label">
            {modeLabels.map(([mode, label]) => (
              <label key={mode} className="segment">
                <input
                  type="radio"
                  name="mode"
                  value={mode}
                  checked={prefs.mode === mode}
                  onChange={() => updatePrefs({ mode })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <span className="muted">System follows macOS light and dark.</span>
        </div>
        <ThemePicker scheme="light" value={prefs.lightTheme} onChange={(lightTheme) => updatePrefs({ lightTheme })} />
        <ThemePicker scheme="dark" value={prefs.darkTheme} onChange={(darkTheme) => updatePrefs({ darkTheme })} />
      </div>
    </section>
  );
}

function ThemePicker({ scheme, value, onChange }: { scheme: "light" | "dark"; value: Theme; onChange: (theme: Theme) => void }) {
  const labelId = `${scheme}-theme-label`;
  return (
    <>
      <span className="form-label" id={labelId}>
        {scheme === "light" ? "Light theme" : "Dark theme"}
      </span>
      <div className="swatches" role="radiogroup" aria-labelledby={labelId}>
        {themes.map((theme) => (
          <label key={theme} className="swatch">
            <input
              type="radio"
              name={`${scheme}-theme`}
              value={theme}
              checked={value === theme}
              onChange={() => onChange(theme)}
            />
            <span className="swatch-preview" data-preview-scheme={scheme} data-preview-theme={theme} aria-hidden="true">
              <span className="swatch-side" />
              <span className="swatch-card">
                <span className="swatch-button" />
                <span className="swatch-line" />
                <span className="swatch-chips">
                  <span data-chip="high" />
                  <span data-chip="warn" />
                  <span data-chip="mid" />
                </span>
              </span>
            </span>
            <span className="swatch-name">{themeLabels[theme]}</span>
          </label>
        ))}
      </div>
    </>
  );
}

function connectionText(connection: ConnectionState | null) {
  switch (connection?.phase) {
    case "ready":
      return { tone: "ok", text: `Ready · protocol v${connection.ready.protocol_version}` };
    case "failed":
      return { tone: "error", text: "Failed to start" };
    case "exited":
      return { tone: "error", text: "Stopped" };
    default:
      return { tone: "pending", text: "Starting…" };
  }
}

function About({ api, connection, info }: { api: JobVaccumApi; connection: ConnectionState | null; info: AppInfo | null }) {
  const ready = connection?.phase === "ready";
  const getStatus = useCallback(() => api.getStatus(), [api]);
  const ping = useCallback(() => api.ping("ping"), [api]);
  const getDiagnostics = useCallback(() => api.getDiagnostics(), [api]);
  const [status, refreshStatus] = useRequest(getStatus);
  const [pingState, sendPing] = useRequest(ping);
  const [diagnostics, runDiagnostics] = useRequest(getDiagnostics);
  useEffect(() => {
    if (ready) void refreshStatus();
  }, [ready, refreshStatus]);
  const backend = connectionText(connection);
  const storage = status.data?.storage;

  return (
    <section aria-labelledby="about-title">
      <header className="about-header">
        <h2 id="about-title">Job Vaccum</h2>
        <p className="muted">{info ? `Version ${info.version} · macOS ${info.arch}` : " "}</p>
      </header>
      <dl className="rows">
        <Row label="Backend">
          <span className="status-text" data-tone={backend.tone}>
            <span className="dot" aria-hidden="true" />
            {backend.text}
          </span>
        </Row>
        <Row
          label="Data folder"
          action={
            <button type="button" className="button" onClick={() => void api.showDataFolder()}>
              Show in Finder
            </button>
          }
        >
          <span className="path">{info?.data_dir ?? ""}</span>
        </Row>
        <Row
          label="Database"
          action={
            status.error ? (
              <button type="button" className="button" disabled={!ready || status.loading} onClick={() => void refreshStatus()}>
                Try again
              </button>
            ) : undefined
          }
        >
          {status.error ? (
            <ErrorText error={status.error} />
          ) : storage ? (
            `Schema ${storage.schema_version} · ${storage.journal_mode.toUpperCase()}`
          ) : (
            <span className="muted">{ready ? "Checking…" : "Available once the backend is ready."}</span>
          )}
        </Row>
        {info && !info.packaged ? (
          <Row
            label="Ping"
            action={
              <button type="button" className="button" disabled={!ready || pingState.loading} onClick={() => void sendPing()}>
                {pingState.loading ? "Pinging…" : "Ping"}
              </button>
            }
          >
            {pingState.error ? (
              <ErrorText error={pingState.error} />
            ) : (
              <>
                {pingState.data ? `Replied in ${pingState.ms} ms` : "Not sent"}
                <span className="muted small"> · development build only</span>
              </>
            )}
          </Row>
        ) : null}
      </dl>

      <div className="diagnostics-header">
        <h3>Diagnostics</h3>
        <p className="muted">Checks the bundled Python and libraries without using the network.</p>
        <button type="button" className="button" disabled={!ready || diagnostics.loading} onClick={() => void runDiagnostics()}>
          {diagnostics.loading ? "Running…" : diagnostics.data ? "Run again" : "Run diagnostics"}
        </button>
      </div>
      {diagnostics.error ? <ErrorText error={diagnostics.error} block /> : null}
      {diagnostics.data ? (
        <dl className="diagnostics" aria-label="Diagnostics results">
          {(
            [
              ["Python", diagnostics.data.python_version],
              ["Architecture", diagnostics.data.machine],
              ["Runtime", diagnostics.data.frozen ? "Bundled" : "Development environment"],
              ["JobSpy", diagnostics.data.jobspy_version],
              ["JobSpy commit", diagnostics.data.jobspy_commit],
              ["pandas", diagnostics.data.pandas_version],
              ["curl_cffi", diagnostics.data.curl_cffi_version],
              ["libcurl", diagnostics.data.curl_version],
              ["SQLite", diagnostics.data.sqlite_version],
              [
                "Storage check",
                diagnostics.data.storage.read_write
                  ? `Read/write passed · schema ${diagnostics.data.storage.schema_version} · ${diagnostics.data.storage.journal_mode.toUpperCase()}`
                  : "Read/write failed",
              ],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function Row({ label, action, children }: { label: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd>{children}</dd>
      {action ? <div className="row-action">{action}</div> : null}
    </div>
  );
}

/** Reason first; the code follows in small secondary text. */
export function ErrorText({ error, block }: { error: ApiError; block?: boolean }) {
  return (
    <span className={block ? "error-text error-block" : "error-text"} role="alert">
      <span>{error.message}</span> <span className="error-code">{error.code}</span>
    </span>
  );
}
