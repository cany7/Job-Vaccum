import { createContext, useContext } from "react";
import type { ApiError, ApiResult, Direction, JobVaccumApi } from "./api";
import type { ListPage } from "./listModel";

export type Page = ListPage | "settings";
export type SettingsSection = "searches" | "data" | "appearance" | "about";

/** Searches and sidebar counts, reloaded whenever job data changes. */
export interface Catalog {
  directions: Direction[];
  retentionDays: number | null;
  jobs: number | null;
  shortlist: number | null;
  byDirection: Record<string, number>;
  error?: ApiError;
}

export type OperationResult = { ok: true; row_count: number } | { ok: false; error: ApiError };

export interface AppContextValue {
  api: JobVaccumApi;
  catalog: Catalog;
  refreshCatalog: () => void;
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
  narrow: boolean;
}

export const AppContext = createContext<AppContextValue | null>(null);
export const useApp = () => useContext(AppContext)!;
