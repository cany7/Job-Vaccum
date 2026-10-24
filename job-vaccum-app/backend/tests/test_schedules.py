from datetime import datetime, timezone
import json
import sqlite3

import pytest

from job_vaccum.llm.fake import FakeLlm
from job_vaccum.pipeline.schedules import occurrences
from job_vaccum.service.protocol import CommandError
from job_vaccum.service.server import Service
from job_vaccum.storage.database import connect, MIGRATIONS, migrate, DatabaseError
from test_pipeline import configure, drain, outcome, record


def ms(text):
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp() * 1000)


@pytest.fixture
def scheduler(tmp_path):
    now = [ms('2026-10-19T08:00:00')]
    db = connect(tmp_path / 'app.sqlite3')
    s = Service(db, tmp_path, clock=lambda: now[0], attempt=lambda *a: outcome([record()]),
                llm_options={'transport': FakeLlm(), 'rpm': 600000, 'retry_base': 0})
    configure(s, sites=['indeed'])
    yield s, now
    s.runs.close()
    db.close()


def save(s, **changes):
    params = {'enabled': True, 'direction_ids': None, 'time': '09:00', 'weekdays': list(range(7)), 'timezone': 'UTC', **changes}
    return s.dispatch('schedules.save', params)['id']


def fire(s, now, identifier, at='2026-10-19T09:00:00'):
    now[0] = ms(at)
    return s.dispatch('schedules.trigger', {'schedule_id': identifier, 'scheduled_at': now[0]})


def listed(s):
    return s.dispatch('schedules.list', {})


@pytest.mark.parametrize('zone,wall,after,expected', [
    ('America/Chicago', '02:30', '2026-03-08T00:00:00', '2026-03-08T08:00:00'),
    ('America/Chicago', '01:30', '2026-11-01T00:00:00', '2026-11-01T06:30:00'),
    # The second fold must be skipped even when starting between the folds.
    ('America/Chicago', '01:30', '2026-11-01T06:45:00', '2026-11-02T07:30:00'),
    ('Australia/Lord_Howe', '02:15', '2026-10-03T12:00:00', '2026-10-03T15:30:00'),
    ('Asia/Kathmandu', '09:00', '2026-10-19T00:00:00', '2026-10-19T03:15:00'),
])
def test_calendar_dst_and_fractional_offsets(zone, wall, after, expected, monkeypatch):
    monkeypatch.setenv('TZ', 'Pacific/Honolulu')
    assert next(occurrences({'timezone': zone, 'time': wall, 'weekdays': list(range(7))}, ms(after))) == ms(expected)


@pytest.mark.parametrize('changes', [
    {'time': '9:00'}, {'time': '24:00'}, {'weekdays': [7]}, {'weekdays': [True]},
    {'timezone': 'Not/AZone'}, {'timezone': '../UTC'}, {'direction_ids': []},
    {'direction_ids': ['missing']}, {'enabled': 1}, {'weekdays': 'Monday'},
])
def test_schedule_validation(scheduler, changes):
    s, _ = scheduler
    with pytest.raises(CommandError):
        save(s, **changes)
    assert listed(s)['items'] == []


def test_limit_edit_once_and_direction_deletion(scheduler):
    s, now = scheduler
    direction = s.repo.directions()[0]['id']
    first = save(s, direction_ids=[direction], weekdays=[0, 0, 2])
    for i in range(9):
        save(s, time=f'09:{i + 1:02}')  # Nearby schedules are allowed.
    with pytest.raises(CommandError):
        save(s)
    save(s, id=first, weekdays=[])
    assert listed(s)['items'][0]['next_at'] == ms('2026-10-19T09:00:00')
    firing = fire(s, now, first)
    assert firing['outcome'] == 'started'
    assert not s.schedules.row(first)['enabled']
    assert s.dispatch('schedules.trigger', {'schedule_id': first, 'scheduled_at': now[0]}) == firing
    s.dispatch('schedules.delete', {'id': first})
    assert s.runs.row(firing['run_id'])
    assert not s.repo.db.execute('SELECT 1 FROM schedule_firings WHERE schedule_id=?', (first,)).fetchone()
    selected = save(s, direction_ids=[direction])
    s.dispatch('directions.delete', {'id': direction})
    assert s.schedules.row(selected)['direction_ids'] == []
    assert not s.schedules.row(selected)['enabled']


