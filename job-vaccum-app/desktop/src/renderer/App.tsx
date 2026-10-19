import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  ApiResult,
  AppStatus,
  ConnectionState,
  Diagnostics,
  JobVaccumApi,
  call,
} from "./api";

const PING_MAX_LENGTH = 256;

interface RequestState<T> {
  loading: boolean;
  data?: T;
  dataAt?: number;
  ms?: number;
  error?: ApiError;
}

/** One request slot; a newer call supersedes the response of an older one. */
function useRequest<T, A extends unknown[]>(request: (...args: A) => Promise<ApiResult<T>>) {
  const [state, setState] = useState<RequestState<T>>({ loading: false });
  const sequence = useRef(0);
  const run = useCallback(
    async (...args: A) => {
      const id = ++sequence.current;
      setState((previous) => ({ ...previous, loading: true }));
      const started = performance.now();
      const response = await call(() => request(...args));
      if (id !== sequence.current) return;
      const ms = Math.round(performance.now() - started);
      setState((previous) =>
        response.ok
          ? { loading: false, data: response.result, dataAt: Date.now(), ms }
          : { loading: false, data: previous.data, dataAt: previous.dataAt, ms, error: response.error },
      );
    },
    [request],
  );
  return [state, run] as const;
}

export function App() {
  const api = window.jobVaccum;
  if (!api) {
    return (
      <div className="fatal">
        <div className="fatal-panel" role="alert">
          <h1>Desktop bridge unavailable</h1>
          <p>
            The interface could not reach the Job Vaccum desktop process, so it cannot talk to the
            local backend. Open Job Vaccum from the application instead of a web browser.
          </p>
        </div>
      </div>
    );
  }
  return <Dashboard api={api} />;
}

function Dashboard({ api }: { api: JobVaccumApi }) {
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

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
      (error: unknown) => setConnectionError(error instanceof Error ? error.message : String(error)),
    );
    return unsubscribe;
  }, [api]);

  const getStatus = useCallback(() => api.getStatus(), [api]);
  const ping = useCallback((message: string) => api.ping(message), [api]);
  const getDiagnostics = useCallback(() => api.getDiagnostics(), [api]);
  const [status, refreshStatus] = useRequest(getStatus);
  const [pingState, sendPing] = useRequest(ping);
  const [diagnostics, runDiagnostics] = useRequest(getDiagnostics);

  const ready = connection?.phase === "ready";
  useEffect(() => {
    if (ready) void refreshStatus();
  }, [ready, refreshStatus]);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-title">
          <span className="app-name">Job Vaccum</span>
          <span className="toolbar-subtitle">Backend</span>
        </div>
        <ConnectionPill connection={connection} failed={connectionError !== null} />
        <button
          type="button"
          className="button"
          onClick={() => void refreshStatus()}
          disabled={!ready || status.loading}
        >
          {status.loading ? "Refreshing…" : "Refresh status"}
        </button>
      </header>

      <main className="content">
        <ConnectionBanner connection={connection} connectionError={connectionError} />
        <div className="grid">
          <div className="column">
            <ConnectionCard connection={connection} />
            <PingCard state={pingState} ready={ready} onSend={sendPing} />
          </div>
          <div className="column">
            <StatusCard state={status} ready={ready} />
          </div>
          <DiagnosticsCard state={diagnostics} ready={ready} onRun={runDiagnostics} />
        </div>
      </main>
    </div>
  );
}

function phaseLabel(connection: ConnectionState | null, failed: boolean) {
  if (failed) return { tone: "error", label: "Unavailable" };
  switch (connection?.phase) {
    case undefined:
      return { tone: "pending", label: "Connecting…" };
    case "starting":
      return { tone: "pending", label: "Starting…" };
    case "ready":
      return { tone: "ok", label: "Connected" };
    case "failed":
      return { tone: "error", label: "Failed to start" };
    case "exited":
      return { tone: "error", label: "Stopped" };
  }
}

