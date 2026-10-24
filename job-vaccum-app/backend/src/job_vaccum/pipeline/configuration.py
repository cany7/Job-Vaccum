"""Non-secret settings and edited drafts; all writes belong to the service loop."""
from copy import deepcopy
from datetime import date
import json
import math
from urllib.parse import urlsplit
from uuid import uuid4

from job_vaccum.pipeline.advanced import ADVANCED, MIHOMO, patch_config
from job_vaccum.service.protocol import CommandError, check_result_size
from job_vaccum.storage.filters import fields, string, strings, integer, boolean, choice

PARAMETERS = {'results_wanted': {'linkedin': 10, 'indeed': 100}, 'hours_old': 72,
              'retrieval_concurrency': 1, 'timeout_seconds': 600, 'max_attempts': 3,
              'retry_base_seconds': 5, 'llm_concurrency': 1, 'llm_rpm': 10,
              'llm_connect_timeout_seconds': 10, 'llm_read_timeout_seconds': 120}
RULE_IDS = ('test_jobs', 'senior_title', 'experience', 'authorization', 'language', 'graduation', 'degree')
# Stable IDs keep unsaved defaults consistent across reads and restarts.
DEFAULT_CITIES = [
    {'id': '61c14e8e-d32d-41aa-8e77-29441a58d5f8', 'location': 'San Francisco, CA', 'distance_miles': 25, 'enabled': True},
    {'id': '6659dcdf-00f0-4606-9cf1-d48d93017e32', 'location': 'Palo Alto, CA', 'distance_miles': 15, 'enabled': True},
    {'id': '66036c5c-ce34-4950-b9b5-e1a846c9a355', 'location': 'San Jose, CA', 'distance_miles': 15, 'enabled': True},
    {'id': 'b3f05320-b127-41c4-be9a-26cbb8050ebf', 'location': 'Los Angeles, CA', 'distance_miles': 25, 'enabled': True},
    {'id': '4add1b5c-e191-44db-8cda-d814741782f6', 'location': 'Irvine, CA', 'distance_miles': 15, 'enabled': True},
    {'id': '3d0ef5de-b0b7-4583-b4f4-771d2c8517d8', 'location': 'San Diego, CA', 'distance_miles': 25, 'enabled': True},
    {'id': '47e4d248-d6c1-4f04-acda-7edfafe89fdf', 'location': 'New York, NY', 'distance_miles': 25, 'enabled': True},
    {'id': '19a7be33-435a-4ad7-96eb-54d519980250', 'location': 'Seattle, WA', 'distance_miles': 25, 'enabled': True},
    {'id': '67d439c5-a509-4ac3-89e7-5f09ad27a306', 'location': 'Boston, MA', 'distance_miles': 10, 'enabled': True},
    {'id': 'eb29aedb-1c2d-432e-aaf8-144bb61ffd69', 'location': 'Cambridge, MA', 'distance_miles': 10, 'enabled': True},
    {'id': 'a9d47d2d-09e6-499d-ba0b-afef0f80e070', 'location': 'Chicago, IL', 'distance_miles': 25, 'enabled': True},
    {'id': 'c72503ab-f769-45f1-9fe5-4fe03fd7e075', 'location': 'Austin, TX', 'distance_miles': 25, 'enabled': True},
    {'id': '11638705-fdfc-420e-9784-8deb2c528a14', 'location': 'Dallas, TX', 'distance_miles': 25, 'enabled': True},
    {'id': 'a4050cc7-9482-4303-bb05-11fb13eb06ee', 'location': 'Atlanta, GA', 'distance_miles': 25, 'enabled': True},
    {'id': '8620521e-03a6-49e5-a083-6620e307f2d9', 'location': 'Raleigh, NC', 'distance_miles': 25, 'enabled': True},
    {'id': '625eaae8-ed85-433b-82a4-c482ec5001a3', 'location': 'Denver, CO', 'distance_miles': 25, 'enabled': True},
    {'id': 'ae467f93-9274-40f5-b3d0-1d0eed43a7db', 'location': 'Washington, DC', 'distance_miles': 25, 'enabled': True},
    {'id': '538cd6ff-eed1-42f3-ba0d-6173289a3ce7', 'location': 'Pittsburgh, PA', 'distance_miles': 25, 'enabled': True},
    {'id': 'dc106be3-24cb-4f58-b0d1-f74b34412564', 'location': 'Philadelphia, PA', 'distance_miles': 25, 'enabled': True},
]
DEFAULTS = {'retention_days': 14, 'auto_score_enabled': True, 'rubric': '', 'model': None,
            'cities': DEFAULT_CITIES, 'country_indeed': 'usa', 'platforms': ['linkedin', 'indeed'],
            'rules': {'enabled_rule_ids': [], 'experience_max_years': 3, 'excluded_companies': [], 'qualifications': {}},
            'proxy': {'mode': 'off', 'url': None},
            'run_mode': 'default', 'advanced_parameters': ADVANCED, 'mihomo': MIHOMO}


