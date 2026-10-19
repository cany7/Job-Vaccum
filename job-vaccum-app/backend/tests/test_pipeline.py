from contextlib import closing
from copy import deepcopy
import csv
import json
import queue
import sqlite3
import threading
import time

import pandas as pd
import pytest

from job_vaccum.pipeline.configuration import DEFAULTS, PARAMETERS, draft
from job_vaccum.pipeline.fake import FakeScraper
from job_vaccum.pipeline.ingest import ingest
from job_vaccum.pipeline.records import description_key, direct_url, text_key, filter_reason
from job_vaccum.pipeline.scraper import arguments, dataframe_result, invoke, process_attempt, retrieve, observe_http
from job_vaccum.service.protocol import CommandError
from job_vaccum.service.server import Service, serve
from job_vaccum.storage.database import connect, MIGRATIONS, migrate
from job_vaccum.storage.export import export_csv
from job_vaccum.storage.repository import Repository
from job_vaccum.storage.synthetic import import_synthetic

NOW = 1_800_000_000_000


def record(identifier='one', **changes):
    return {'id': identifier, 'site': 'linkedin', 'title': 'Engineer', 'company': 'Example Labs',
            'description': 'Build software.', 'location': 'Chicago', 'job_url': f'https://example.com/{identifier}',
            'job_url_direct': None, **changes}


def outcome(rows=(), error=None, **extra):
    return {'records': list(rows), 'error': error, 'warnings': [], **extra}


ERROR = {'code': 'NETWORK_ERROR', 'message': 'Synthetic failure', 'retryable': True}


@pytest.fixture
def service(tmp_path):
    db = connect(tmp_path / 'app.sqlite3')
    # In-process test attempt uses the exact same adapter/result boundary; real
    # spawn ownership is covered separately without network access.
    s = Service(db, tmp_path, clock=lambda: NOW, attempt=lambda *args: outcome([record()]))
    yield s
    s.runs.close()
    db.close()


def configure(s, *, scoring=False, sites=None, directions=1):
    s.dispatch('settings.save', {'auto_score_enabled': False, 'cities': [
        {'location': 'Chicago', 'distance_miles': 25, 'enabled': True}],
        'platforms': sites or ['linkedin', 'indeed'], 'retention_days': 0})
    for index in range(directions):
        d = s.dispatch('directions.save', {'name': f'Search {index}'})
        s.dispatch('queries.save', {'direction_id': d['id'], 'expression': f'query {index}'})
    if scoring:
        s.dispatch('settings.save', {'rubric': 'Evaluate engineering fit.', 'model': {
            'protocol': 'chat_completions', 'base_url': 'http://localhost:9999/v1', 'model_id': 'fake'},
            'auto_score_enabled': True})
    return s


def drain(s, *, until=None, timeout=5):
    events = []
    event = lambda name, data: events.append((name, data))
    deadline = time.monotonic() + timeout
    s.runs.advance(event)
    while s.runs.thread:
        assert time.monotonic() < deadline, 'Run timed out'
        kind, payload = s.inbox.get(timeout=timeout)
        s.runs.handle(kind, payload, event)
        if until and until():
            break
    return events


def start(s):
    return s.dispatch('runs.start', {})['run_id']


def detail(s, identifier):
    return s.dispatch('runs.detail', {'run_id': identifier})


def test_configuration_drafts_order_defaults_and_restart(service, tmp_path):
    s = service
    assert s.dispatch('settings.get', {})['auto_score_enabled'] is True
    assert s.dispatch('settings.get', {})['country_indeed'] == 'usa'
    with pytest.raises(CommandError):
        s.dispatch('settings.save', {'auto_score_enabled': True})
    with pytest.raises(CommandError):
        s.dispatch('runs.preview', {})
    configure(s)
    first = s.dispatch('settings.get', {})
    s.dispatch('settings.save', {'country_indeed': 'canada'})
    s.dispatch('settings.save', {'rubric': 'New rubric'})
    assert not s.dispatch('settings.get', {})['auto_score_enabled']
    content = {'directions': [{'name': 'Edited', 'queries': [{'expression': 'python', 'enabled': True}]}],
               'cities': [{'location': 'Toronto', 'distance_miles': 0, 'enabled': True}]}
    s.dispatch('drafts.save', {'draft_kind': 'search', 'content': content})
    assert s.dispatch('settings.get', {})['directions'] == first['directions']
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        repo = Repository(db)
        assert draft(repo, 'get', {'draft_kind': 'search'})['content'] == content
        assert repo.settings()['country_indeed'] == 'canada'
        assert repo.settings()['cities'][0]['id'] == first['cities'][0]['id']
    s.dispatch('drafts.apply', {'draft_kind': 'search'})
    assert s.dispatch('settings.get', {})['directions'][0]['name'] == 'Edited'
    assert s.dispatch('settings.get', {})['cities'][0]['distance_miles'] == 0
    with pytest.raises(CommandError):
        s.dispatch('settings.save', {'proxy': {'mode': 'ordinary', 'url': 'http://user:secret@localhost:8080'}})
    with pytest.raises(CommandError):
        s.dispatch('settings.save', {'model': {'protocol': 'chat_completions', 'base_url': 'https://u:p@example.com/v1', 'model_id': 'm'}})
    with pytest.raises(CommandError):
        s.dispatch('drafts.save', {'draft_kind': 'search', 'content': {'directions': [{'name': 'invalid', 'queries': [{'expression': '', 'enabled': True}]}], 'cities': []}})


