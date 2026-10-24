import type { AppStatus } from './api';
import type { Application, ApplicationRecord, FilterSpec, JobSummary, Sort } from './business';
import type { RunSummary, RunStats, RunStatus } from './runs';
import type { Schedule } from './schedules';

export interface Page { total: number; page: number; page_size: number; has_more: boolean }
export type McpJobQuery = Omit<FilterSpec, 'scope'> & { sort?: Sort; page?: number; page_size?: number; view?: 'summary' | 'ids' };
export type McpJobSummary = Pick<JobSummary, 'id' | 'title' | 'company' | 'location' | 'job_type' | 'score' | 'score_reason'
  | 'score_state' | 'scored_at' | 'first_seen_at' | 'date_posted' | 'in_applications'>;
export type McpJobPage = Page & ({ items: (McpJobSummary & Partial<Application>)[] } | { ids: string[] });
export interface ManualJobContent { title: string; company?: string | null; location?: string | null; job_type?: string | null;
  description?: string | null; job_url?: string | null; job_url_direct?: string | null; date_posted?: string | null }
export type CreateShortlistJob = ManualJobContent & Partial<Pick<Application, 'status' | 'notes'>>;
export type UpdateShortlistJob = Partial<CreateShortlistJob> & { job_id: string };
export type ShortlistWriteResult = ApplicationRecord;
export interface SetStatusResult { items: { job_id: string; outcome: 'updated' | 'not_found' }[]; counts: { updated: number; not_found: number } }
export type SchedulePatch = { schedule_id: string } & Partial<Pick<Schedule, 'enabled' | 'direction_ids' | 'time' | 'weekdays' | 'timezone'>>;
export interface McpRunQuery { page?: number; page_size?: number; kind?: 'pipeline' | 'rescore'; statuses?: RunStatus[];
  created_from?: number; created_to?: number; schedule_id?: string }
export type McpRunSummary = Pick<RunSummary, 'id' | 'kind' | 'status' | 'stage' | 'created_at' | 'started_at' | 'finished_at' | 'trigger'>
  & { stats: Omit<RunStats, 'directions' | 'filter_reasons'> };
export interface McpAppStatus { available: boolean; busy: boolean; active_run: AppStatus['active_run']; operations: AppStatus['operations'] }