function ConnectionPill({ connection, failed }: { connection: ConnectionState | null; failed: boolean }) {
  const { tone, label } = phaseLabel(connection, failed);
  return (
    <span className="pill" data-tone={tone} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function ConnectionBanner({
  connection,
  connectionError,
}: {
  connection: ConnectionState | null;
  connectionError: string | null;
}) {
  if (connectionError !== null) {
    return (
      <Banner title="Could not read the backend state">
        <p className="mono-wrap">{connectionError}</p>
      </Banner>
    );
  }
  if (connection?.phase === "failed") {
    return (
      <Banner title="The local backend failed to start">
        <p className="mono-wrap">{connection.message}</p>
        <p>Resolve the problem above, then quit and reopen Job Vaccum.</p>
      </Banner>
    );
  }
  if (connection?.phase === "exited") {
    const detail =
      connection.signal !== null
        ? `Stopped by signal ${connection.signal}.`
        : `Exit code ${connection.exit_code ?? "unknown"}.`;
    return (
      <Banner title="The local backend stopped">
        <p>{detail}</p>
        {connection.message ? <p className="mono-wrap">{connection.message}</p> : null}
        <p>Quit and reopen Job Vaccum to reconnect. Saved data is kept.</p>
      </Banner>
    );
  }
  return null;
}

function Banner({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="banner" role="alert">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function Card({
  title,
  action,
  wide,
  children,
}: {
  title: string;
  action?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={wide ? "card card-wide" : "card"} aria-label={title}>
      <div className="card-header">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="rows">
      {rows.map(([label, value]) => (
        <div className="row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ErrorNote({ error }: { error: ApiError }) {
  return (
    <div className="error-note" role="alert">
      <span className="code">{error.code}</span>
      <span>
        {error.message}
        {error.retryable ? " You can try again." : ""}
      </span>
    </div>
  );
}

function Meta({ at, ms }: { at?: number; ms?: number }) {
  if (at === undefined) return null;
  return (
    <p className="meta">
      Updated {new Date(at).toLocaleTimeString()}
      {ms !== undefined ? ` · ${ms} ms` : ""}
    </p>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}

function ConnectionCard({ connection }: { connection: ConnectionState | null }) {
  if (connection?.phase !== "ready") {
    const text =
      connection === null || connection.phase === "starting"
        ? "Waiting for the backend handshake…"
        : "No active connection.";
    return (
      <Card title="Connection">
        <Muted>{text}</Muted>
      </Card>
    );
  }
  const { ready } = connection;
  return (
    <Card title="Connection">
      <Rows
        rows={[
          ["Protocol", `v${ready.protocol_version}`],
          ["App version", ready.app_version],
          ["Schema version", String(ready.schema_version)],
        ]}
      />
    </Card>
  );
}

function StatusCard({ state, ready }: { state: RequestState<AppStatus>; ready: boolean }) {
  const { data } = state;
  return (
    <Card title="Status">
      {state.error ? <ErrorNote error={state.error} /> : null}
      {data ? (
        <>
          {!ready ? <Muted>Last known status; the backend is not connected.</Muted> : null}
          <Rows
            rows={[
              ["Active run", data.active_run === null ? "None" : "Running"],
              ["Operations", data.operations.length === 0 ? "None" : String(data.operations.length)],
              ["Cleanup", capitalize(data.cleanup.status)],
              ["Configuration", data.configuration_complete ? "Complete" : "Not configured"],
              ["Storage", `Schema ${data.storage.schema_version} · ${data.storage.journal_mode.toUpperCase()}`],
            ]}
          />
          <Meta at={state.dataAt} ms={state.ms} />
        </>
      ) : state.loading ? (
        <Muted>Loading status…</Muted>
      ) : state.error ? null : (
        <Muted>Available once the backend is connected.</Muted>
      )}
    </Card>
  );
}

function PingCard({
  state,
  ready,
  onSend,
}: {
  state: RequestState<{ message: string }>;
  ready: boolean;
  onSend: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("hello");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSend(message);
  };
  return (
    <Card title="Ping">
      <form className="ping-form" onSubmit={submit}>
        <label className="field">
          <span>Message</span>
          <input
            value={message}
            maxLength={PING_MAX_LENGTH}
            onChange={(event) => setMessage(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button type="submit" className="button" disabled={!ready || state.loading}>
          {state.loading ? "Sending…" : "Send ping"}
        </button>
      </form>
      {state.error ? <ErrorNote error={state.error} /> : null}
      {state.data && !state.error ? (
        <>
          <Rows rows={[["Echo", <span className="mono-wrap">{state.data.message || "(empty)"}</span>]]} />
          <Meta at={state.dataAt} ms={state.ms} />
        </>
      ) : null}
    </Card>
  );
}

function DiagnosticsCard({
  state,
  ready,
  onRun,
}: {
  state: RequestState<Diagnostics>;
  ready: boolean;
  onRun: () => Promise<void>;
}) {
  const { data } = state;
  const action = (
    <button type="button" className="button" onClick={() => void onRun()} disabled={!ready || state.loading}>
      {state.loading ? "Running…" : data ? "Run again" : "Run diagnostics"}
    </button>
  );
  return (
    <Card title="Diagnostics" action={action} wide>
      {state.error ? <ErrorNote error={state.error} /> : null}
      {data ? (
        <>
          <Rows
            rows={[
              ["Python", data.python_version],
              ["Architecture", data.machine],
              ["Runtime", data.frozen ? "Bundled" : "Development environment"],
              ["JobSpy", data.jobspy_version],
              ["JobSpy commit", <span className="mono-wrap">{data.jobspy_commit}</span>],
              ["pandas", data.pandas_version],
              ["curl_cffi", data.curl_cffi_version],
              ["libcurl", <span className="mono-wrap">{data.curl_version}</span>],
              ["SQLite", data.sqlite_version],
              [
                "Storage check",
                data.storage.read_write
                  ? `Read/write passed · schema ${data.storage.schema_version} · ${data.storage.journal_mode.toUpperCase()}`
                  : "Read/write failed",
              ],
            ]}
          />
          <Meta at={state.dataAt} ms={state.ms} />
        </>
      ) : state.loading ? (
        <Muted>Running offline checks…</Muted>
      ) : (
        <Muted>
          Checks the backend Python runtime, JobSpy and curl_cffi imports, and a rolled-back SQLite
          write. No network access.
        </Muted>
      )}
    </Card>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