def test_pipeline_batches_historical_hits_and_export(service, tmp_path):
    s = configure(service, directions=2)
    def attempt(spec, *args):
        return outcome([record(spec['site'], site=spec['site'], company='Ｅxample   Labs',
                               description='first body' if spec['site'] == 'indeed' else 'later body',
                               job_url_direct=f'https://jobs.example.com/{spec["site"]}?utm_source=x')])
    s.runs.attempt = attempt
    run = start(s)
    preview = s.dispatch('runs.preview', {})
    assert preview['task_count'] == 4
    events = drain(s)
    d = detail(s, run)
    assert d['status'] == 'succeeded' and d['stats']['retrieval']['succeeded'] == 4
    assert d['stats']['scoring']['total'] == 0
    assert d['stats']['new_job_count'] == d['new_job_count'] == 1
    assert all(x['matched_job_count'] == 1 for x in d['stats']['directions'])
    assert len([name for name, _ in events if name == 'jobs.changed']) == 4
    job = s.repo.detail({'job_id': d['jobs'][0]['job_id']})
    assert job['description'] == 'first body' and job['score_state'] == 'unscored'
    assert len(job['directions']) == len(job['sources']) == 2
    assert s.repo.db.execute('SELECT count(*) FROM run_tasks WHERE kind="score"').fetchone()[0] == 0
    with s.repo.db:
        s.repo.db.execute("UPDATE jobs SET score=0,score_reason='Original score',score_state='succeeded',scored_at=?,score_model='old-model' WHERE id=?", (NOW - 100, job['id']))
    job = s.repo.detail({'job_id': job['id']})
    second = start(s)
    drain(s)
    assert detail(s, second)['new_job_count'] == 0
    assert len(detail(s, second)['jobs']) == 1
    assert s.repo.detail({'job_id': job['id']}) == job
    assert s.repo.list_jobs({'run_ids': [second]})['total'] == 0
    assert s.repo.list_jobs({'run_ids': [run, second]})['total'] == 1
    destination = tmp_path.parent / (tmp_path.name + '-batch.csv')
    result = export_csv(tmp_path / 'app.sqlite3', {'scope': 'discover', 'range': 'filtered',
        'filter': {'run_ids': [run, second]}, 'include_jd': True, 'destination_path': str(destination)})
    assert result['row_count'] == 1
    assert list(csv.DictReader(destination.open(encoding='utf-8-sig')))[0]['description'] == 'first body'
    assert s.repo.list_jobs({'run_ids': ['deleted']})['total'] == 0
    with pytest.raises(CommandError):
        s.dispatch('runs.resume', {'run_id': run})


def test_deleted_direction_during_inflight_result_is_not_restored(service):
    s = configure(service, sites=['linkedin'])
    release, entered = threading.Event(), threading.Event()
    def attempt(*args):
        entered.set()
        assert release.wait(3)
        return outcome([record()])
    s.runs.attempt = attempt
    run = start(s)
    s.runs.advance(lambda *args: None)
    assert entered.wait(3)
    direction = s.repo.directions()[0]['id']
    s.dispatch('directions.delete', {'id': direction})
    assert s.dispatch('jobs.list', {})['total'] == 0
    with pytest.raises(CommandError, match='active'):
        s.dispatch('cleanup.execute', {'mode': 'manual'})
    release.set()
    drain(s)
    d = detail(s, run)
    assert d['status'] == 'succeeded' and d['config_snapshot']['directions'][0]['id'] == direction
    job = s.repo.detail({'job_id': d['jobs'][0]['job_id']})
    assert job['directions'] == job['queries'] == []
    assert s.repo.directions() == []


