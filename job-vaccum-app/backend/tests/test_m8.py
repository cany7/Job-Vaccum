import sqlite3

import pytest

from job_vaccum.service.protocol import CommandError, MAX_MESSAGE_BYTES
from job_vaccum.storage.database import connect, MIGRATIONS, migrate, DatabaseError
from job_vaccum.storage.synthetic import import_synthetic
from test_pipeline import service, configure, drain


def test_manual_atomic_edit_identity_cleanup_restart(service):
    s = service
    created = s.dispatch('applications.create_job', {'title': 'Only a title'})
    identifier = created['job_id']
    assert created['status'] == 'new'
    assert s.dispatch('jobs.list', {})['total'] == 0
    assert s.dispatch('jobs.query', {'scope': 'applications'})['total'] == 1
    s.dispatch('applications.update_job', {'job_id': identifier, 'description': 'Full JD', 'company': '  Ａcme  ',
               'job_url_direct': 'https://example.com/job/1?utm_source=test', 'notes': 'Full notes', 'status': 'applied'})
    job = s.dispatch('jobs.detail', {'job_id': identifier})
    assert job['origin'] == 'manual' and job['description'] == 'Full JD'
    assert job['score'] is None and job['score_state'] == 'unscored'
    assert job['sources'] == job['queries'] == job['directions'] == []
    assert s.repo.db.execute('SELECT company_key FROM jobs').fetchone()[0] == 'acme'
    with pytest.raises(CommandError):
        s.dispatch('applications.create_job', {'title': 'Duplicate', 'job_url_direct': 'https://example.com/job/1'})
    with pytest.raises(CommandError):
        s.dispatch('applications.create_job', {'title': 'Same body', 'company': 'acme', 'description': 'Full JD'})
    s.dispatch('applications.update_job', {'job_id': identifier, 'job_url_direct': None, 'company': None, 'description': None})
    assert not s.repo.db.execute('SELECT 1 FROM job_identities').fetchone()
    assert s.dispatch('jobs.detail', {'job_id': identifier})['description'] == ''
    s.dispatch('cleanup.execute', {'mode': 'manual'})
    assert s.dispatch('jobs.detail', {'job_id': identifier})['application']['notes'] == 'Full notes'
    with connect(s.root / 'app.sqlite3') as reopened:
        assert reopened.execute('SELECT origin FROM jobs WHERE id=?', (identifier,)).fetchone()[0] == 'manual'
    s.repo.db.execute("CREATE TRIGGER fail_app BEFORE INSERT ON applications BEGIN SELECT RAISE(ABORT,'test'); END")
    with pytest.raises(sqlite3.IntegrityError):
        s.dispatch('applications.create_job', {'title': 'Rollback', 'job_url_direct': 'https://example.com/job/2'})
    assert s.repo.db.execute('SELECT count(*) FROM jobs').fetchone()[0] == 1
    assert not s.repo.db.execute('SELECT 1 FROM job_identities').fetchone()


@pytest.mark.parametrize('patch', [{'title': ''}, {'date_posted': '2026-02-30'}, {'job_url': 'javascript:alert(1)'},
                                  {'job_url_direct': 'https://user:secret@example.com/1'}, {'score': 9}, {'origin': 'scraped'}])
def test_manual_validation_is_atomic(service, patch):
    identifier = service.dispatch('applications.create_job', {'title': 'Original'})['job_id']
    with pytest.raises(CommandError):
        service.dispatch('applications.update_job', {'job_id': identifier, 'notes': 'must not commit', **patch})
    assert service.repo.application(identifier)['notes'] == ''
    assert service.repo.detail({'job_id': identifier})['title'] == 'Original'


def test_oversize_response_rolls_back(service):
    with pytest.raises(CommandError, match='1 MiB'):
        service.dispatch('applications.create_job', {'title': 'Rollback', 'notes': 'n' * MAX_MESSAGE_BYTES})
    assert service.repo.db.execute('SELECT count(*) FROM jobs').fetchone()[0] == 0