def proxy_origin(value, *, credentials=False):
    try:
        parsed = urlsplit(string(value, 'proxy URL'))
        if (parsed.scheme not in ('http', 'https', 'socks5') or not parsed.hostname or parsed.port is None
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment
                or (not credentials and (parsed.username is not None or parsed.password is not None))):
            raise ValueError
        host = f'[{parsed.hostname}]' if ':' in parsed.hostname else parsed.hostname
        return f'{parsed.scheme}://{host}:{parsed.port}'
    except (ValueError, CommandError):
        raise CommandError('Proxy must be an http, https or socks5 origin with an explicit port; keep authentication in credentials.') from None


def validate_rules(value):
    fields(value, {'enabled_rule_ids', 'experience_max_years', 'excluded_companies', 'qualifications'},
           {'enabled_rule_ids', 'experience_max_years', 'excluded_companies', 'qualifications'})
    for rule in strings(value['enabled_rule_ids'], 'enabled_rule_ids'):
        choice(rule, 'rule', RULE_IDS)
    integer(value['experience_max_years'], 'experience_max_years', 0, 100)
    strings(value['excluded_companies'], 'excluded_companies')
    validate_qualifications(value['qualifications'])


def validate_qualifications(q):
    fields(q, {'requires_sponsorship', 'work_authorization', 'languages', 'graduation_date', 'degrees'})
    if 'requires_sponsorship' in q:
        boolean(q['requires_sponsorship'], 'requires_sponsorship')
    if 'work_authorization' in q:
        choice(q['work_authorization'], 'work_authorization', ('opt', 'unrestricted'))
    for key in ('languages', 'degrees'):
        if key in q:
            strings(q[key], key)
    if 'graduation_date' in q:
        try:
            if date.fromisoformat(q['graduation_date']).isoformat() != q['graduation_date']:
                raise ValueError
        except (TypeError, ValueError):
            raise CommandError('graduation_date must be YYYY-MM-DD.') from None


def validate_model(value):
    if value is None:
        return
    fields(value, {'protocol', 'base_url', 'model_id', 'temperature', 'max_output_tokens',
                   'reasoning_effort', 'thinking', 'anthropic_version'}, {'protocol', 'base_url', 'model_id'})
    choice(value['protocol'], 'protocol', ('chat_completions', 'responses', 'anthropic_messages', 'gemini_generate_content'))
    string(value['model_id'], 'model_id')
    if value['protocol'] == 'gemini_generate_content' and value['model_id'].startswith('models/'):
        raise CommandError('Gemini model_id must omit the models/ prefix.')
    if value['protocol'] == 'anthropic_messages' and value.get('max_output_tokens') is None:
        raise CommandError('Anthropic requires max_output_tokens.')
    try:
        url = urlsplit(string(value['base_url'], 'base_url'))
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError
        url.port
    except ValueError:
        raise CommandError('base_url must be an HTTP URL without authentication, query or fragment.') from None
    for key in ('reasoning_effort', 'anthropic_version'):
        if value.get(key) is not None:
            string(value[key], key)
    if value.get('thinking') is not None and not isinstance(value['thinking'], dict):
        raise CommandError('thinking must be an object or null.')
    # Do not allow arbitrary nested credential fields in a future request body.
    if value.get('thinking') and any(k.lower() in ('key', 'api_key', 'password', 'authorization') for k in value['thinking']):
        raise CommandError('Secrets do not belong in model options.')
    if value.get('max_output_tokens') is not None:
        integer(value['max_output_tokens'], 'max_output_tokens', 1)
    if value.get('temperature') is not None:
        v = value['temperature']
        if type(v) not in (int, float) or not math.isfinite(v):
            raise CommandError('temperature must be a finite number.')


def cities(value, *, draft=False):
    if not isinstance(value, list):
        raise CommandError('cities must be an array.')
    result, seen = [], set()
    for item in value:
        fields(item, {'location', 'distance_miles', 'enabled'} | (set() if draft else {'id'}),
               {'location', 'distance_miles', 'enabled'})
        identifier = string(item['id'], 'city id') if 'id' in item else str(uuid4())
        if identifier in seen:
            raise CommandError('Duplicate city ID.')
        seen.add(identifier)
        row = {'location': string(item['location'], 'location').strip(),
               'distance_miles': integer(item['distance_miles'], 'distance_miles', 0, 1000),
               'enabled': boolean(item['enabled'], 'enabled')}
        if not draft:
            row['id'] = identifier
        result.append(row)
    return result


def settings(repo):
    result = deepcopy(DEFAULTS)
    for key, raw in repo.db.execute('SELECT key,value_json FROM settings'):
        if key in result:
            result[key] = json.loads(raw)
    result['directions'] = repo.directions()
    return result


def put(db, key, value):
    db.execute('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
               (key, json.dumps(value)))