def test_retry_partial_atomic_resume_and_auto_score_snapshot(service, monkeypatch):
    s = configure(service, sites=['linkedin'])
    monkeypatch.setitem(PARAMETERS, 'retry_base_seconds', 0)
    s.runs.attempt = lambda *args: outcome([record(), record()], ERROR)
    run = start(s)
    drain(s)
    d = detail(s, run)
    assert d['status'] == 'partial' and d['tasks'][0]['attempt_count'] == 3
    assert d['stats']['received_count'] == 1 and d['new_job_count'] == 1
    original_task = d['tasks'][0]['id']
    s.dispatch('settings.save', {'auto_score_enabled': True, 'rubric': 'Rubric', 'model': {
        'protocol': 'responses', 'base_url': 'http://localhost:9999', 'model_id': 'other'}})
    s.dispatch('settings.save', {'cities': [{'location': 'Seattle', 'distance_miles': 50, 'enabled': True}]})
    s.runs.attempt = lambda *args: outcome([record()])
    s.dispatch('runs.resume', {'run_id': run})
    drain(s)
    d = detail(s, run)
    assert d['status'] == 'succeeded' and d['tasks'][0]['id'] == original_task
    assert d['tasks'][0]['attempt_count'] == 4 and d['tasks'][0]['spec']['location'] == 'Chicago'
    assert d['stats']['received_count'] == 1 and d['new_job_count'] == 1
    assert d['stats']['scoring']['total'] == 0 and not d['config_snapshot']['auto_score_enabled']
    assert s.repo.list_jobs({})['items'][0]['score_state'] == 'unscored'
    # New scored run: one task per new job, historical unscored hit remains unqueued.
    s.runs.attempt = lambda *args: outcome([record(), record('new', description='Different JD', title='Another Engineer')])
    scored = start(s)
    drain(s)
    d = detail(s, scored)
    assert d['status'] == 'running' and d['stage'] == 'scoring' and d['stats']['scoring']['pending'] == 1
    assert s.repo.db.execute("SELECT count(*) FROM jobs WHERE score_state='unscored'").fetchone()[0] == 1
    with pytest.raises(CommandError) as busy:
        start(s)
    assert busy.value.code == 'BUSY'
    s.dispatch('runs.stop', {'run_id': scored})
    drain(s)
    assert detail(s, scored)['status'] == 'stopped'


def test_atomic_failure_rolls_back_jobs_scores_and_completion(service, monkeypatch):
    s = configure(service, scoring=True, sites=['linkedin'])
    run = start(s)
    from job_vaccum.pipeline import runs as module
    real_ingest = module.ingest
    def fail_after_ingest(*args):
        real_ingest(*args)
        raise sqlite3.IntegrityError('Synthetic transaction failure')
    monkeypatch.setattr(module, 'ingest', fail_after_ingest)
    drain(s)
    d = detail(s, run)
    assert d['status'] == 'failed' and d['tasks'][0]['status'] == 'failed'
    assert s.repo.list_jobs({})['total'] == 0
    assert s.repo.db.execute('SELECT count(*) FROM run_jobs').fetchone()[0] == 0
    assert s.repo.db.execute("SELECT count(*) FROM run_tasks WHERE kind='score'").fetchone()[0] == 0


def test_cleanup_runs_retention_batch_orphans_and_rescore_validation(service):
    s = configure(service, sites=['linkedin'])
    run = start(s)
    drain(s)
    job = detail(s, run)['jobs'][0]['job_id']
    s.repo.add({'job_id': job})
    s.repo.update({'job_id': job, 'notes': 'Keep me', 'status': 'interviewing'})
    saved = s.repo.detail({'job_id': job})
    with s.repo.db:
        s.repo.db.execute("INSERT INTO runs (id,kind,status,created_at,started_at,config_snapshot_json) VALUES ('rescore','rescore','succeeded',0,0,'{}')")
    assert s.dispatch('runs.list', {})['total'] == 1
    with pytest.raises(CommandError):
        s.repo.list_jobs({'run_ids': ['rescore']})
    s.dispatch('settings.save', {'retention_days': 14})
    s.repo.clock = lambda: NOW + 14 * 86400000
    assert s.cleanup.preview('automatic')['runs'] == 1  # only rescore, boundary run retained
    assert s.cleanup.execute('automatic')['deleted_runs'] == 1
    s.repo.clock = lambda: NOW + 14 * 86400000 + 1
    assert s.cleanup.execute('automatic')['deleted_runs'] == 1
    assert s.repo.detail({'job_id': job}) == saved
    assert s.repo.list_jobs({'run_ids': [run]})['total'] == 0
    assert s.repo.list_jobs({'run_ids': []})['total'] == 1
    assert s.repo.db.execute('PRAGMA foreign_key_check').fetchall() == []