def test_fifo_replacement_cancel_stop_and_manual_start(scheduler):
    s, now = scheduler
    current = s.dispatch('runs.start', {})['run_id']
    a, b = save(s), save(s, time='09:01')
    old = fire(s, now, a)
    cancelled = fire(s, now, b, '2026-10-19T09:01:00')
    assert old['outcome'] == cancelled['outcome'] == 'waiting'
    s.dispatch('firings.cancel', {'firing_id': cancelled['id']})
    assert cancelled['id'] not in [f['id'] for f in listed(s)['firings']]
    newer = fire(s, now, a, '2026-10-20T09:00:00')
    assert s.schedules.firing(old['id'])['reason'] == 'waited_too_long'
    b_wait = fire(s, now, b, '2026-10-20T09:01:00')
    s.dispatch('runs.stop', {'run_id': current})
    s.runs.advance(lambda *a: None)
    assert s.runs.row(current)['status'] == 'stopped'
    events = []
    s.schedules.advance(lambda *e: events.append(e))
    assert s.schedules.firing(newer['id'])['outcome'] == 'started'
    assert s.schedules.firing(b_wait['id'])['outcome'] == 'waiting'
    drain(s)
    s.schedules.advance(lambda *e: events.append(e))
    assert s.schedules.firing(b_wait['id'])['outcome'] == 'started'
    drain(s)
    result = s.dispatch('runs.start', {'firing_id': old['id']})
    assert s.runs.detail({'run_id': result['run_id']})['trigger']['source'] == 'manual'
    assert s.schedules.firing(old['id'])['outcome'] == 'started'
    assert ('schedules.updated', {}) in events


def test_missed_aggregation_delete_watermark_and_edit(scheduler):
    s, now = scheduler
    identifier = save(s)
    now[0] = ms('2026-10-22T10:00:00')
    s.dispatch('internal.schedules_check', {'reason': 'app_closed'})
    firing = listed(s)['firings'][0]
    assert (firing['missed_count'], firing['scheduled_at'], firing['missed_since']) == (4, ms('2026-10-22T09:00:00'), ms('2026-10-19T09:00:00'))
    now[0] = ms('2026-10-25T10:00:00')
    s.dispatch('internal.schedules_check', {'reason': 'asleep'})
    firing = listed(s)['firings'][0]
    assert firing['missed_count'] == 7 and firing['reason'] == 'asleep'
    assert len(listed(s)['firings']) == 1 and s.runs.list({})['total'] == 0
    s.dispatch('firings.delete', {'firing_id': firing['id']})
    assert s.dispatch('schedules.record_missed', {'schedule_id': identifier, 'scheduled_at': firing['scheduled_at'], 'reason': 'asleep', 'missed_count': 3}) == {'ignored': True}
    save(s, id=identifier, time='08:00')
    assert listed(s)['items'][0]['next_at'] == ms('2026-10-26T08:00:00')
    s.dispatch('internal.schedules_check', {})
    assert not listed(s)['firings']
    now[0] -= 86400000
    s.dispatch('internal.schedules_check', {})
    assert s.schedules.row(identifier)['checked_at'] == ms('2026-10-25T10:00:00')


def test_once_missed_closes_and_restart_waiting_never_runs(scheduler):
    s, now = scheduler
    one = save(s, weekdays=[])
    now[0] = ms('2026-10-24T10:00:00')
    s.dispatch('internal.schedules_check', {'reason': 'app_closed'})
    assert listed(s)['firings'][0]['missed_count'] == 1
    assert not s.schedules.row(one)['enabled']
    waiting_schedule = save(s, time='11:00')
    s.dispatch('runs.start', {})
    waiting = fire(s, now, waiting_schedule, '2026-10-24T11:00:00')
    # Reconstruct the owner with the same committed DB, as after a process exit.
    s.runs.close()
    restarted = Service(s.repo.db, s.root, clock=lambda: now[0], attempt=lambda *a: outcome())
    assert restarted.schedules.firing(waiting['id'])['reason'] == 'app_closed'
    restarted.schedules.advance(lambda *a: None)
    assert restarted.runs.active() is None
    assert restarted.runs.list({})['total'] == 1
    restarted.runs.close()


