import csv
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

from job_vaccum.service.protocol import CommandError
from job_vaccum.storage.filters import FILTER_FIELDS, build_filter, choice, fields, boolean, string
from job_vaccum.storage.repository import JOIN, SELECT, Repository, row_dict


def validate_export(params, database: Path):
    fields(params, {'scope', 'filter', 'range', 'include_jd', 'destination_path'},
           {'scope', 'range', 'include_jd', 'destination_path'})
    scope = choice(params['scope'], 'scope', ('discover', 'applications'))
    mode = choice(params['range'], 'range', ('filtered', 'all'))
    boolean(params['include_jd'], 'include_jd')
    destination = Path(string(params['destination_path'], 'destination_path'))
    if not destination.is_absolute():
        raise CommandError('Export destination must be an absolute trusted path.')
    destination = destination.resolve()
    if destination.is_relative_to(database.parent.resolve()):
        raise CommandError('Choose an export destination outside the application data directory.')
    filters = params.get('filter', {})
    fields(filters, FILTER_FIELDS)
    if filters.get('scope', scope) != scope:
        raise CommandError('Export scope and filter scope must match.')
    filters = {**filters, 'scope': scope}
    build_filter(filters)
    return ({'scope': scope} if mode == 'all' else filters), destination


def iso_time(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec='milliseconds') if value is not None else ''


def export_csv(database: Path, params):
    filters, destination = validate_export(params, database)
    where, values, order, _, _ = build_filter(filters)
    # A dedicated read-only WAL snapshot leaves the service writer responsive.
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
        db.execute('BEGIN')
        repo = Repository(db)
        columns = ['id', 'company', 'title', 'location', 'job_type', 'score', 'score_reason',
                   'score_state', 'scored_at', 'salary_min', 'salary_max', 'salary_currency',
                   'salary_interval', 'directions', 'sources', 'date_posted', 'first_seen_at',
                   'job_url', 'job_url_direct']
        if filters['scope'] == 'applications':
            columns += ['status', 'notes', 'added_at', 'updated_at']
        if params['include_jd']:
            columns.append('description')
        count = 0
        with destination.open('w', encoding='utf-8-sig', newline='') as output:
            writer = csv.DictWriter(output, fieldnames=columns, extrasaction='ignore')
            writer.writeheader()
            for row in row_dict(db.execute(f'SELECT {SELECT} {JOIN} WHERE {where} ORDER BY {order}', values)):
                job = repo.job_object(row)
                row['directions'] = '; '.join(d['name'] for d in job['directions'])
                row['sources'] = '; '.join(dict.fromkeys(s['site'] for s in job['sources']))
                row['status'] = row['application_status']
                for key in ('scored_at', 'first_seen_at', 'added_at', 'updated_at'):
                    row[key] = iso_time(row[key])
                writer.writerow(row)
                count += 1
    return {'row_count': count}
