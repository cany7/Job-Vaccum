import json
import sqlite3
import time
from uuid import uuid4

from job_vaccum.service.protocol import CommandError, check_result_size
from job_vaccum.storage.filters import (STATUSES, boolean, build_filter, choice, fields,
                                       integer, string, strings, validate_run_ids)

JOIN = 'FROM jobs j LEFT JOIN applications a ON a.job_id=j.id'
SELECT = 'j.*, a.status AS application_status, a.notes, a.added_at, a.updated_at'
SUMMARY_SELECT = 'j.id,j.company,j.title,j.location,j.job_type,j.score,j.score_reason,j.score_state,j.scored_at,j.first_seen_at,j.date_posted,j.salary_min,j.salary_max,j.salary_currency,j.salary_interval,j.sources_json,a.status AS application_status,a.notes,a.added_at,a.updated_at'


def now_ms():
    return time.time_ns() // 1_000_000


def row_dict(cursor):
    names = [column[0] for column in cursor.description]
    return (dict(zip(names, row)) for row in cursor)


class Repository:
    def __init__(self, db: sqlite3.Connection, clock=now_ms):
        self.db, self.clock = db, clock

    def settings(self):
        from job_vaccum.pipeline.configuration import settings
        return settings(self)

    def save_settings(self, params):
        from job_vaccum.pipeline.configuration import save
        return save(self, params)

    def directions(self):
        result = list(row_dict(self.db.execute('SELECT * FROM directions ORDER BY sort_order,id')))
        for direction in result:
            direction['enabled'] = bool(direction['enabled'])
            direction['queries'] = list(row_dict(self.db.execute('SELECT * FROM queries WHERE direction_id=? ORDER BY id', (direction['id'],))))
            for query in direction['queries']:
                query['enabled'] = bool(query['enabled'])
        return result

    def direction_save(self, params):
        fields(params, {'id', 'name', 'enabled'})
        identifier = string(params['id'], 'id') if 'id' in params else str(uuid4())
        if 'name' in params:
            string(params['name'], 'name')
        if 'enabled' in params:
            boolean(params['enabled'], 'enabled')
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT name,enabled FROM directions WHERE id=?', (identifier,)).fetchone()
            if 'id' in params and row is None:
                raise CommandError('Direction not found.', 'NOT_FOUND')
            if row is None:
                if 'name' not in params:
                    raise CommandError('New direction requires name.')
                order = self.db.execute('SELECT coalesce(max(sort_order),-1)+1 FROM directions').fetchone()[0]
                self.db.execute('INSERT INTO directions VALUES (?,?,?,?)', (identifier, params['name'].strip(), params.get('enabled', True), order))
            else:
                self.db.execute('UPDATE directions SET name=?,enabled=? WHERE id=?',
                                (params.get('name', row[0]).strip(), params.get('enabled', row[1]), identifier))
        return next(d for d in self.directions() if d['id'] == identifier)

    def direction_delete(self, params):
        fields(params, {'id'}, {'id'})
        identifier = string(params['id'], 'id')
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            if not self.db.execute('DELETE FROM directions WHERE id=?', (identifier,)).rowcount:
                raise CommandError('Direction not found.', 'NOT_FOUND')
            self.db.execute("""UPDATE jobs SET queries_json=coalesce((SELECT json_group_array(json(value))
                FROM json_each(jobs.queries_json) WHERE json_extract(value,'$.direction_id') != ?),'[]')""", (identifier,))
        return {'deleted': True}

    def direction_reorder(self, params):
        fields(params, {'ids'}, {'ids'})
        ids = strings(params['ids'], 'ids')
        if len(ids) != len(params['ids']):
            raise CommandError('Duplicate direction IDs.')
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            existing = {r[0] for r in self.db.execute('SELECT id FROM directions')}
            if set(ids) != existing:
                raise CommandError('Reorder must include every current direction exactly once.')
            self.db.executemany('UPDATE directions SET sort_order=? WHERE id=?', enumerate(ids))
        return {'directions': self.directions()}

    def query_save(self, params):
        fields(params, {'id', 'direction_id', 'expression', 'enabled'})
        identifier = string(params['id'], 'id') if 'id' in params else str(uuid4())
        if 'expression' in params:
            string(params['expression'], 'expression')
        if 'enabled' in params:
            boolean(params['enabled'], 'enabled')
        if 'direction_id' in params:
            string(params['direction_id'], 'direction_id')
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT direction_id,expression,enabled FROM queries WHERE id=?', (identifier,)).fetchone()
            if 'id' in params and row is None:
                raise CommandError('Query not found.', 'NOT_FOUND')
            if row is None:
                fields(params, {'direction_id', 'expression', 'enabled'}, {'direction_id', 'expression'})
                if not self.db.execute('SELECT 1 FROM directions WHERE id=?', (params['direction_id'],)).fetchone():
                    raise CommandError('Direction not found.', 'NOT_FOUND')
                self.db.execute('INSERT INTO queries VALUES (?,?,?,?)', (identifier, params['direction_id'], params['expression'].strip(), params.get('enabled', True)))
            else:
                if params.get('direction_id', row[0]) != row[0]:
                    raise CommandError('Query direction cannot change.')
                self.db.execute('UPDATE queries SET expression=?,enabled=? WHERE id=?',
                                (params.get('expression', row[1]).strip(), params.get('enabled', row[2]), identifier))
        result = next(row_dict(self.db.execute('SELECT * FROM queries WHERE id=?', (identifier,))))
        result['enabled'] = bool(result['enabled'])
        return result

    def query_delete(self, params):
        fields(params, {'id'}, {'id'})
        with self.db:
            if not self.db.execute('DELETE FROM queries WHERE id=?', (string(params['id'], 'id'),)).rowcount:
                raise CommandError('Query not found.', 'NOT_FOUND')
        return {'deleted': True}

    def job_object(self, row, *, detail=False):
        result = {key: row[key] for key in ('id', 'company', 'title', 'location', 'job_type', 'score',
                  'score_reason', 'score_state', 'scored_at', 'first_seen_at', 'date_posted')}
        result['salary'] = {key: row['salary_' + key] for key in ('min', 'max', 'currency', 'interval')}
        result['sources'] = json.loads(row['sources_json'])
        result['directions'] = list(row_dict(self.db.execute('''SELECT d.id,d.name FROM directions d
            JOIN job_directions jd ON jd.direction_id=d.id WHERE jd.job_id=? ORDER BY d.sort_order,d.id''', (row['id'],))))
        result['in_applications'] = row['application_status'] is not None
        result['application'] = ({'status': row['application_status'], **{key: row[key] for key in ('notes', 'added_at', 'updated_at')}} if result['in_applications'] else None)
        if detail:
            result.update(description=row['description'], queries=json.loads(row['queries_json']),
                          links={'job_url': row['job_url'], 'job_url_direct': row['job_url_direct']},
                          score_model=row['score_model'], last_score_error=row['last_score_error'])
        return result

    def list_jobs(self, params):
        validate_run_ids(self.db, params)
        where, values, order, page, page_size = build_filter(params, paged=True)
        # Count and rows describe one snapshot even when another connection writes.
        with self.db:
            self.db.execute('BEGIN')
            total = self.db.execute(f'SELECT count(*) {JOIN} WHERE {where}', values).fetchone()[0]
            cursor = self.db.execute(f'SELECT {SUMMARY_SELECT} {JOIN} WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?', [*values, page_size, (page - 1) * page_size])
            items = [self.job_object(row) for row in row_dict(cursor)]
        return {'items': items, 'total': total}

    def detail(self, params):
        fields(params, {'job_id'}, {'job_id'})
        with self.db:
            self.db.execute('BEGIN')
            row = next(row_dict(self.db.execute(f'SELECT {SELECT} {JOIN} WHERE j.id=?', (string(params['job_id'], 'job_id'),))), None)
            if row is None:
                raise CommandError('Job not found.', 'NOT_FOUND')
            return self.job_object(row, detail=True)

    def add(self, params, many=False):
        key = 'job_ids' if many else 'job_id'
        fields(params, {key}, {key})
        ids = strings(params[key], key, 200) if many else [string(params[key], key)]
        items, counts = [], dict.fromkeys(('added', 'already_present', 'not_found'), 0)
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            now = self.clock()
            for identifier in ids:
                if not self.db.execute('SELECT 1 FROM jobs WHERE id=?', (identifier,)).fetchone():
                    outcome = 'not_found'
                else:
                    inserted = self.db.execute("INSERT INTO applications VALUES (?,'new','',?,?) ON CONFLICT(job_id) DO NOTHING", (identifier, now, now)).rowcount
                    outcome = 'added' if inserted else 'already_present'
                items.append({'job_id': identifier, 'outcome': outcome})
                counts[outcome] += 1
        return {'items': items, 'counts': counts} if many else items[0]

    def application(self, identifier):
        return next(row_dict(self.db.execute('SELECT * FROM applications WHERE job_id=?', (identifier,))), None)

    def update(self, params, *, response_id="x" * 128):
        fields(params, {'job_id', 'status', 'notes'}, {'job_id'})
        identifier = string(params['job_id'], 'job_id')
        if not {'status', 'notes'} & params.keys():
            raise CommandError('Provide status or notes.')
        if 'status' in params:
            choice(params['status'], 'status', STATUSES)
        if 'notes' in params:
            string(params['notes'], 'notes', empty=True)
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            if self.application(identifier) is None:
                raise CommandError('Application not found.', 'NOT_FOUND')
            assignments = [f'{key}=?' for key in ('status', 'notes') if key in params]
            values = [params[key] for key in ('status', 'notes') if key in params]
            self.db.execute('UPDATE applications SET ' + ','.join([*assignments, 'updated_at=?']) + ' WHERE job_id=?', [*values, self.clock(), identifier])
            result = self.application(identifier)
            check_result_size(result, response_id)
        return result

    def set_status(self, params):
        fields(params, {'job_ids', 'status'}, {'job_ids', 'status'})
        ids = strings(params['job_ids'], 'job_ids', 200)
        status = choice(params['status'], 'status', STATUSES)
        items, counts = [], dict.fromkeys(('updated', 'not_found'), 0)
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            now = self.clock()
            for identifier in ids:
                row = self.application(identifier)
                item = {'job_id': identifier, 'outcome': 'not_found'}
                if row:
                    item.update(outcome='updated', status=row['status'], updated_at=row['updated_at'])
                    self.db.execute('UPDATE applications SET status=?,updated_at=? WHERE job_id=?', (status, now, identifier))
                items.append(item)
                counts[item['outcome']] += 1
        return {'items': items, 'counts': counts}

    def remove(self, params, *, response_id="x" * 128):
        fields(params, {'job_ids'}, {'job_ids'})
        ids = strings(params['job_ids'], 'job_ids', 200)
        items, missing = [], []
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            for identifier in ids:
                row = self.application(identifier)
                if row:
                    items.append(row)
                    self.db.execute('DELETE FROM applications WHERE job_id=?', (identifier,))
                else:
                    missing.append(identifier)
            result = {'items': items, 'removed_count': len(items), 'not_found': missing}
            check_result_size(result, response_id)
        return result

    def restore(self, params):
        fields(params, {'items'}, {'items'})
        if not isinstance(params['items'], list) or not 1 <= len(params['items']) <= 200:
            raise CommandError('Restore requires 1 to 200 snapshots.')
        seen = set()
        for item in params['items']:
            fields(item, {'job_id', 'status', 'notes', 'added_at', 'updated_at'}, {'job_id', 'status', 'updated_at'})
            identifier = string(item['job_id'], 'job_id')
            if identifier in seen:
                raise CommandError('Duplicate restore ID.')
            seen.add(identifier)
            choice(item['status'], 'status', STATUSES)
            integer(item['updated_at'], 'updated_at')
            if ('notes' in item) != ('added_at' in item):
                raise CommandError('Removal snapshots require notes and added_at together.')
            if 'notes' in item:
                string(item['notes'], 'notes', empty=True)
                integer(item['added_at'], 'added_at')
        results, counts = [], dict.fromkeys(('restored', 'not_found'), 0)
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            for item in params['items']:
                identifier, outcome = item['job_id'], 'not_found'
                if self.application(identifier):
                    self.db.execute('UPDATE applications SET status=?,updated_at=? WHERE job_id=?', (item['status'], item['updated_at'], identifier))
                    outcome = 'restored'
                elif 'notes' in item and self.db.execute('SELECT 1 FROM jobs WHERE id=?', (identifier,)).fetchone():
                    self.db.execute('INSERT INTO applications VALUES (?,?,?,?,?)', (identifier, item['status'], item['notes'], item['added_at'], item['updated_at']))
                    outcome = 'restored'
                results.append({'job_id': identifier, 'outcome': outcome})
                counts[outcome] += 1
        return {'items': results, 'counts': counts}