def test_failed_configuration_atomic_rollback_and_retention(scheduler):
    s, now = scheduler
    identifier = save(s)
    s.dispatch('settings.save', {'cities': []})
    firing = fire(s, now, identifier)
    failed = s.runs.detail({'run_id': firing['run_id']})
    assert failed['status'] == 'failed' and failed['error']['code'] == 'VALIDATION_ERROR'
    assert failed['trigger']['source'] == 'schedule'
    with pytest.raises(CommandError, match='before tasks were created'):
        s.dispatch('runs.resume', {'run_id': firing['run_id']})
    assert s.cleanup.preview('automatic')['disabled']
    assert s.cleanup.execute('automatic')['deleted_firings'] == 0
    s.dispatch('settings.save', {'retention_days': 1})
    now[0] += 2 * 86400000
    assert s.cleanup.execute('automatic')['deleted_firings'] == 1
    assert s.schedules.row(identifier)
    # Failure in the firing update rolls back its run and task registration too.
    s.repo.db.execute("CREATE TRIGGER fail_firing BEFORE UPDATE OF outcome ON schedule_firings WHEN NEW.outcome='started' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END")
    with pytest.raises(sqlite3.IntegrityError):
        fire(s, now, identifier, '2026-10-22T09:00:00')
    assert s.runs.list({})['total'] == 0
    assert not listed(s)['firings']
    assert s.schedules.run_events == [firing['run_id']]  # The earlier committed notification only.


def test_schedule_migration_preserves_old_rows_and_rolls_back(tmp_path):
    db = sqlite3.connect(tmp_path / 'old.db')
    db.executescript('CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(4);' + ''.join((MIGRATIONS / f'{i:03}.sql').read_text() for i in range(1, 5)))
    db.execute("INSERT INTO settings VALUES ('retention_days','3')")
    db.commit()
    broken = tmp_path / 'broken'; broken.mkdir()
    (broken / '005.sql').write_text('CREATE TABLE schedules(id TEXT);\nINVALID SQL;\n')
    with pytest.raises(DatabaseError):
        migrate(db, broken)
    assert db.execute('SELECT version FROM schema_version').fetchone()[0] == 4
    assert not db.execute("SELECT name FROM sqlite_master WHERE name='schedules'").fetchone()
    migrate(db)
    assert db.execute('SELECT value_json FROM settings').fetchone()[0] == '3'
    assert db.execute('SELECT version FROM schema_version').fetchone()[0] == 6
    db.close()


def test_rescore_holds_queue_and_quit_marks_waiting(scheduler):
    s, now = scheduler
    s.dispatch('runs.start', {})
    drain(s)
    s.dispatch('settings.save', {'rubric': 'Synthetic rubric', 'model': {
        'protocol': 'chat_completions', 'base_url': 'http://localhost:9999/v1', 'model_id': 'fake'}})
    s.dispatch('internal.credentials', {'model_key': 'synthetic'})
    job_id = s.repo.db.execute('SELECT id FROM jobs').fetchone()[0]
    s.dispatch('jobs.score', {'job_ids': [job_id]})
    identifier = save(s)
    waiting = fire(s, now, identifier)
    assert waiting['outcome'] == 'waiting'
    drain(s)
    s.schedules.advance(lambda *a: None)
    assert s.schedules.firing(waiting['id'])['outcome'] == 'started'
    newer = fire(s, now, identifier, '2026-10-20T09:00:00')
    assert newer['outcome'] == 'waiting'
    s.schedules.close_waiting()
    assert s.schedules.firing(newer['id'])['reason'] == 'app_closed'
    drain(s)
    s.schedules.advance(lambda *a: None)
    assert s.runs.active() is None


def test_waiting_failure_does_not_block_next_schedule(scheduler):
    s, now = scheduler
    current = s.dispatch('runs.start', {})['run_id']
    identifier = save(s)
    other = save(s, time='09:01')
    a = fire(s, now, identifier)
    b = fire(s, now, other, '2026-10-19T09:01:00')
    s.dispatch('settings.save', {'cities': []})
    s.dispatch('runs.stop', {'run_id': current})
    s.runs.advance(lambda *a: None)
    for _ in range(2):
        s.schedules.advance(lambda *a: None)
    assert s.schedules.firing(a['id'])['outcome'] == 'started'
    assert s.schedules.firing(b['id'])['outcome'] == 'started'
    assert s.runs.list({})['items'][0]['status'] == 'failed'


def test_inflight_clock_message_after_sleep_does_not_catch_up(scheduler):
    s, now = scheduler
    save(s)
    now[0] = ms('2026-10-22T10:00:00')
    # Main sent this before suspend; it reaches the writer only on resume.
    s.dispatch('internal.schedules_check', {})
    firing = listed(s)['firings'][0]
    assert firing['outcome'] == 'not_run' and firing['reason'] == 'asleep'
    assert firing['missed_count'] == 4
    assert s.runs.active() is None