def test_restart_interrupts_only_unfinished_and_preserves_ids(service):
    s = configure(service, sites=['linkedin'])
    run = start(s)
    task = detail(s, run)['tasks'][0]
    with s.repo.db:
        s.repo.db.execute("UPDATE run_tasks SET status='running',attempt_count=1 WHERE id=?", (task['id'],))
    from job_vaccum.pipeline.runs import Runs
    restarted = Runs(s.repo, s.inbox, attempt=s.runs.attempt)
    assert restarted.detail({'run_id': run})['status'] == 'interrupted'
    assert restarted.task(task['id'])['status'] == 'pending'
    assert restarted.detail({'run_id': run})['stats']['retrieval']['active'] == 0
    assert restarted.detail({'run_id': run})['stats']['retrieval']['pending'] == 1
    s.runs = restarted
    s.dispatch('runs.resume', {'run_id': run})
    drain(s)
    assert detail(s, run)['tasks'][0]['id'] == task['id']
    assert detail(s, run)['tasks'][0]['attempt_count'] == 2


@pytest.mark.parametrize('scenario,status,count', [('zero','succeeded',0), ('failure','failed',0), ('partial','partial',1), ('success','succeeded',1)])
def test_fake_scenarios_end_states(service, monkeypatch, scenario, status, count):
    s = configure(service, sites=['linkedin'])
    monkeypatch.setitem(PARAMETERS, 'retry_base_seconds', 0)
    s.runs.attempt = lambda spec, params, proxy, stop: invoke(spec, params, proxy, FakeScraper(scenario))
    run = start(s)
    drain(s)
    assert detail(s, run)['status'] == status
    assert detail(s, run)['new_job_count'] == count


def test_m1_to_m2_migration_preserves_data_and_failure_rolls_back(tmp_path):
    path = tmp_path / 'old.sqlite3'
    with closing(sqlite3.connect(path)) as db:
        db.executescript('CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(2);' + (MIGRATIONS / '001.sql').read_text() + (MIGRATIONS / '002.sql').read_text())
        repo = Repository(db, lambda: NOW)
        import_synthetic(repo, {'count': 1})
        before = repo.list_jobs({})
        broken = tmp_path / 'broken'
        broken.mkdir()
        (broken / '003.sql').write_text('CREATE TABLE runs(id TEXT);\nINVALID SQL;\n')
        from job_vaccum.storage.database import DatabaseError
        with pytest.raises(DatabaseError):
            migrate(db, broken)
        assert db.execute('SELECT version FROM schema_version').fetchone()[0] == 2
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE name='runs'").fetchone()
    with closing(connect(path)) as db:
        assert Repository(db).list_jobs({}) == before
        assert db.execute('SELECT version FROM schema_version').fetchone()[0] == 3


def test_jobspy_whitelist_attrs_missing_values_and_native_shapes():
    from datetime import date
    from jobspy.model import CompensationInterval, Country, JobType
    spec = {'site': 'linkedin', 'expression': 'python', 'location': 'Chicago', 'distance_miles': 25, 'country_indeed': 'canada'}
    a = arguments(spec, PARAMETERS, None)
    assert a['site_name'] == 'linkedin' and a['offset'] == 0 and a['fetch_description'] is True
    assert not {'linkedin_fetch_description', 'is_remote', 'job_type', 'country_indeed'} & a.keys()
    a = arguments({**spec, 'site': 'indeed'}, PARAMETERS, 'http://proxy:8080')
    assert a['country_indeed'] == 'canada' and a['proxies'] == ['http://proxy:8080'] and 'fetch_description' not in a
    df = pd.DataFrame([{'title': 'Engineer', 'description': pd.NA, 'id': float('nan'), 'date_posted': pd.NaT,
        'job_url_direct': pd.NA, 'min_amount': 0, 'max_amount': float('nan'),
        'location': {'city': 'Chicago', 'state': None, 'country': Country.USA},
        'job_type': [JobType.FULL_TIME], 'interval': CompensationInterval.HOURLY, 'currency': 'USD'},
        {'title': 'Other', 'description': 'Full JD', 'date_posted': date(2026, 10, 19)}])
    df = df[list(reversed(df.columns))]
    df.attrs = {'errors': {'linkedin': 'Network via http://user:secret@proxy:8080 failed'},
                'warnings': {'linkedin': ['Detail missing; password=secret']}}
    result = dataframe_result(df, 'linkedin', 'http://user:secret@proxy:8080')
    r = result['records'][0]
    assert r['salary_min'] == 0 and r['salary_max'] is None
    assert r['id'] is r['description'] is r['job_url_direct'] is r['date_posted'] is None
    assert r['location'] == 'Chicago, usa' and r['job_type'] == 'fulltime' and r['salary_interval'] == 'hourly'
    assert result['records'][1]['date_posted'] == '2026-10-19'
    assert result['missing_jd_count'] == 1 and result['error'] and result['warnings']
    assert 'secret' not in json.dumps(result) and 'user:' not in json.dumps(result)
    def bad_params(**kwargs):
        raise TypeError('private http://u:secret@proxy:8080')
    assert invoke(spec, PARAMETERS, None, bad_params)['error']['code'] == 'VALIDATION_ERROR'


