"""One parameterized predicate/sort builder for lists and all-page exports."""
from datetime import date
import math

from job_vaccum.service.protocol import CommandError

STATUSES = ('new', 'applied', 'oa', 'interviewing', 'offer', 'rejected', 'ghosted')
SCORE_STATES = ('unscored', 'pending', 'running', 'succeeded', 'failed')


def fields(params, allowed, required=()):
    if not isinstance(params, dict) or set(params) - set(allowed) or set(required) - set(params):
        raise CommandError('Missing or unexpected fields.')


def string(value, name, *, empty=False):
    if not isinstance(value, str) or (not empty and not value.strip()):
        raise CommandError(f'{name} must be a string' + ('.' if empty else ' and cannot be empty.'))
    return value


def integer(value, name, minimum=0, maximum=2**63-1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise CommandError(f'{name} must be an integer in the allowed range.')
    return value


def choice(value, name, choices):
    if not isinstance(value, str) or value not in choices:
        raise CommandError(f'Invalid {name}.')
    return value


def boolean(value, name):
    if type(value) is not bool:
        raise CommandError(f'{name} must be a boolean.')
    return value


def strings(value, name, limit=None):
    if not isinstance(value, list):
        raise CommandError(f'{name} must be an array.')
    result = list(dict.fromkeys(string(v, name) for v in value))
    if limit is not None and not 1 <= len(result) <= limit:
        raise CommandError(f'{name} requires 1 to {limit} distinct values.')
    return result


FILTER_FIELDS = {'scope', 'text', 'direction_ids', 'sources', 'companies', 'locations', 'job_types',
                 'run_ids', 'score_min', 'score_max', 'score_states', 'in_applications',
                 'application_statuses', 'first_seen_from', 'first_seen_to', 'date_posted_from',
                 'date_posted_to', 'date_posted_unknown', 'added_from', 'added_to', 'updated_from',
                 'updated_to', 'salary_presence', 'salary_min', 'salary_max', 'salary_currency',
                 'salary_interval', 'sort'}
APPLICATION_FIELDS = {'application_statuses', 'added_from', 'added_to', 'updated_from', 'updated_to'}


def build_filter(params, *, paged=False):
    fields(params, FILTER_FIELDS | ({'page', 'page_size'} if paged else set()))
    scope = choice(params.get('scope', 'discover'), 'scope', ('discover', 'applications'))
    if scope == 'discover' and APPLICATION_FIELDS & params.keys():
        raise CommandError('Application filters require applications scope.')
    if scope == 'applications' and 'in_applications' in params:
        raise CommandError('in_applications requires discover scope.')
    clauses, values = (["j.origin='scraped'"] if scope == 'discover' else []), []
    if scope == 'applications':
        clauses.append('a.job_id IS NOT NULL')
    if 'text' in params:
        text = string(params['text'], 'text', empty=True)
        escaped = text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        clauses.append("(j.title LIKE ? ESCAPE '\\' OR j.company LIKE ? ESCAPE '\\' OR j.location LIKE ? ESCAPE '\\')")
        values.extend([f'%{escaped}%'] * 3)
    for key, column in [('companies', 'j.company'), ('locations', 'j.location'),
                        ('job_types', 'j.job_type'), ('score_states', 'j.score_state'),
                        ('application_statuses', 'a.status'), ('direction_ids', None), ('sources', None),
                        ('run_ids', None)]:
        if key not in params:
            continue
        items = strings(params[key], key)
        if key in ('score_states', 'application_statuses'):
            for item in items:
                choice(item, key, SCORE_STATES if key == 'score_states' else STATUSES)
        if not items:
            continue
        slots = ','.join('?' for _ in items)
        if key == 'direction_ids':
            clauses.append(f'EXISTS (SELECT 1 FROM job_directions d WHERE d.job_id=j.id AND d.direction_id IN ({slots}))')
        elif key == 'sources':
            clauses.append(f"EXISTS (SELECT 1 FROM json_each(j.sources_json) s WHERE json_extract(s.value,'$.site') IN ({slots}))")
        elif key == 'run_ids':
            clauses.append(f"EXISTS (SELECT 1 FROM run_jobs r JOIN runs run ON run.id=r.run_id WHERE r.job_id=j.id AND r.is_new=1 AND run.kind='pipeline' AND r.run_id IN ({slots}))")
        else:
            clauses.append(f'{column} IN ({slots})')
        values.extend(items)
    for prefix, column in [('first_seen', 'j.first_seen_at'), ('added', 'a.added_at'),
                           ('updated', 'a.updated_at'), ('date_posted', 'j.date_posted')]:
        bounds = []
        for suffix, operator in [('from', '>='), ('to', '<')]:
            key = f'{prefix}_{suffix}'
            if key not in params:
                bounds.append(None)
                continue
            value = params[key]
            if prefix == 'date_posted':
                try:
                    string(value, key)
                    if date.fromisoformat(value).isoformat() != value:
                        raise ValueError
                except ValueError as exc:
                    raise CommandError('Publication date bounds must be YYYY-MM-DD.') from exc
            else:
                integer(value, key)
            bounds.append(value)
            clauses.append(f'{column} {operator} ?')
            values.append(value)
        if all(v is not None for v in bounds) and bounds[0] >= bounds[1]:
            raise CommandError('Date ranges must have from < to.')
    if 'date_posted_unknown' in params:
        unknown = boolean(params['date_posted_unknown'], 'date_posted_unknown')
        if unknown and {'date_posted_from', 'date_posted_to'} & params.keys():
            raise CommandError('Unknown publication date cannot be combined with a publication range.')
        clauses.append('j.date_posted IS ' + ('' if unknown else 'NOT ') + 'NULL')
    if 'in_applications' in params:
        present = boolean(params['in_applications'], 'in_applications')
        clauses.append('a.job_id IS ' + ('NOT ' if present else '') + 'NULL')
    for key, operator in [('score_min', '>='), ('score_max', '<=')]:
        if key in params:
            integer(params[key], key, 0, 10)
            clauses.append(f'j.score {operator} ?')
            values.append(params[key])
    if params.get('score_min', 0) > params.get('score_max', 10):
        raise CommandError('score_min cannot exceed score_max.')
    if 'salary_presence' in params:
        known = choice(params['salary_presence'], 'salary_presence', ('known', 'unknown')) == 'known'
        clauses.append('(j.salary_min IS NOT NULL OR j.salary_max IS NOT NULL)' if known
                       else '(j.salary_min IS NULL AND j.salary_max IS NULL)')
    if {'salary_min', 'salary_max'} & params.keys() and not {'salary_currency', 'salary_interval'} <= params.keys():
        raise CommandError('Salary ranges require currency and interval.')
    for key in ('salary_currency', 'salary_interval'):
        if key in params:
            clauses.append(f'j.{key} = ?')
            values.append(string(params[key], key))
    for key, column, operator in [('salary_min', 'salary_max', '>='), ('salary_max', 'salary_min', '<=')]:
        if key in params:
            value = params[key]
            if type(value) not in (int, float) or value < 0 or value > 1.7976931348623157e308 or not math.isfinite(value):
                raise CommandError('Salary bounds must be finite nonnegative numbers.')
            clauses.append(f'(j.{column} IS NULL OR j.{column} {operator} ?)')
            values.append(float(value))
    if {'salary_min', 'salary_max'} & params.keys():
        clauses.append('(j.salary_min IS NOT NULL OR j.salary_max IS NOT NULL)')
    if params.get('salary_min', 0) > params.get('salary_max', math.inf):
        raise CommandError('salary_min cannot exceed salary_max.')
    sort = string(params.get('sort', 'added_desc' if scope == 'applications' else 'first_seen_desc'), 'sort')
    columns = {key: f'j.{value}' for key, value in dict(first_seen='first_seen_at', date_posted='date_posted',
               score='score', company='company', title='title', location='location', job_type='job_type').items()}
    if scope == 'applications':
        columns.update(added='a.added_at', updated='a.updated_at',
                       status='CASE a.status ' + ' '.join(f"WHEN '{v}' THEN {i}" for i, v in enumerate(STATUSES)) + ' END')
    valid_sorts = {f'{key}_{order}': (column, order.upper()) for key, column in columns.items() for order in ('asc', 'desc')}
    if sort not in valid_sorts:
        raise CommandError('Invalid sort for this scope.')
    column, order = valid_sorts[sort]
    page = integer(params.get('page', 1), 'page', 1, 2**31-1)
    page_size = integer(params.get('page_size', 50), 'page_size', 1, 200)
    return ' AND '.join(clauses) or '1', values, f'({column}) IS NULL ASC, {column} {order}, j.id ASC', page, page_size


def validate_run_ids(db, params):
    ids = strings(params.get('run_ids', []), 'run_ids')
    if ids:
        slots = ','.join('?' for _ in ids)
        if db.execute(f"SELECT 1 FROM runs WHERE id IN ({slots}) AND kind!='pipeline'", ids).fetchone():
            raise CommandError('Batch filters accept pipeline run IDs only.')
