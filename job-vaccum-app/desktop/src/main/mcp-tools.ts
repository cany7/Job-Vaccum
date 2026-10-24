import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Method } from '../shared/protocol';
import type { AppStatus } from '../shared/api';
import type { SetStatusResult, McpAppStatus } from '../shared/mcp';
import type { BusinessCall } from './business-call';

const id = z.string().trim().min(1);
const strings = z.array(id);
const status = z.enum(['new', 'applied', 'oa', 'interviewing', 'offer', 'rejected', 'ghosted']);
const timestamp = z.number().int().nonnegative();
const optionalText = z.string().nullable().optional();
const content = {
  title: id.optional(), company: optionalText, location: optionalText, job_type: optionalText,
  description: optionalText, job_url: optionalText, job_url_direct: optionalText, date_posted: optionalText,
};
const filters = {
  text: z.string().optional(), direction_ids: strings.optional(), sources: strings.optional(),
  companies: strings.optional(), locations: strings.optional(), job_types: strings.optional(), run_ids: strings.optional(),
  score_min: z.number().int().min(0).max(10).optional(), score_max: z.number().int().min(0).max(10).optional(),
  score_states: z.array(z.enum(['unscored', 'pending', 'running', 'succeeded', 'failed'])).optional(),
  first_seen_from: timestamp.optional(), first_seen_to: timestamp.optional(),
  date_posted_from: z.string().optional(), date_posted_to: z.string().optional(), date_posted_unknown: z.boolean().optional(),
  salary_presence: z.enum(['known', 'unknown']).optional(), salary_min: z.number().nonnegative().optional(),
  salary_max: z.number().nonnegative().optional(), salary_currency: id.optional(), salary_interval: id.optional(),
  sort: id.optional(), page: z.number().int().min(1).max(2147483647).optional(),
  page_size: z.number().int().min(1).max(200).optional(), view: z.enum(['summary', 'ids']).optional(),
};
// Backend enforces the distinct-ID cap, so duplicate IDs do not consume it.
const batch = z.array(id).min(1).refine(v => new Set(v).size <= 200, 'At most 200 distinct IDs.');

export function createMcpServer(call: BusinessCall) {
  const server = new McpServer({ name: 'job-vaccum', version: '0.1.0' });
  const tool = (name: string, description: string, shape: z.ZodRawShape, method: Method,
    readOnly: boolean, map: (p: Record<string, unknown>) => Record<string, unknown> = p => p) => {
    server.registerTool(name, { description, inputSchema: z.strictObject(shape),
      annotations: { readOnlyHint: readOnly, destructiveHint: ['update_shortlist_job', 'set_shortlist_status', 'update_schedule'].includes(name), idempotentHint: readOnly, openWorldHint: false } },
    async params => {
      const response = await call(method, map(params));
      let payload: unknown = response.ok ? response.result : { error: response.error };
      if (response.ok && name === 'set_shortlist_status') {
        const result = response.result as SetStatusResult;
        payload = { counts: result.counts, items: result.items.map(({ job_id, outcome }) => ({ job_id, outcome })) };
      }
      if (response.ok && name === 'get_app_status') {
        const state = response.result as AppStatus;
        payload = { available: true, busy: !!state.active_run || state.operations.length > 0 || state.cleanup.status !== 'idle',
          active_run: state.active_run, operations: state.operations } satisfies McpAppStatus;
      }
      // One payload only; structuredContent would duplicate the entire result.
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], ...(!response.ok ? { isError: true } : {}) };
    });
  };
  tool('list_jobs', 'Filter retained Discover jobs. Summary defaults/max 50; view=ids defaults/max 200; collect all pages of IDs before writing.',
    { ...filters, in_applications: z.boolean().optional() }, 'jobs.query', true, p => ({ ...p, scope: 'discover' }));
  tool('list_shortlist', 'Filter Shortlist including manual jobs. Summary defaults/max 50 with full notes/reasons; IDs defaults/max 200; JD requires get_job.',
    { ...filters, application_statuses: z.array(status).optional(), added_from: timestamp.optional(), added_to: timestamp.optional(),
      updated_from: timestamp.optional(), updated_to: timestamp.optional() }, 'jobs.query', true, p => ({ ...p, scope: 'applications' }));
  tool('get_job', 'Read one full job, including JD, sources, links, scoring and Shortlist management fields.', { job_id: id }, 'jobs.detail', true);
  tool('add_to_shortlist', 'Add 1–200 distinct job IDs. Existing status, notes and added time are preserved; missing IDs have individual outcomes.',
    { job_ids: batch }, 'applications.add_many', false);
  tool('create_shortlist_job', 'Create a manual job and its Shortlist entry atomically; only title is required. Existing matching identities are rejected.',
    { ...content, title: id, status: status.optional(), notes: z.string().optional() }, 'applications.create_job', false);
  tool('update_shortlist_job', 'Partially update status/notes; only manual jobs allow content edits. Omitted fields stay unchanged; null clears optional content.',
    { ...content, job_id: id, status: status.optional(), notes: z.string().optional() }, 'applications.update_job', false);
  tool('set_shortlist_status', 'Set status for 1–200 distinct Shortlist job IDs, preserving notes. Missing entries have individual outcomes.',
    { job_ids: batch, status }, 'applications.set_status', false);
  tool('list_searches', 'Read configured Searches and their queries, stable IDs and enabled flags.', {}, 'directions.list', true);
  tool('list_schedules', 'Read existing schedules, next times and brief firing state; waiting/not_run entries are not Runs.', {}, 'schedules.list', true);
  tool('get_schedule', 'Read one existing schedule with next time and brief firing state.', { schedule_id: id }, 'schedules.get', true);
  tool('update_schedule', 'Partially update an existing schedule; affects future execution only. Weekdays use Monday=0, empty means once; direction_ids=null means all.',
    { schedule_id: id, enabled: z.boolean().optional(), direction_ids: strings.nullable().optional(), time: id.optional(),
      weekdays: z.array(z.number().int().min(0).max(6)).optional(), timezone: id.optional() }, 'schedules.update', false);
  tool('preview_run', 'Preview current execution parameters and task count without starting a Run. Use schedule_id or direction_ids, never both.',
    { schedule_id: id.optional(), direction_ids: strings.nullable().optional() }, 'schedules.preview', true);
  tool('list_runs', 'Page through retained pipeline and rescore summaries, newest first; defaults/max 50, with counts and progress but no diagnostics.',
    { page: filters.page, page_size: z.number().int().min(1).max(50).optional(), kind: z.enum(['pipeline', 'rescore']).optional(),
      statuses: z.array(z.enum(['running', 'stopping', 'succeeded', 'partial', 'failed', 'stopped', 'interrupted'])).optional(),
      created_from: timestamp.optional(), created_to: timestamp.optional(), schedule_id: id.optional() }, 'runs.summaries', true);
  tool('get_run', 'Read a retained Run status and task/business counts without tasks, jobs, snapshots or diagnostics.', { run_id: id }, 'runs.summary', true);
  tool('get_app_status', 'Read service availability, busy state and active Run/operation summaries; never returns credentials or input text.', {}, 'app.status', true);
  return server;
}