def test_parameter_failure_retry_budget_warning_only_and_interruptible_wait():
    spec = {'site': 'linkedin', 'expression': 'python', 'location': 'Chicago', 'distance_miles': 0, 'country_indeed': 'usa'}
    stop, seen = threading.Event(), []
    def attempt(*args):
        seen.append(1)
        return outcome([record()], {'code': 'VALIDATION_ERROR', 'message': 'bad', 'retryable': False})
    result = retrieve(spec, PARAMETERS, None, stop, attempt)
    assert len(seen) == 1 and result['records']
    seen.clear()
    def warning(*args):
        seen.append(1)
        return {'records': [], 'error': None, 'warnings': ['No description']}
    assert retrieve(spec, PARAMETERS, None, stop, warning)['error'] is None and len(seen) == 1
    def pressure(*args):
        stop.set()
        return outcome([record()], ERROR)
    before = time.monotonic()
    result = retrieve(spec, PARAMETERS, None, stop, pressure)
    assert time.monotonic() - before < 1 and result['records'] == [] and result['error']['code'] == 'CANCELLED'


def test_real_spawn_fake_delay_and_whole_task_timeout():
    spec = {'site': 'linkedin', 'expression': 'python', 'location': 'Chicago', 'distance_miles': 0, 'country_indeed': 'usa'}
    result = process_attempt(spec, {**PARAMETERS, 'timeout_seconds': 10}, None, threading.Event(), FakeScraper('delay', delay=0.02))
    assert not result['error'] and len(result['records']) == 1
    result = process_attempt(spec, {**PARAMETERS, 'timeout_seconds': 0.05}, None, threading.Event(), FakeScraper('delay', delay=2))
    assert result['error']['code'] == 'WORKER_EXITED'
    import multiprocessing
    assert not [p for p in multiprocessing.active_children() if p.name == 'jobspy-task']


def test_http_observation_and_redacted_standard_logging(monkeypatch):
    import logging
    import requests
    from curl_cffi import requests as curl_requests
    from job_vaccum.pipeline.scraper import SafeLog
    class Response:
        status_code = 429
    fake_send = lambda *args, **kwargs: Response()
    monkeypatch.setattr(requests.Session, 'send', fake_send)
    monkeypatch.setattr(curl_requests.Session, 'request', fake_send)
    with observe_http() as counts:
        requests.Session().send(None)
        curl_requests.Session().request('GET', 'https://example.invalid')
    assert counts == {'http_requests': 2, 'http_429': 2}
    assert requests.Session.send is fake_send and curl_requests.Session.request is fake_send
    log = logging.LogRecord('jobspy.linkedin', logging.ERROR, '', 1,
        'Failed %s', ('http://user:p%40ss@proxy:8080/path?token=private',), None)
    SafeLog('http://user:p%40ss@proxy:8080').filter(log)
    assert not any(v in log.getMessage() for v in ('user', 'private', 'p%40ss'))


