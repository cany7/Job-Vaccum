import type { ApiResult, ReadyInfo } from "./api";

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 1024 * 1024;
export const businessMethods = {
  'jobs:list': 'jobs.list', 'jobs:detail': 'jobs.detail',
  'settings:get': 'settings.get', 'settings:save': 'settings.save',
  'directions:save': 'directions.save', 'directions:delete': 'directions.delete', 'directions:reorder': 'directions.reorder',
  'queries:save': 'queries.save', 'queries:delete': 'queries.delete',
  'applications:add': 'applications.add', 'applications:add-many': 'applications.add_many',
  'applications:update': 'applications.update', 'applications:set-status': 'applications.set_status',
  'applications:remove': 'applications.remove', 'applications:restore': 'applications.restore',
  'cleanup:preview': 'cleanup.preview', 'cleanup:execute': 'cleanup.execute',
  'dev:import-synthetic': 'dev.import_synthetic',
} as const;
export type Method = "app.status" | "app.ping" | "app.diagnostics" | "export.csv" | typeof businessMethods[keyof typeof businessMethods];
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
export type ServiceMessage = Response | ReadyEvent | import("./business").ServiceEvent;

export const channels = {
  connection: "app:connection",
  connectionChanged: "app:connection-changed",
  status: "app:status",
  ping: "app:ping",
  diagnostics: "app:diagnostics",
} as const;