def test_queries_projection_pagination_and_batch(service):
    s = service
    import_synthetic(s.repo, {'count': 405})
    reason = '完整评分理由 ' * 1000
    with s.repo.db:
        s.repo.db.execute('UPDATE jobs SET score_reason=?', (reason,))
    queries = []
    s.repo.db.set_trace_callback(queries.append)
    page = s.dispatch('jobs.query', {})
    assert len(page['items']) == 50 and page['total'] == 405 and page['has_more']
    assert page['items'][0]['score_reason'] == reason
    assert not {'description', 'sources', 'directions', 'salary', 'notes', 'queries'} & page['items'][0].keys()
    assert not any('description' in q or 'sources_json' in q for q in queries)
    ids = []
    for page in range(1, 4):
        ids.extend(s.dispatch('jobs.query', {'view': 'ids', 'page': page})['ids'])
    assert len(set(ids)) == 405
    for offset in range(0, len(ids), 200):
        assert s.dispatch('applications.add_many', {'job_ids': ids[offset:offset+200]})['counts']['added'] == len(ids[offset:offset+200])
    s.dispatch('applications.update_job', {'job_id': ids[0], 'status': 'applied', 'notes': 'full notes'})
    assert s.dispatch('applications.add_many', {'job_ids': [ids[0], ids[0], 'missing']})['counts'] == {'added': 0, 'already_present': 1, 'not_found': 1}
    assert s.repo.application(ids[0])['notes'] == 'full notes'
    with pytest.raises(CommandError):
        s.dispatch('applications.update_job', {'job_id': ids[0], 'title': 'Cannot overwrite', 'notes': 'lost'})
    assert s.repo.application(ids[0])['notes'] == 'full notes'
    selected = s.dispatch('jobs.query', {'scope': 'applications', 'application_statuses': ['applied'], 'updated_from': 1})
    assert selected['total'] == 1 and selected['items'][0]['notes'] == 'full notes'
    for params in ({'page_size': 51}, {'view': 'ids', 'page_size': 201}, {'page': 0}):
        with pytest.raises(CommandError):
            s.dispatch('jobs.query', params)
    with pytest.raises(CommandError):
        s.dispatch('applications.add_many', {'job_ids': ids[:201]})
    assert len(s.dispatch('jobs.list', {'page_size': 200})['items']) == 200
    s.repo.db.set_trace_callback(None)


def test_schedules_preview_and_light_runs(service):
    s = configure(service, sites=['indeed'])
    schedule = s.dispatch('schedules.save', {'enabled': False, 'direction_ids': None, 'time': '09:00', 'weekdays': [0, 1], 'timezone': 'UTC'})['id']
    before = s.dispatch('schedules.get', {'schedule_id': schedule})
    after = s.dispatch('schedules.update', {'schedule_id': schedule, 'time': '10:00'})
    assert all(after[k] == before[k] for k in ('enabled', 'direction_ids', 'weekdays', 'timezone', 'created_at'))
    assert s.dispatch('schedules.preview', {'schedule_id': schedule})['task_count'] == 1
    assert s.dispatch('runs.summaries', {})['total'] == 0
    for patch in ({'time': '99:00'}, {'timezone': 'Bad/Zone'}, {'direction_ids': ['missing']}):
        with pytest.raises(CommandError):
            s.dispatch('schedules.update', {'schedule_id': schedule, **patch})
        assert s.schedules.row(schedule)['time'] == '10:00'
    with pytest.raises(CommandError):
        s.dispatch('schedules.preview', {'schedule_id': schedule, 'direction_ids': None})
    run = s.dispatch('runs.start', {'schedule_id': schedule})['run_id']
    active = s.dispatch('runs.summary', {'run_id': run})
    assert active['status'] == 'running' and active['stats']['retrieval']['total'] == 1
    snapshot = s.runs.row(run)['config_snapshot_json']
    s.dispatch('schedules.update', {'schedule_id': schedule, 'enabled': True})
    assert s.runs.row(run)['config_snapshot_json'] == snapshot
    drain(s)
    queries = []
    s.repo.db.set_trace_callback(queries.append)
    one = s.dispatch('runs.summary', {'run_id': run})
    listing = s.dispatch('runs.summaries', {'schedule_id': schedule, 'statuses': ['succeeded'], 'created_from': 1})
    assert listing['items'] == [one]
    assert one['stats']['received_count'] == one['stats']['new_job_count'] == 1
    assert not {'error', 'tasks', 'config_snapshot', 'jobs'} & one.keys()
    assert not any('SELECT *' in q or 'config_snapshot_json' in q or 'spec_json' in q for q in queries)
    s.repo.db.set_trace_callback(None)
    s.dispatch('cleanup.execute', {'mode': 'manual'})
    with pytest.raises(CommandError) as error:
        s.dispatch('runs.summary', {'run_id': run})
    assert error.value.code == 'NOT_FOUND'


