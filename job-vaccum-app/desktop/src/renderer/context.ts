import { createContext, useContext } from "react";
import type { ActiveRun, ApiError, ApiResult, Direction, JobVaccumApi, RunSummary, Settings } from "./api";
import type { ListFilter, ListPage } from "./listModel";

export type Page = ListPage | "runs" | "settings";
export type SettingsSection = "searches" | "filters" | "model" | "proxy" | "data" | "appearance" | "about";

/** Searches and sidebar counts, reloaded whenever job data changes. */
export interface Catalog {
  directions: Direction[];
  /** Full non-secret settings for the Settings sections; null until first loaded. */
  settings: Settings | null;
  retentionDays: number | null;
  jobs: number | null;
  shortlist: number | null;
  byDirection: Record<string, number>;
  error?: ApiError;
}

/** Retrieval runs (newest first, up to 200) and the active run, reloaded on run events. */
export interface RunsState {
  items: RunSummary[];
  total: number;
  /** Manual scoring runs (newest first, up to 200); listed in Runs only, never as batches. */
  rescores: RunSummary[];
  rescoreTotal: number;
  active: ActiveRun | null;
  loaded: boolean;
  error?: ApiError;
}

/** CSV exports report row_count; a model connection test only succeeds. */
export type OperationResult = { ok: true; row_count?: number } | { ok: false; error: ApiError };

export interface AppContextValue {
  api: JobVaccumApi;
  catalog: Catalog;
  refreshCatalog: () => void;
  runs: RunsState;
  refreshRuns: () => void;
  /** Bumped on every run event, so an open run detail reloads. */
  runVersion: number;
  /**
   * Runs a change the UI already refreshes after, so its jobs.changed event is
   * not reported as an outside update ("Results updated").
   */
  mutate: <T>(request: () => Promise<ApiResult<T>>, emitsChange?: boolean) => Promise<ApiResult<T>>;
  /** Bumped after this window's own successful changes; both list pages reload. */
  dataVersion: number;
  /** Bumped when jobs change outside this window's own requests (cleanup, other writers). */
  outsideChanges: number;
  waitForOperation: (operationId: string) => Promise<OperationResult>;
  navigate: (page: Page, section?: SettingsSection) => void;
  /** Shows Jobs with only this filter, e.g. the jobs first found by one run. */
  openJobs: (filter: ListFilter) => void;
  /** Shows one run in Runs. */
  openRun: (runId: string) => void;
  narrow: boolean;
}

export const AppContext = createContext<AppContextValue | null>(null);
export const useApp = () => useContext(AppContext)!;
