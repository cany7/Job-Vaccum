import { useCallback, useRef, useState } from "react";
import { call, type ApiError, type ApiResult } from "./api";

export interface RequestState<T> {
  loading: boolean;
  data?: T;
  ms?: number;
  error?: ApiError;
}

/** One request slot; a newer call supersedes the response of an older one. */
export function useRequest<T, A extends unknown[]>(request: (...args: A) => Promise<ApiResult<T>>) {
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
          ? { loading: false, data: response.result, ms }
          : { loading: false, data: previous.data, ms, error: response.error },
      );
    },
    [request],
  );
  return [state, run] as const;
}
