import type { BusinessApi } from "./business";
export type * from "./business";
// Shared types for the named preload API. Electron main/preload implement it and
// expose it as `window.jobVaccum` via contextBridge; the renderer never sends
// arbitrary methods. Field names follow protocol v1 (snake_case).

export interface ReadyInfo {
  protocol_version: number;
  app_version: string;
  schema_version: number;
}

/** Python service lifecycle as observed by Electron main. */
export type ConnectionState =
  | { phase: "starting" }
  | { phase: "ready"; ready: ReadyInfo }
  /** Startup failed before a compatible ready event (lock BUSY, migration, protocol mismatch, spawn error). */
  | { phase: "failed"; message: string }
  /** The service exited after it had been running. */
  | { phase: "exited"; exit_code: number | null; signal: string | null; message?: string };

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  http_status?: number;
  field_errors?: Record<string, string>;
}

export type ApiResult<T> = { ok: true; result: T } | { ok: false; error: ApiError };

export interface AppStatus {
  active_run: import("./runs").ActiveRun | null;
  operations: ({ operation_id: string; kind: 'export' } |
    { operation_id: string; kind: 'model_test'; status: 'running' | 'cancelling' })[];
  cleanup: { status: string };
  configuration_complete: boolean;
  storage: { schema_version: number; journal_mode: string };
}

export interface Diagnostics {
  python_version: string;
  machine: string;
  frozen: boolean;
  jobspy_commit: string;
  jobspy_version: string;
  pandas_version: string;
  curl_cffi_version: string;
  curl_version: string;
  sqlite_version: string;
  storage: { read_write: boolean; schema_version: number; journal_mode: string };
}

/** Static desktop facts from Electron main; data_dir is for display only (home shown as ~). */
export interface AppInfo {
  version: string;
  arch: string;
  packaged: boolean;
  data_dir: string;
}

export interface JobVaccumApi extends BusinessApi {
  getDesktopPreferences(): Promise<{ show_menu_bar_icon: boolean }>;
  setDesktopPreferences(params: { show_menu_bar_icon: boolean }): Promise<{ show_menu_bar_icon: boolean }>;
  getConnection(): Promise<ConnectionState>;
  /** Returns an unsubscribe function. */
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
  getStatus(): Promise<ApiResult<AppStatus>>;
  ping(message: string): Promise<ApiResult<{ message: string }>>;
  getDiagnostics(): Promise<ApiResult<Diagnostics>>;
  getAppInfo(): Promise<AppInfo>;
  /** Quits through the normal bounded shutdown. */
  quit(): Promise<void>;
  /** Reveals this App's data directory in Finder; takes no path. */
  showDataFolder(): Promise<void>;
  /** Opens an http(s) link in the default browser; any other scheme is rejected. */
  openLink(url: string): Promise<void>;
}

declare global {
  interface Window {
    jobVaccum?: JobVaccumApi;
  }
}