def test_live_clock_starts_on_time_once(scheduler):
    s, now = scheduler
    now[0] = ms('2026-10-19T08:59:59')
    identifier = save(s, weekdays=[])
    now[0] += 1000
    s.dispatch('internal.schedules_check', {})
    assert listed(s)['firings'][0]['outcome'] == 'started'
    assert not s.schedules.row(identifier)['enabled']
    s.dispatch('internal.schedules_check', {})
    assert s.runs.list({})['total'] == 1
    s.schedules.advance(lambda *a: None)
    drain(s)
    assert s.runs.list({})['items'][0]['status'] == 'succeeded'


def test_search_draft_clears_selected_schedules_but_preserves_all_searches(scheduler):
    s, now = scheduler
    old_direction = s.repo.directions()[0]['id']
    selected = save(s, direction_ids=[old_direction])
    disabled = save(s, direction_ids=[old_direction], enabled=False)
    all_searches = save(s, time='10:00')
    before = {item['id']: item for item in listed(s)['items']}
    content = {'directions': [{'name': 'Replacement', 'queries': [{'expression': 'new query', 'enabled': True}]}],
               'cities': [{'location': 'Toronto', 'distance_miles': 0, 'enabled': True}]}
    s.dispatch('drafts.save', {'draft_kind': 'search', 'content': content})
    assert {item['id']: item for item in listed(s)['items']} == before
    s.dispatch('drafts.apply', {'draft_kind': 'search'})
    after = {item['id']: item for item in listed(s)['items']}
    assert s.repo.directions()[0]['id'] != old_direction
    for identifier in (selected, disabled):
        assert after[identifier]['direction_ids'] == []
        assert after[identifier]['enabled'] is False
        assert after[identifier]['next_at'] is None
    assert after[all_searches] == before[all_searches]
    now[0] = ms('2026-10-19T08:59:59')
    s.dispatch('internal.schedules_check', {})
    now[0] += 1000
    s.dispatch('internal.schedules_check', {})
    assert s.runs.list({})['total'] == 0
    assert listed(s)['firings'] == []
    now[0] = ms('2026-10-19T09:59:59')
    s.dispatch('internal.schedules_check', {})
    now[0] += 1000
    s.dispatch('internal.schedules_check', {})
    s.schedules.advance(lambda *a: None)
    drain(s)
    run = s.runs.list({})['items'][0]
    assert run['status'] == 'succeeded'
    assert run['trigger']['schedule_id'] == all_searches


@pytest.mark.parametrize('kind,fail', [('search', False), ('rubric', False), ('search', True)])
def test_draft_apply_schedule_event_and_transaction_rollback(scheduler, kind, fail):
    from io import BytesIO
    from job_vaccum.service.server import serve
    from test_business_protocol import request

    s, now = scheduler
    save(s, direction_ids=[s.repo.directions()[0]['id']])
    content = {'directions': [{'name': 'Replacement', 'queries': [{'expression': 'new', 'enabled': True}]}],
               'cities': [{'location': 'Toronto', 'distance_miles': 0, 'enabled': True}]} if kind == 'search' else 'New rubric'
    s.dispatch('drafts.save', {'draft_kind': kind, 'content': content})
    before_settings, before_schedules = s.repo.settings(), listed(s)
    if fail:
        # Fail after deleting directions and clearing schedule selections; both
        # changes must roll back along with the replacement search configuration.
        s.repo.db.execute("CREATE TRIGGER fail_draft BEFORE INSERT ON directions BEGIN SELECT RAISE(ABORT,'synthetic draft failure'); END")
    output = BytesIO()
    serve(s.root, BytesIO(request('apply', 'drafts.apply', {'draft_kind': kind})), output, clock=lambda: now[0])
    messages = [json.loads(line) for line in output.getvalue().splitlines()]
    response = next(m for m in messages if m.get('id') == 'apply')
    assert response['ok'] is not fail
    events = [m for m in messages if m.get('name') == 'schedules.updated']
    assert len(events) == (1 if kind == 'search' and not fail else 0)
    if events:
        assert messages.index(response) < messages.index(events[0])
        assert events[0]['data'] == {}
    if fail or kind == 'rubric':
        assert listed(s) == before_schedules
    if fail:
        assert s.repo.settings() == before_settings
