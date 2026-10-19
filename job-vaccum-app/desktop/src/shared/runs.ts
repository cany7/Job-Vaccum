import type { ApiError, ApiResult } from './api';
import type { Direction } from './business';

export type Platform = 'linkedin' | 'indeed';
export interface City { id: string; location: string; distance_miles: number; enabled: boolean }
export type CityInput = Omit<City, 'id'> & { id?: string };
export type RuleId = 'test_jobs' | 'senior_title' | 'experience' | 'authorization' | 'language' | 'graduation' | 'degree';
export interface Rules {
  enabled_rule_ids: RuleId[]; experience_max_years: number; excluded_companies: string[];
  qualifications: { requires_sponsorship?: boolean; work_authorization?: 'opt' | 'unrestricted';
    languages?: string[]; graduation_date?: string; degrees?: string[] };
}
export interface ModelConfig {
  protocol: 'chat_completions' | 'responses' | 'anthropic_messages' | 'gemini_generate_content';
  base_url: string; model_id: string; temperature?: number | null; max_output_tokens?: number | null;
  reasoning_effort?: string | null; thinking?: Record<string, unknown> | null; anthropic_version?: string | null;
}
export interface PipelineSettings {
  retention_days: number; auto_score_enabled: boolean; rubric: string; model: ModelConfig | null;
  cities: City[]; country_indeed: string; platforms: Platform[]; rules: Rules;
  proxy: { mode: 'off' | 'ordinary'; url: string | null };
}
export type SettingsPatch = Partial<Omit<PipelineSettings, 'cities'>> & { cities?: CityInput[] };
export type DraftKind = 'search' | 'rubric';
export interface SearchDraft { directions: { name: string; queries: { expression: string; enabled: boolean }[] }[];
  cities: Omit<City, 'id'>[] }
export type Draft = { draft_kind: 'search'; content: SearchDraft | null } | { draft_kind: 'rubric'; content: string | null };
export type SaveDraft = { draft_kind: 'search'; content: SearchDraft } | { draft_kind: 'rubric'; content: string };
export interface RunParameters {
  results_wanted: Record<Platform, number>; hours_old: number; retrieval_concurrency: number;
  timeout_seconds: number; max_attempts: number; retry_base_seconds: number; llm_concurrency: number; llm_rpm: number;
}
export interface RunSnapshot extends PipelineSettings { directions: Direction[]; parameters: RunParameters; jobspy_commit: string }
export type RunStatus = 'running' | 'stopping' | 'succeeded' | 'partial' | 'failed' | 'stopped' | 'interrupted';
export type RunStage = 'retrieving' | 'scoring' | 'cleaning' | null;
export interface ActiveRun { run_id: string; status: RunStatus; stage: RunStage }
export interface TaskCounts { total: number; succeeded: number; failed: number; active: number; pending: number; cancelled: number }
export interface RunStats {
  retrieval: TaskCounts; scoring: TaskCounts; received_count: number; filtered_count: number;
  matched_job_count: number; new_job_count: number;
  directions: { direction_id: string; name: string; received_count: number; filtered_count: number; matched_job_count: number }[];
}
export interface RunSummary {
  id: string; kind: 'pipeline' | 'rescore'; status: RunStatus; stage: RunStage; created_at: number;
  started_at: number; finished_at: number | null; new_job_count: number; stats: RunStats; error: ApiError | null;
}
export interface RetrievalSpec { query_id: string; direction_id: string; expression: string; city_id: string;
  location: string; distance_miles: number; site: Platform; country_indeed: string }
export interface ScoreSpec { job_id: string }
export interface TaskStats { received_count?: number; filtered_count?: number; filter_reasons?: Record<string, number>;
  matched_job_count?: number; matched_job_ids?: string[]; missing_jd_count?: number; warnings?: string[];
  http_requests?: number; http_429?: number; identity_conflicts?: number }
export type RunTask = { id: string; run_id: string; stable_order: number; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt_count: number; stats: TaskStats; error: ApiError | null } &
  ({ kind: 'retrieval'; spec: RetrievalSpec } | { kind: 'score'; spec: ScoreSpec });
export interface RunDetail extends RunSummary { config_snapshot: RunSnapshot; tasks: RunTask[]; task_total: number;
  jobs: { job_id: string; is_new: boolean }[] }
export interface RunsApi {
  getDraft(params: { draft_kind: DraftKind }): Promise<ApiResult<Draft>>;
  saveDraft(params: SaveDraft): Promise<ApiResult<Draft>>;
  applyDraft(params: { draft_kind: DraftKind }): Promise<ApiResult<Draft>>;
  previewRun(): Promise<ApiResult<{ task_count: number; parameters: RunParameters; auto_score_enabled: boolean }>>;
  startRun(): Promise<ApiResult<{ run_id: string }>>;
  listRuns(params?: { page?: number; page_size?: number; kind?: 'pipeline' | 'rescore' }): Promise<ApiResult<{ items: RunSummary[]; total: number }>>;
  getRunDetail(params: { run_id: string; task_page?: number; task_page_size?: number }): Promise<ApiResult<RunDetail>>;
  stopRun(params: { run_id: string }): Promise<ApiResult<{ run_id: string }>>;
  resumeRun(params: { run_id: string }): Promise<ApiResult<{ run_id: string }>>;
  setProxyCredential(params: { url: string }): Promise<ApiResult<{ has_proxy_credentials: boolean }>>;
  deleteProxyCredential(): Promise<ApiResult<{ has_proxy_credentials: boolean }>>;
}
