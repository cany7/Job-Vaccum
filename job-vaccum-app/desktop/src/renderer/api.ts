export type * from "../shared/api";
import type { ApiResult } from "../shared/api";

/** Runs a preload call; an IPC rejection is shown as an error instead of being lost. */
export async function call<T>(request: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await request();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: "IPC_ERROR", message, retryable: false } };
  }
}
