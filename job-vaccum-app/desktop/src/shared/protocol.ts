import type { ApiResult, ReadyInfo } from "./api";

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 1024 * 1024;
export const businessMethods = {
  'schedules:list': 'schedules.list', 'schedules:save': 'schedules.save', 'schedules:delete': 'schedules.delete',
  'firings:cancel': 'firings.cancel', 'firings:delete': 'firings.delete',
  'jobs:list': 'jobs.list', 'jobs:detail': 'jobs.detail',
  'jobs:score': 'jobs.score', 'model:test': 'model.test', 'operations:cancel': 'operations.cancel',
  'settings:get': 'settings.get', 'settings:save': 'settings.save',
  'directions:save': 'directions.save', 'directions:delete': 'directions.delete', 'directions:reorder': 'directions.reorder',
  'drafts:get': 'drafts.get', 'drafts:save': 'drafts.save', 'drafts:apply': 'drafts.apply',
  'drafts:generate': 'drafts.generate',
  'runs:preview': 'runs.preview', 'runs:start': 'runs.start', 'runs:list': 'runs.list',
  'runs:detail': 'runs.detail', 'runs:stop': 'runs.stop', 'runs:resume': 'runs.resume',
  'queries:save': 'queries.save', 'queries:delete': 'queries.delete',
  'applications:add': 'applications.add', 'applications:add-many': 'applications.add_many',
  'applications:update': 'applications.update', 'applications:set-status': 'applications.set_status',
  'applications:remove': 'applications.remove', 'applications:restore': 'applications.restore',
  'cleanup:preview': 'cleanup.preview', 'cleanup:execute': 'cleanup.execute',
  'dev:import-synthetic': 'dev.import_synthetic',
} as const;
export type M8Method = 'jobs.query' | 'applications.create_job' | 'applications.update_job' | 'directions.list'
  | 'schedules.get' | 'schedules.update' | 'schedules.preview' | 'runs.summaries' | 'runs.summary';
export type Method = M8Method | "app.status" | "app.ping" | "app.diagnostics" | "export.csv" | "internal.credentials" | "internal.schedules_check" | "schedules.trigger" | "schedules.record_missed" | typeof businessMethods[keyof typeof businessMethods];
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
  appInfo: "app:info",
  quit: "app:quit",
  showDataFolder: "app:show-data-folder",
  openLink: "app:open-link",
} as const;