@pytest.mark.parametrize('body,threshold,q,expected', [
    ('At least 4 years of experience required.', 3, {}, 'experience'),
    ('At least 4 years of experience required.', 5, {}, None),
    ('6+ years of experience preferred.', 3, {}, None),
    ('4+ years of experience required, 7+ years of experience preferred.', 3, {}, 'experience'),
    ('B.S. with 5+ years of experience or M.S. with 4+ years of experience required', 3, {'degrees': ['ms']}, 'experience'),
    ('B.S. with 5+ years of experience or M.S. with 4+ years of experience required', 5, {'degrees': ['ms']}, None),
    ('Bachelor with 5+ years of experience or Master with 2+ years of experience required', 3, {'degrees': ['master']}, None),
    ('Bachelor with 5+ years of experience or Master with 4+ years of experience required', 3, {'degrees': ['master']}, 'experience'),
    ('Bachelor with 5+ years of experience or Master with 4+ years of experience required', 5, {'degrees': ['master']}, None),
    ('OPT candidates welcome.', 3, {'work_authorization': 'opt'}, None),
    ('OPT is not accepted.', 3, {'work_authorization': 'opt'}, 'authorization'),
    ('US citizens only or OPT candidates eligible.', 3, {'work_authorization': 'opt'}, None),
    ('We cannot sponsor visas.', 3, {'requires_sponsorship': True}, 'authorization'),
    ('PhD required or Master degree accepted.', 3, {'degrees': ['master']}, None),
    ('PhD required.', 3, {'degrees': ['master']}, 'degree'),
    ('French fluency required.', 3, {'languages': ['English']}, 'language'),
    ('French fluency required.', 3, {}, None),
    ('Must graduate by 2027-05-01.', 3, {'graduation_date': '2027-06-01'}, 'graduation'),
    ('Must graduate by 2027-05-01.', 3, {}, None),
])
def test_rules_thresholds_alternatives_and_no_private_assumptions(body, threshold, q, expected):
    rules = {**deepcopy(DEFAULTS['rules']), 'enabled_rule_ids': ['experience', 'authorization', 'language', 'graduation', 'degree'],
             'experience_max_years': threshold, 'qualifications': q}
    assert filter_reason(record(description=body), rules) == expected
    assert filter_reason(record(title='PhD Researcher with MS', description='Master accepted.'), rules) is None


def test_normalization_and_first_filter_reason():
    assert text_key('  ＡＣＭＥ  Labs  ') == 'acme labs'
    assert description_key('# Build\n\n**Tools** and [systems](https://example.com)') == description_key('<h1>Build</h1><p>Tools and systems</p>')
    assert direct_url('https://EXAMPLE.com/jobs/123/?utm_source=abc#top') == 'https://example.com/jobs/123'
    assert direct_url('https://example.com/careers?utm_source=x') is None
    rules = {**deepcopy(DEFAULTS['rules']), 'excluded_companies': ['Example Labs']}
    assert filter_reason(record(title='', description=''), rules) == 'company'
    rules['excluded_companies'] = []
    assert filter_reason(record(title='', job_type='parttime'), rules) == 'empty_record'
    assert filter_reason(record(job_type='parttime'), rules) == 'part_time'


def ingest_records(s, run, rows):
    d = detail(s, run)
    with s.repo.db:
        return ingest(s.repo.db, run, d['tasks'][0], d['config_snapshot'], outcome(rows), NOW)


def test_dedup_boundaries_and_cross_batch_current_run_matches(service):
    s = configure(service, sites=['linkedin'])
    run = start(s)
    stats = ingest_records(s, run, [record('a', job_url_direct='https://external.example/a'),
        record('b', job_url_direct='https://external.example/b'), record('c', description='Different JD'),
        record(None, company=None, title='Unknown', description='JD'),
        record(None, company=None, title='Other unknown', description='JD')])
    assert stats['matched_job_count'] == 5
    with s.repo.db:
        s.repo.db.execute("UPDATE runs SET status='succeeded' WHERE id=?", (run,))
    other = start(s)
    ingest_records(s, other, [record('new', description='Another JD', job_url_direct='https://external.example/new')])
    assert s.repo.list_jobs({})['total'] == 6  # history never company/title only
    ingest_records(s, other, [record('cross', site='indeed', location='Elsewhere', description='Later', job_url_direct='https://other.example/job')])
    assert s.repo.list_jobs({})['total'] == 6  # current run title merge ignores location/link


def test_conflicting_identities_keep_owners_and_applications(service):
    s = configure(service, sites=['linkedin'])
    run = start(s)
    ingest_records(s, run, [record('a', title='A', job_url_direct='https://external.example/a'),
                            record('b', title='B', description='Second JD', job_url_direct='https://external.example/b')])
    jobs = s.repo.list_jobs({})['items']
    s.repo.add({'job_ids': [j['id'] for j in jobs]}, many=True)
    owners = s.repo.db.execute('SELECT * FROM job_identities ORDER BY kind,value').fetchall()
    stats = ingest_records(s, run, [record('a', job_url_direct='https://external.example/b')])
    assert stats['identity_conflicts'] == 1
    assert s.repo.db.execute('SELECT * FROM job_identities ORDER BY kind,value').fetchall() == owners
    assert s.repo.list_jobs({'scope': 'applications'})['total'] == 2