def save(repo, params):
    fields(params, DEFAULTS)
    if not params:
        raise CommandError('Provide settings fields to save.')
    patch = deepcopy(params)
    for key, value in patch.items():
        if key == 'retention_days':
            integer(value, key, 0, 2**31-1)
        elif key == 'auto_score_enabled':
            boolean(value, key)
        elif key in ('rubric', 'country_indeed'):
            string(value, key, empty=key == 'rubric')
        elif key == 'cities':
            patch[key] = cities(value)
        elif key == 'platforms':
            patch[key] = strings(value, key)
            for platform in patch[key]:
                choice(platform, key, ('linkedin', 'indeed'))
        elif key == 'rules':
            validate_rules(value)
        elif key == 'model':
            validate_model(value)
        elif key == 'run_mode':
            choice(value, key, ('default', 'advanced'))
        elif key in ('advanced_parameters', 'mihomo'):
            patch[key] = patch_config(settings(repo)[key], value, mihomo=key == 'mihomo')
        elif key == 'proxy':
            fields(value, {'mode', 'url'}, {'mode', 'url'})
            choice(value['mode'], 'proxy mode', ('off', 'ordinary', 'mihomo'))
            if value['url'] is not None:
                patch[key]['url'] = proxy_origin(value['url'])
    merged = {**settings(repo), **patch}
    if merged['proxy']['mode'] == 'mihomo' and merged['run_mode'] != 'advanced':
        raise CommandError('Mihomo requires advanced mode.')
    if (patch.get('auto_score_enabled') is True or 'rubric' in patch and merged['auto_score_enabled']) and not merged['rubric'].strip():
        raise CommandError('Add a scoring rubric before enabling automatic scoring.')
    with repo.db:
        for key, value in patch.items():
            put(repo.db, key, value)
    return settings(repo)


def validate_draft(kind, content):
    if kind == 'rubric':
        string(content, 'content', empty=True)
        return content
    fields(content, {'directions', 'cities', 'clarification'}, {'directions', 'cities'})
    if 'clarification' in content:
        string(content['clarification'], 'clarification')
    cities(content['cities'], draft=True)
    if not isinstance(content['directions'], list):
        raise CommandError('directions must be an array.')
    for d in content['directions']:
        fields(d, {'name', 'queries'}, {'name', 'queries'})
        string(d['name'], 'name')
        if not isinstance(d['queries'], list):
            raise CommandError('queries must be an array.')
        for q in d['queries']:
            fields(q, {'expression', 'enabled'}, {'expression', 'enabled'})
            string(q['expression'], 'expression')
            boolean(q['enabled'], 'enabled')
    return content


def validate_draft_input(kind, value):
    fields(value, {'text', 'conditions'} | ({'clarification_answer'} if kind == 'search' else set()), {'text'})
    string(value['text'], 'text', empty=True)
    if 'conditions' in value:
        validate_qualifications(value['conditions'])
    if 'clarification_answer' in value:
        string(value['clarification_answer'], 'clarification_answer')
    return value


def draft(repo, method, params):
    fields(params, {'draft_kind', 'content', 'input'} if method == 'save' else {'draft_kind'}, {'draft_kind'})
    kind = choice(params['draft_kind'], 'draft_kind', ('search', 'rubric'))
    key = 'draft:' + kind
    if method == 'save':
        if not {'content', 'input'} & params.keys():
            raise CommandError('Provide draft content or input to save.')
        if 'content' in params:
            validate_draft(kind, params['content'])
        if 'input' in params:
            validate_draft_input(kind, params['input'])
        current = draft(repo, 'get', {'draft_kind': kind})
        check_result_size({**current, **params})
        with repo.db:
            if 'content' in params:
                put(repo.db, key, params['content'])
            if 'input' in params:
                put(repo.db, 'draft_input:' + kind, params['input'])
    row = repo.db.execute('SELECT value_json FROM settings WHERE key=?', (key,)).fetchone()
    content = json.loads(row[0]) if row else None
    if method == 'apply':
        if content is None:
            raise CommandError('Draft not found.', 'NOT_FOUND')
        validate_draft(kind, content)
        if kind == 'rubric':
            save(repo, {'rubric': content})
        else:
            if 'clarification' in content:
                raise CommandError('Answer the clarification and generate a search draft before applying.')
            with repo.db:
                repo.db.execute('BEGIN IMMEDIATE')
                repo.db.execute('DELETE FROM directions')
                repo.db.execute("UPDATE jobs SET queries_json='[]'")
                # Every selected search ID is replaced; All searches stays dynamic.
                repo.db.execute("UPDATE schedules SET direction_ids_json='[]',enabled=0 WHERE json_type(direction_ids_json)='array'")
                for index, d in enumerate(content['directions']):
                    did = str(uuid4())
                    repo.db.execute('INSERT INTO directions VALUES (?,?,1,?)', (did, d['name'].strip(), index))
                    for q in d['queries']:
                        repo.db.execute('INSERT INTO queries VALUES (?,?,?,?)', (str(uuid4()), did, q['expression'].strip(), q['enabled']))
                put(repo.db, 'cities', cities(content['cities']))
    row = repo.db.execute('SELECT value_json FROM settings WHERE key=?', ('draft_input:' + kind,)).fetchone()
    return {'draft_kind': kind, 'content': content, 'input': json.loads(row[0]) if row else None}
