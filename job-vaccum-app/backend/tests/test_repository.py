from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import sqlite3
from threading import Barrier

import pytest

from job_vaccum.service.protocol import CommandError
from job_vaccum.storage.database import connect, MIGRATIONS
from job_vaccum.storage.repository import Repository
from job_vaccum.storage.synthetic import fixture_id, import_synthetic

NOW = 1_800_000_000_000


@pytest.fixture
def repo(tmp_path):
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        repo = Repository(db, lambda: NOW)
        import_synthetic(repo, {'count': 125})
        yield repo


def test_upgrade_m0_preserves_settings_and_migration_002_failure(tmp_path):
    path = tmp_path / 'old.sqlite3'
    with closing(sqlite3.connect(path)) as db:
        db.executescript('CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (1);' + (MIGRATIONS / '001.sql').read_text())
        db.execute("INSERT INTO settings VALUES ('existing','true')")
        db.commit()
    broken = tmp_path / 'migrations'
    broken.mkdir()
    (broken / '002.sql').write_text('CREATE TABLE partial (id TEXT);\nINVALID SQL;\n')
    from job_vaccum.storage.database import DatabaseError, migrate
    with closing(sqlite3.connect(path)) as db:
        with pytest.raises(DatabaseError):
            migrate(db, broken)
        assert db.execute('SELECT version FROM schema_version').fetchone()[0] == 1
        assert db.execute("SELECT name FROM sqlite_master WHERE name='partial'").fetchone() is None
    with closing(connect(path)) as db:
        assert db.execute('SELECT version FROM schema_version').fetchone()[0] == 3
        assert db.execute("SELECT value_json FROM settings WHERE key='existing'").fetchone()[0] == 'true'
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []


def test_multi_direction_pagination_detail_zero_score_and_repeat_import(repo):
    all_items = []
    for page in (1, 2, 3):
        result = repo.list_jobs({'page': page, 'page_size': 50, 'direction_ids': [fixture_id(1), fixture_id(2)], 'sources': ['linkedin', 'indeed']})
        assert result['total'] == 125
        assert all('description' not in row for row in result['items'])
        all_items += result['items']
    assert len({r['id'] for r in all_items}) == len(all_items) == 125
    first = repo.detail({'job_id': fixture_id(1000)})
    assert len(first['description']) > 30_000
    assert len(first['sources']) == len(first['directions']) == len(first['queries']) == 2
    assert first['score'] is None and first['links']['job_url_direct'] is None
    zeros = repo.list_jobs({'score_min': 0, 'score_max': 0})
    assert zeros['total'] > 0 and all(row['score'] == 0 for row in zeros['items'])
    repo.add({'job_id': first['id']})
    repo.update({'job_id': first['id'], 'status': 'offer', 'notes': 'Keep this note'})
    repo.clock = lambda: NOW + 1234
    assert import_synthetic(repo, {'count': 125}) == {'added_count': 0, 'existing_count': 125}
    again = repo.detail({'job_id': first['id']})
    assert again['description'] == first['description'] and again['first_seen_at'] == NOW
    assert again['application']['status'] == 'offer'
    assert again['application']['notes'] == 'Keep this note'


def test_add_duplicate_concurrent_and_bulk_atomicity(repo, tmp_path, monkeypatch):
    identifier = fixture_id(1001)
    barrier = Barrier(2)
    def add(_):
        with closing(connect(tmp_path / 'app.sqlite3')) as db:
            local = Repository(db, lambda: NOW)
            barrier.wait(timeout=5)
            return local.add({'job_id': identifier})['outcome']
    with ThreadPoolExecutor(2) as executor:
        assert sorted(executor.map(add, range(2))) == ['added', 'already_present']
    repo.update({'job_id': identifier, 'status': 'oa', 'notes': 'Do not overwrite'})
    result = repo.add({'job_ids': [identifier, fixture_id(1002), 'missing', identifier]}, many=True)
    assert result['counts'] == {'added': 1, 'already_present': 1, 'not_found': 1}
    assert repo.application(identifier)['notes'] == 'Do not overwrite'
    assert repo.application(identifier)['status'] == 'oa'
    original = repo.clock
    def fail():
        raise RuntimeError('synthetic failure')
    monkeypatch.setattr(repo, 'clock', fail)
    with pytest.raises(RuntimeError):
        repo.add({'job_ids': [fixture_id(1003), fixture_id(1004)]}, many=True)
    assert repo.application(fixture_id(1003)) is None
    monkeypatch.setattr(repo, 'clock', original)
    # Real transaction failure after an earlier row was inserted rolls back the batch.
    repo.db.execute("CREATE TEMP TRIGGER fail_add BEFORE INSERT ON applications WHEN NEW.job_id='" + fixture_id(1004) + "' BEGIN SELECT RAISE(ABORT,'synthetic'); END")
    with pytest.raises(sqlite3.IntegrityError):
        repo.add({'job_ids': [fixture_id(1003), fixture_id(1004)]}, many=True)
    assert repo.application(fixture_id(1003)) is None