def test_resume_skips_successful_tasks_stable_order_representative(service, monkeypatch):
    s = configure(service, directions=2)
    monkeypatch.setitem(PARAMETERS, 'retry_base_seconds', 0)
    run = start(s)
    before = detail(s, run)['tasks']
    specs = [t['spec'] for t in before]
    assert [(t['query_id'], t['city_id'], t['site']) for t in specs] == sorted((t['query_id'], t['city_id'], t['site']) for t in specs)
    s.repo.direction_reorder({'ids': list(reversed([d['id'] for d in s.repo.directions()]))})
    s.runs.attempt = lambda spec, *args: outcome([record('i', site='indeed', description='First representative')]) if spec['site'] == 'indeed' else outcome([], ERROR)
    drain(s)
    assert detail(s, run)['status'] == 'partial'
    s.runs.attempt = lambda spec, *args: outcome([record('l', site='linkedin', description='Later complete JD')])
    s.dispatch('runs.resume', {'run_id': run})
    drain(s)
    after = detail(s, run)
    assert after['status'] == 'succeeded' and [t['id'] for t in after['tasks']] == [t['id'] for t in before]
    assert [t['attempt_count'] for t in after['tasks'] if t['spec']['site'] == 'indeed'] == [1, 1]
    assert s.repo.detail({'job_id': after['jobs'][0]['job_id']})['description'] == 'First representative'


def test_json_lines_complete_flow_async_events_and_responsive_receiver(tmp_path):
    incoming, outgoing = queue.Queue(), queue.Queue()
    release, entered = threading.Event(), threading.Event()
    errors, events = [], []
    class Input:
        def readline(self, _):
            return incoming.get(timeout=10)
    class Output:
        def write(self, data):
            outgoing.put(json.loads(data))
        def flush(self):
            pass
    def attempt(spec, params, proxy, stop):
        entered.set()
        assert release.wait(5)
        return invoke(spec, params, proxy, FakeScraper('success'))
    def run():
        try:
            serve(tmp_path, Input(), Output(), clock=lambda: NOW, attempt=attempt, cleanup_interval=0.02)
        except BaseException as exc:
            errors.append(exc)
    owner = threading.Thread(target=run)
    owner.start()
    sequence = 0
    def command(method, params=None):
        nonlocal sequence
        sequence += 1
        identifier = str(sequence)
        incoming.put(json.dumps({'type': 'request', 'id': identifier, 'method': method, 'params': params or {}}).encode() + b'\n')
        while True:
            message = outgoing.get(timeout=5)
            if message['type'] == 'event':
                events.append(message)
            else:
                assert message['id'] == identifier
                return message
    try:
        ready = outgoing.get(timeout=5)
        assert ready['name'] == 'ready'
        events.append(ready)
        assert command('settings.save', {'auto_score_enabled': False, 'cities': [
            {'location': 'Chicago', 'distance_miles': 10, 'enabled': True}], 'platforms': ['linkedin']})['ok']
        d = command('directions.save', {'name': 'Manual'})['result']['id']
        command('queries.save', {'direction_id': d, 'expression': 'engineer'})
        assert command('runs.preview')['result']['task_count'] == 1
        run_id = command('runs.start')['result']['run_id']
        assert entered.wait(5)  # response returned before worker completes
        assert command('runs.start')['error']['code'] == 'BUSY'
        assert command('cleanup.execute', {'mode': 'manual'})['error']['code'] == 'BUSY'
        assert command('app.status')['result']['active_run']['run_id'] == run_id
        assert command('jobs.list')['result']['total'] == 0
        release.set()
        while True:
            message = outgoing.get(timeout=5)
            assert message['type'] == 'event'
            events.append(message)
            if message['name'] == 'run.updated' and message['data']['status'] == 'succeeded':
                break
        listing = command('jobs.list', {'run_ids': [run_id]})['result']
        assert listing['total'] == 1
        job_id = listing['items'][0]['id']
        assert command('applications.add', {'job_id': job_id})['result']['outcome'] == 'added'
        assert command('runs.list')['result']['items'][0]['new_job_count'] == 1
        command('cleanup.execute', {'mode': 'manual'})
        assert command('jobs.list', {'run_ids': [run_id]})['result']['total'] == 0
        assert command('jobs.detail', {'job_id': job_id})['result']['description'] == 'Build reliable software.'
        assert [e['seq'] for e in events] == list(range(1, len(events) + 1))
        assert {'run.updated', 'run.stats', 'jobs.changed'} <= {e['name'] for e in events}
    finally:
        release.set()
        incoming.put(b'')
        owner.join(5)
    assert not owner.is_alive() and not errors