def test_migration_6_preserves_scraped_and_rollback(tmp_path):
    db = sqlite3.connect(tmp_path / 'old.db')
    db.executescript('CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(5);' + ''.join((MIGRATIONS / f'{i:03}.sql').read_text() for i in range(1, 6)))
    db.execute("INSERT INTO jobs(id,title,description,first_seen_at,sources_json,queries_json,company_key) VALUES ('old','Title','JD',1,'[]','[]','')")
    db.commit()
    broken = tmp_path / 'broken'; broken.mkdir()
    (broken / '006.sql').write_text((MIGRATIONS / '006.sql').read_text() + 'INVALID SQL;\n')
    with pytest.raises(DatabaseError):
        migrate(db, broken)
    assert 'origin' not in {r[1] for r in db.execute('PRAGMA table_info(jobs)')}
    migrate(db)
    assert db.execute('SELECT origin,description FROM jobs').fetchone() == ('scraped', 'JD')
    db.close()


def test_scrape_matches_manual_without_overwrite_and_source_identity_survives_edit(service):
    from test_pipeline import outcome, record
    s = configure(service, scoring=True, sites=['indeed'])
    link = 'https://example.com/job/shared'
    identifier = s.dispatch('applications.create_job', {'title': 'Manual title', 'description': 'Manual JD',
        'company': 'Company', 'job_url_direct': link})['job_id']
    s.runs.attempt = lambda *a: outcome([record(job_url_direct=link, description='New scrape JD')])
    run = s.dispatch('runs.start', {})['run_id']
    drain(s)
    job = s.repo.detail({'job_id': identifier})
    assert job['origin'] == 'manual' and job['description'] == 'Manual JD'
    assert len(job['sources']) == 1
    assert s.dispatch('runs.summary', {'run_id': run})['stats']['new_job_count'] == 0
    assert s.dispatch('runs.summary', {'run_id': run})['stats']['scoring']['total'] == 0
    s.dispatch('applications.update_job', {'job_id': identifier, 'job_url_direct': None})
    assert s.repo.db.execute("SELECT job_id FROM job_identities WHERE kind='direct_url' AND value=?", (link,)).fetchone()[0] == identifier
    s.dispatch('settings.save', {'retention_days': 1})
    with s.repo.db:
        s.repo.db.execute('UPDATE jobs SET first_seen_at=0')
    s.cleanup.execute('automatic')
    assert s.repo.detail({'job_id': identifier})['description'] == 'Manual JD'


def test_schedule_patch_applies_to_future_firing(service):
    from datetime import datetime, timezone
    s = configure(service, sites=['indeed'])
    now = [int(datetime(2026, 10, 26, 8, tzinfo=timezone.utc).timestamp()*1000)]
    s.repo.clock = lambda: now[0]
    identifier = s.dispatch('schedules.save', {'enabled': True, 'direction_ids': None,
        'time': '09:00', 'weekdays': [0], 'timezone': 'UTC'})['id']
    s.dispatch('schedules.update', {'schedule_id': identifier, 'time': '10:00'})
    now[0] += 3600000
    with pytest.raises(CommandError):
        s.dispatch('schedules.trigger', {'schedule_id': identifier, 'scheduled_at': now[0]})
    assert s.dispatch('runs.summaries', {})['total'] == 0
    now[0] += 3600000
    firing = s.dispatch('schedules.trigger', {'schedule_id': identifier, 'scheduled_at': now[0]})
    assert firing['outcome'] == 'started'
    drain(s)
    assert s.dispatch('runs.summary', {'run_id': firing['run_id']})['status'] == 'succeeded'