def test_status_remove_restore_and_score_write_preserve_notes(repo):
    identifier = fixture_id(1000)
    repo.add({'job_id': identifier})
    before = repo.update({'job_id': identifier, 'status': 'interviewing', 'notes': 'Original'})
    repo.clock = lambda: NOW + 100
    changed = repo.set_status({'job_ids': [identifier, 'missing'], 'status': 'offer'})
    assert changed['counts'] == {'updated': 1, 'not_found': 1}
    repo.update({'job_id': identifier, 'notes': 'Edited after status'})
    with repo.db:
        repo.db.execute("UPDATE jobs SET score=9,score_reason='fake success',score_state='succeeded' WHERE id=?", (identifier,))
    snapshot = {k: v for k, v in changed['items'][0].items() if k != 'outcome'}
    assert repo.restore({'items': [snapshot]})['counts']['restored'] == 1
    restored = repo.application(identifier)
    assert restored['status'] == before['status'] and restored['updated_at'] == before['updated_at']
    assert restored['notes'] == 'Edited after status'
    removed = repo.remove({'job_ids': [identifier]})
    assert removed['removed_count'] == 1 and repo.detail({'job_id': identifier})['score'] == 9
    assert repo.restore({'items': [snapshot]})['counts']['not_found'] == 1
    assert repo.restore({'items': removed['items']})['counts']['restored'] == 1
    assert repo.application(identifier) == removed['items'][0]
    repo.remove({'job_ids': [identifier]})
    repo.clock = lambda: NOW + 999
    repo.add({'job_id': identifier})
    assert repo.application(identifier) == {'job_id': identifier, 'status': 'new', 'notes': '', 'added_at': NOW + 999, 'updated_at': NOW + 999}
    with repo.db:
        repo.db.execute('DELETE FROM jobs WHERE id=?', (identifier,))
    assert repo.restore({'items': removed['items']})['counts']['not_found'] == 1
    assert repo.db.execute('SELECT count(*) FROM job_identities WHERE job_id=?', (identifier,)).fetchone()[0] == 0
    assert repo.db.execute('PRAGMA foreign_key_check').fetchall() == []


def test_direction_rename_reorder_delete_and_query_delete(repo):
    first = repo.detail({'job_id': fixture_id(1000)})
    repo.direction_save({'id': fixture_id(1), 'name': 'Renamed'})
    repo.direction_reorder({'ids': [fixture_id(2), fixture_id(1)]})
    updated = repo.detail({'job_id': first['id']})
    assert [d['name'] for d in updated['directions']] == ['Data', 'Renamed']
    assert updated['description'] == first['description'] and updated['score'] == first['score']
    repo.query_delete({'id': fixture_id(12)})
    assert len(repo.detail({'job_id': first['id']})['queries']) == 2
    repo.direction_delete({'id': fixture_id(2)})
    updated = repo.detail({'job_id': first['id']})
    assert [d['name'] for d in updated['directions']] == ['Renamed']
    assert len(updated['queries']) == 1 and updated['queries'][0]['direction_id'] == fixture_id(1)
    assert len(updated['sources']) == 2
    new = repo.direction_save({'name': 'New direction'})
    query = repo.query_save({'direction_id': new['id'], 'expression': 'Engineer'})
    assert repo.query_save({'id': query['id'], 'expression': 'Developer', 'enabled': False})['enabled'] is False
    with pytest.raises(CommandError):
        repo.direction_reorder({'ids': [new['id']]})
    assert repo.list_jobs({})['total'] == 125


@pytest.mark.parametrize('params', [
    {'sort': 'score; DROP TABLE jobs'}, {'sort': 'status_asc'}, {'scope': 'applications', 'in_applications': False},
    {'page': True}, {'page': 0}, {'page_size': 201}, {'score_min': -1}, {'score_max': 11},
    {'score_min': 7, 'score_max': 2}, {'score_states': ['unknown']}, {'companies': 'a'}, {'sources': [False]},
    {'date_posted_unknown': True, 'date_posted_from': '2026-01-01'}, {'date_posted_to': '2026-99-99'},
    {'first_seen_from': 2, 'first_seen_to': 1}, {'application_statuses': []}, {'added_from': 0},
    {'salary_min': 1}, {'salary_min': float('inf'), 'salary_currency': 'USD', 'salary_interval': 'yearly'},
    {'salary_min': 5, 'salary_max': 1, 'salary_currency': 'USD', 'salary_interval': 'yearly'},
    {'unexpected': 'field'}, {'scope': []},
])
def test_filter_validation_rejects_invalid_params(repo, params):
    with pytest.raises(CommandError):
        repo.list_jobs(params)