def test_proxy_modes_no_secret_snapshot_and_resume_current_credentials(service):
    s = configure(service, sites=['linkedin'])
    s.dispatch('settings.save', {'proxy': {'mode': 'ordinary', 'url': 'http://localhost:8080'}})
    s.dispatch('internal.credentials', {'proxy_url': 'http://synthetic:password-one@localhost:8080'})
    s.runs.attempt = lambda spec, params, proxy, stop: outcome([], {'code': 'VALIDATION_ERROR', 'message': 'synthetic', 'retryable': False})
    run = start(s)
    drain(s)
    d = detail(s, run)
    assert 'password-one' not in json.dumps(d)
    assert d['config_snapshot']['proxy'] == {'mode': 'ordinary', 'url': 'http://localhost:8080'}
    assert d['config_snapshot']['jobspy_commit'] == '1988484ac76ff9ae57784750346842e967e8ba10'
    seen = []
    def attempt(spec, params, proxy, stop):
        seen.append(proxy)
        return outcome([])
    s.runs.attempt = attempt
    s.dispatch('internal.credentials', {'proxy_url': 'http://synthetic:password-two@localhost:8080'})
    s.dispatch('settings.save', {'proxy': {'mode': 'off', 'url': None}})
    s.dispatch('runs.resume', {'run_id': run})
    drain(s)
    assert seen == ['http://synthetic:password-two@localhost:8080']
    run = start(s)
    drain(s)
    assert seen[-1] is None
    assert 'password' not in json.dumps(detail(s, run))


def test_new_scoring_tasks_reference_job_only_and_do_not_copy_jd(service):
    s = configure(service, scoring=True)
    run = start(s)
    drain(s)
    d = detail(s, run)
    tasks = [t for t in d['tasks'] if t['kind'] == 'score']
    assert len(tasks) == 1 and set(tasks[0]['spec']) == {'job_id'}
    assert d['stats']['scoring']['total'] == 1 and d['new_job_count'] == 1
    s.dispatch('runs.stop', {'run_id': run})
    drain(s)


def test_proxy_edits_during_run_only_affect_next_start(service):
    s = configure(service)
    s.dispatch('settings.save', {'proxy': {'mode': 'ordinary', 'url': 'http://localhost:8080'}})
    s.dispatch('internal.credentials', {'proxy_url': 'http://test:old@localhost:8080'})
    seen = []
    def attempt(spec, params, proxy, stop):
        seen.append(proxy)
        return outcome([])
    s.runs.attempt = attempt
    run = start(s)
    s.dispatch('settings.save', {'proxy': {'mode': 'ordinary', 'url': 'http://localhost:8888'}})
    s.dispatch('internal.credentials', {'proxy_url': 'http://test:new@localhost:8888'})
    drain(s)
    assert seen == ['http://test:old@localhost:8080'] * 2
    assert 'old@' not in json.dumps(detail(s, run))
    start(s)
    drain(s)
    assert seen[-2:] == ['http://test:new@localhost:8888'] * 2


def test_partial_resume_replaces_counts_but_keeps_previous_committed_direction_hits(service, monkeypatch):
    s = configure(service, sites=['linkedin'])
    monkeypatch.setitem(PARAMETERS, 'retry_base_seconds', 0)
    s.runs.attempt = lambda *args: outcome([record('a')], ERROR)
    run = start(s)
    drain(s)
    s.runs.attempt = lambda *args: outcome([record('b', description='Another JD')])
    s.dispatch('runs.resume', {'run_id': run})
    drain(s)
    d = detail(s, run)
    assert d['stats']['received_count'] == 1  # latest response, not sum of retries/resumes
    assert d['stats']['new_job_count'] == d['stats']['matched_job_count'] == 2
    assert d['stats']['directions'][0]['matched_job_count'] == 2


def test_content_link_boundary_uses_later_source_links_when_representative_has_none(service):
    s = configure(service, sites=['linkedin'])
    run = start(s)
    ingest_records(s, run, [record('first', job_url_direct=None)])
    ingest_records(s, run, [record('other-source', site='indeed', job_url_direct='https://external.example/a')])
    assert s.repo.list_jobs({})['total'] == 1
    original = s.repo.list_jobs({})['items'][0]['id']
    assert s.repo.detail({'job_id': original})['links']['job_url_direct'] is None
    ingest_records(s, run, [record('different-link', job_url_direct='https://external.example/b')])
    assert s.repo.list_jobs({})['total'] == 2
    assert s.repo.detail({'job_id': original})['description'] == 'Build software.'
