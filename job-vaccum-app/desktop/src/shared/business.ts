import type { ApiError, ApiResult } from './api';
import type { PipelineSettings, SettingsPatch, RunStats, ActiveRun, RunsApi } from './runs';
export type * from './runs';

export type ApplicationStatus = 'new' | 'applied' | 'oa' | 'interviewing' | 'offer' | 'rejected' | 'ghosted';
export type ScoreState = 'unscored' | 'pending' | 'running' | 'succeeded' | 'failed';
export type Scope = 'discover' | 'applications';
type JobSort = 'first_seen' | 'date_posted' | 'score' | 'company' | 'title' | 'location' | 'job_type';
export type Sort = `${JobSort | 'status' | 'added' | 'updated'}_${'asc' | 'desc'}`;
export interface FilterSpec {
  scope?: Scope; text?: string; direction_ids?: string[]; sources?: string[];
  companies?: string[]; locations?: string[]; job_types?: string[]; run_ids?: string[];
  score_min?: number; score_max?: number; score_states?: ScoreState[];
  in_applications?: boolean; application_statuses?: ApplicationStatus[];
  first_seen_from?: number; first_seen_to?: number;
  date_posted_from?: string; date_posted_to?: string; date_posted_unknown?: boolean;
  added_from?: number; added_to?: number; updated_from?: number; updated_to?: number;
  salary_presence?: 'known' | 'unknown'; salary_min?: number; salary_max?: number;
  salary_currency?: string; salary_interval?: string;
}
export interface Query { id: string; direction_id: string; expression: string; enabled: boolean }
export interface Direction { id: string; name: string; enabled: boolean; sort_order: number; queries: Query[] }
export interface Settings extends PipelineSettings { directions: Direction[]; has_key: boolean; has_proxy_credentials: boolean }
export interface Application { status: ApplicationStatus; notes: string; added_at: number; updated_at: number }
export interface ApplicationRecord extends Application { job_id: string }
export interface RestoreItem { job_id: string; status: ApplicationStatus; updated_at: number; notes?: string; added_at?: number }
export interface Source { site: string; id: string | null; url: string | null; direct_url: string | null }
export interface JobSummary {
  id: string; company: string | null; title: string; location: string | null; job_type: string | null;
  score: number | null; score_reason: string | null; score_state: ScoreState;
  scored_at: number | null; first_seen_at: number; date_posted: string | null;
  salary: { min: number | null; max: number | null; currency: string | null; interval: string | null };
  sources: Source[]; directions: { id: string; name: string }[];
  in_applications: boolean; application: Application | null;
}
export interface JobDetail extends JobSummary {
  description: string; links: { job_url: string | null; job_url_direct: string | null };
  queries: { query_id: string; direction_id: string; text: string }[];
  score_model: string | null; last_score_error: string | null;
}
export interface AddItem { job_id: string; outcome: 'added' | 'already_present' | 'not_found' }
export interface AddManyResult { items: AddItem[]; counts: Record<AddItem['outcome'], number> }
export type StatusItem = ({ job_id: string; outcome: 'updated' } & Omit<RestoreItem, 'notes' | 'added_at'>)
  | { job_id: string; outcome: 'not_found' };
export interface CleanupResult { deleted_jobs: number; deleted_runs: number; deleted_files: number; failed_files: string[] }
export interface ExportCsvParams {
  scope: Scope; filter?: FilterSpec & { sort?: Sort }; range: 'filtered' | 'all';
  include_jd: boolean; destination_token: string;
}
export type ServiceEvent =
  | { type: 'event'; name: 'run.updated'; seq: number; data: ActiveRun }
  | { type: 'event'; name: 'run.stats'; seq: number; data: { run_id: string } & Omit<RunStats, 'directions'> }
  | { type: 'event'; name: 'jobs.changed'; seq: number; data: Record<string, never> }
  | { type: 'event'; name: 'cleanup.completed'; seq: number; data: CleanupResult }
  | { type: 'event'; name: 'operation.completed'; seq: number; data: { operation_id: string; row_count: number } }
  | { type: 'event'; name: 'operation.failed'; seq: number; data: { operation_id: string; error: ApiError } };
export interface BusinessApi extends RunsApi {
  listJobs(params: FilterSpec & { sort?: Sort; page?: number; page_size?: number }): Promise<ApiResult<{ items: JobSummary[]; total: number }>>;
  getJobDetail(params: { job_id: string }): Promise<ApiResult<JobDetail>>;
  getSettings(): Promise<ApiResult<Settings>>;
  saveSettings(params: SettingsPatch): Promise<ApiResult<Settings>>;
  saveDirection(params: { id?: string; name?: string; enabled?: boolean }): Promise<ApiResult<Direction>>;
  deleteDirection(params: { id: string }): Promise<ApiResult<{ deleted: boolean }>>;
  reorderDirections(params: { ids: string[] }): Promise<ApiResult<{ directions: Direction[] }>>;
  saveQuery(params: { id?: string; direction_id?: string; expression?: string; enabled?: boolean }): Promise<ApiResult<Query>>;
  deleteQuery(params: { id: string }): Promise<ApiResult<{ deleted: boolean }>>;
  addApplication(params: { job_id: string }): Promise<ApiResult<AddItem>>;
  addApplications(params: { job_ids: string[] }): Promise<ApiResult<AddManyResult>>;
  updateApplication(params: { job_id: string; status?: ApplicationStatus; notes?: string }): Promise<ApiResult<ApplicationRecord>>;
  setApplicationStatus(params: { job_ids: string[]; status: ApplicationStatus }): Promise<ApiResult<{ items: StatusItem[]; counts: { updated: number; not_found: number } }>>;
  removeApplications(params: { job_ids: string[] }): Promise<ApiResult<{ items: ApplicationRecord[]; removed_count: number; not_found: string[] }>>;
  restoreApplications(params: { items: RestoreItem[] }): Promise<ApiResult<{ items: { job_id: string; outcome: 'restored' | 'not_found' }[]; counts: { restored: number; not_found: number } }>>;
  previewCleanup(params: { mode: 'manual' | 'automatic' }): Promise<ApiResult<{ jobs: number; runs: number; applications: number; files: number; disabled: boolean }>>;
  executeCleanup(params: { mode: 'manual' }): Promise<ApiResult<CleanupResult>>;
  importSyntheticJobs(params: { count?: number }): Promise<ApiResult<{ added_count: number; existing_count: number }>>;
  chooseCsvDestination(): Promise<ApiResult<{ destination_token: string } | null>>;
  exportCsv(params: ExportCsvParams): Promise<ApiResult<{ operation_id: string }>>;
  showCsvInFinder(params: { destination_token: string }): Promise<ApiResult<{ shown: boolean }>>;
  onServiceEvent(listener: (event: ServiceEvent) => void): () => void;
}