def test_filter_dimensions_and_stable_null_last_sort(repo):
    # Assign concrete boundaries, nulls, old scores on failed operations, and salary intervals.
    with repo.db:
        repo.db.execute('DELETE FROM jobs WHERE id NOT IN (?,?,?)', [fixture_id(i) for i in (1000, 1001, 1002)])
        repo.db.execute("UPDATE jobs SET company='A_100%',location='Chicago',job_type='fulltime',date_posted='2026-10-18',first_seen_at=?,score=0,score_state='failed',salary_min=0,salary_max=NULL,salary_currency='USD',salary_interval='yearly' WHERE id=?", (NOW, fixture_id(1000)))
        repo.db.execute("UPDATE jobs SET company='B',date_posted=NULL,score=NULL,score_state='unscored',salary_min=NULL,salary_max=NULL WHERE id=?", (fixture_id(1001),))
        repo.db.execute("UPDATE jobs SET company='B',date_posted='2026-10-19',score=8,salary_min=50,salary_max=100,salary_currency='USD',salary_interval='hourly' WHERE id=?", (fixture_id(1002),))
    params = {'text': '_100%', 'companies': ['A_100%', 'other'], 'locations': ['Chicago'],
              'job_types': ['fulltime'], 'direction_ids': [fixture_id(1), fixture_id(2)], 'sources': ['indeed'],
              'score_min': 0, 'score_max': 0, 'score_states': ['failed'],
              'first_seen_from': NOW, 'first_seen_to': NOW + 1, 'date_posted_from': '2026-10-18',
              'date_posted_to': '2026-10-19', 'date_posted_unknown': False, 'salary_presence': 'known',
              'salary_min': 0, 'salary_max': 100000, 'salary_currency': 'USD', 'salary_interval': 'yearly', 'in_applications': False}
    assert repo.list_jobs(params)['total'] == 1
    repo.add({'job_id': fixture_id(1000)})
    assert repo.list_jobs(params)['total'] == 0
    assert repo.list_jobs({'date_posted_unknown': True})['total'] == 1
    assert repo.list_jobs({'salary_presence': 'unknown'})['total'] == 1
    for sort in ('score_asc', 'score_desc', 'date_posted_asc', 'date_posted_desc'):
        assert repo.list_jobs({'sort': sort})['items'][-1]['id'] == fixture_id(1001)
    assert [row['id'] for row in repo.list_jobs({'sort': 'company_desc'})['items']][:2] == [fixture_id(1001), fixture_id(1002)]
    repo.update({'job_id': fixture_id(1000), 'status': 'offer', 'notes': 'hi'})
    assert repo.list_jobs({'scope': 'applications', 'application_statuses': ['offer'],
                           'added_from': NOW, 'added_to': NOW + 1, 'updated_from': NOW,
                           'updated_to': NOW + 1, 'sort': 'status_asc'})['total'] == 1


def test_concurrent_status_notes_and_fixed_status_order(repo, tmp_path):
    identifiers = [fixture_id(1000 + i) for i in range(7)]
    repo.add({'job_ids': identifiers}, many=True)
    barrier = Barrier(2)
    def edit(which):
        with closing(connect(tmp_path / 'app.sqlite3')) as db:
            local = Repository(db, lambda: NOW + 1)
            barrier.wait(timeout=5)
            if which == 'status':
                return local.set_status({'job_ids': identifiers, 'status': 'offer'})
            return local.update({'job_id': identifiers[0], 'notes': 'Concurrent edit'})
    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(edit, ('status', 'notes')))
    assert results[0]['counts']['updated'] == 7
    assert repo.application(identifiers[0])['status'] == 'offer'
    assert repo.application(identifiers[0])['notes'] == 'Concurrent edit'
    from job_vaccum.storage.filters import STATUSES
    for identifier, status in zip(reversed(identifiers), STATUSES):
        repo.update({'job_id': identifier, 'status': status})
    assert [row['application']['status'] for row in repo.list_jobs({'scope': 'applications', 'sort': 'status_asc'})['items']] == list(STATUSES)
    assert [row['application']['status'] for row in repo.list_jobs({'scope': 'applications', 'sort': 'status_desc'})['items']] == list(reversed(STATUSES))
    with pytest.raises(sqlite3.IntegrityError), repo.db:
        repo.db.execute("UPDATE applications SET status='invalid'")
    with pytest.raises(sqlite3.IntegrityError), repo.db:
        repo.db.execute('UPDATE jobs SET score=1.5')
