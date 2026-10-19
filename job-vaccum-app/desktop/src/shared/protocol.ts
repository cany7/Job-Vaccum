import type { ApiResult, ReadyInfo } from "./api";

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 1024 * 1024;
export type Method = "app.status" | "app.ping" | "app.diagnostics";
export interface Request {
  type: "request";
  id: string;
  method: Method;
  params: Record<string, unknown>;
}
export type Response = { type: "response"; id: string | null } & ApiResult<unknown>;
export interface ReadyEvent {
  type: "event";
  name: "ready";
  seq: number;
  data: ReadyInfo;
}
export type ServiceMessage = Response | ReadyEvent;

export const channels = {
  connection: "app:connection",
  connectionChanged: "app:connection-changed",
  status: "app:status",
  ping: "app:ping",
  diagnostics: "app:diagnostics",
  appInfo: "app:info",
  quit: "app:quit",
  showDataFolder: "app:show-data-folder",
} as const;
