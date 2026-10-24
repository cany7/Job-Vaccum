import type { ApiResult } from './api';
export interface ScheduleInput {
  id?: string; enabled: boolean; direction_ids: string[] | null; time: string;
  /** Monday=0, Sunday=6; empty runs once. */
  weekdays: number[]; timezone: string;
}
export interface Schedule extends ScheduleInput {
  id: string; created_at: number; updated_at: number; checked_at: number; next_at: number | null;
}
export interface Firing {
  id: string; schedule_id: string; scheduled_at: number;
  outcome: 'started' | 'waiting' | 'not_run' | 'cancelled';
  reason: 'asleep' | 'app_closed' | 'waited_too_long' | null;
  missed_count: number; missed_since: number | null; run_id: string | null;
}
export interface SchedulesApi {
  listSchedules(): Promise<ApiResult<{ items: Schedule[]; firings: Firing[] }>>;
  saveSchedule(params: ScheduleInput): Promise<ApiResult<{ id: string }>>;
  deleteSchedule(params: { id: string }): Promise<ApiResult<{ deleted: boolean }>>;
  cancelFiring(params: { firing_id: string }): Promise<ApiResult<{ cancelled: boolean }>>;
  deleteFiring(params: { firing_id: string }): Promise<ApiResult<{ deleted: boolean }>>;
}
