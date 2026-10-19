from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import csv
import os
from pathlib import Path
from threading import Barrier

import pytest

from job_vaccum.service.protocol import CommandError
from job_vaccum.storage.cleanup import Cleanup, DAY
from job_vaccum.storage.database import connect
from job_vaccum.storage.export import export_csv
from job_vaccum.storage.repository import Repository
from job_vaccum.storage.synthetic import import_synthetic, fixture_id
from test_repository import NOW


@pytest.fixture
def setup(tmp_path):
    (tmp_path / 'logs').mkdir()
    (tmp_path / 'tmp').mkdir()
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        repo = Repository(db, lambda: NOW)
        import_synthetic(repo, {'count': 125})
        yield repo, Cleanup(repo, tmp_path), tmp_path


def age(repo, days):
    with repo.db:
        repo.db.execute('UPDATE jobs SET first_seen_at=?', (NOW - days * DAY,))


def touch_at(path, milliseconds):
    path.write_text('synthetic file')
    os.utime(path, ns=(milliseconds * 1_000_000, milliseconds * 1_000_000))


def test_cleanup_strict_cutoff_protection_remove_and_identity_cascade(setup):
    repo, cleanup, root = setup
    age(repo, 30)
    protected = fixture_id(1000)
    repo.add({'job_id': protected})
    repo.update({'job_id': protected, 'status': 'oa', 'notes': 'Protected'})
    original = repo.detail({'job_id': protected})
    with repo.db:
        repo.db.execute('UPDATE jobs SET first_seen_at=? WHERE id=?', (NOW - 14 * DAY, fixture_id(1001)))
    preview = cleanup.preview('automatic')
    assert preview['jobs'] == 123 and preview['applications'] == 1
    assert cleanup.execute('automatic')['deleted_jobs'] == 123
    assert repo.detail({'job_id': protected}) == original
    assert repo.list_jobs({})['total'] == 2
    assert cleanup.execute('manual')['deleted_jobs'] == 1
    assert repo.detail({'job_id': protected}) == original
    repo.remove({'job_ids': [protected]})
    assert repo.list_jobs({})['total'] == 1
    assert cleanup.execute('automatic')['deleted_jobs'] == 1
    assert repo.db.execute('SELECT count(*) FROM job_identities').fetchone()[0] == 0
    assert repo.db.execute('SELECT count(*) FROM job_directions').fetchone()[0] == 0
    assert repo.db.execute('PRAGMA foreign_key_check').fetchall() == []
    assert len(repo.settings()['directions']) == 2
    assert import_synthetic(repo, {'count': 1})['added_count'] == 1


def test_retention_save_restart_zero_and_next_check_uses_current_setting(setup):
    repo, cleanup, root = setup
    age(repo, 30)
    log = root / 'logs' / 'old.log'
    touch_at(log, NOW - 40 * DAY)
    assert repo.settings()['retention_days'] == 14
    for value in (-1, 1.2, '14', None, True):
        with pytest.raises(CommandError):
            repo.save_settings({'retention_days': value})
    repo.save_settings({'retention_days': 0})
    with closing(connect(root / 'app.sqlite3')) as db:
        assert Repository(db).settings()['retention_days'] == 0
    assert cleanup.preview('automatic')['disabled'] is True
    assert cleanup.execute('automatic')['deleted_jobs'] == 0 and log.exists()
    repo.save_settings({'retention_days': 40})
    assert repo.list_jobs({})['total'] == 125
    assert cleanup.execute('automatic')['deleted_jobs'] == 0
    # Strict file cutoff as well.
    assert log.exists()
    repo.save_settings({'retention_days': 20})
    assert repo.list_jobs({})['total'] == 125
    assert cleanup.execute('automatic')['deleted_jobs'] == 125 and not log.exists()
    repo.save_settings({'retention_days': 100})
    assert repo.list_jobs({})['total'] == 0
    import_synthetic(repo, {'count': 1})
    repo.save_settings({'retention_days': 0})
    assert cleanup.execute('manual')['deleted_jobs'] == 1


def test_stale_preview_rechecks_application_and_concurrent_cleanup_add(setup):
    repo, cleanup, root = setup
    assert cleanup.preview('manual')['jobs'] == 125
    identifier = fixture_id(1000)
    repo.add({'job_id': identifier})
    assert cleanup.execute('manual')['deleted_jobs'] == 124
    assert repo.detail({'job_id': identifier})['description']
    repo.remove({'job_ids': [identifier]})
    barrier = Barrier(2)
    def run(which):
        with closing(connect(root / 'app.sqlite3')) as db:
            local = Repository(db, lambda: NOW)
            barrier.wait(timeout=5)
            return local.add({'job_id': identifier}) if which == 'add' else Cleanup(local, root).execute('manual')
    with ThreadPoolExecutor(2) as executor:
        added, cleaned = list(executor.map(run, ('add', 'cleanup')))
    if added['outcome'] == 'added':
        assert cleaned['deleted_jobs'] == 0 and repo.application(identifier)
    else:
        assert added['outcome'] == 'not_found' and cleaned['deleted_jobs'] == 1
    assert repo.db.execute('PRAGMA foreign_key_check').fetchall() == []


def test_file_failure_commits_database_and_preserves_external_files(setup, monkeypatch):
    repo, cleanup, root = setup
    outside = root.parent / (root.name + '-user-export.csv')
    outside.write_text('keep external CSV')
    link = root / 'tmp' / 'linked-directory'
    link.symlink_to(outside.parent, target_is_directory=True)
    bad = root / 'logs' / 'locked.log'
    bad.write_text('fake inaccessible file')
    original_unlink = Path.unlink
    def unlink(path, *args, **kwargs):
        if path == bad:
            raise PermissionError('synthetic failure')
        return original_unlink(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', unlink)
    result = cleanup.execute('manual')
    assert result['deleted_jobs'] == 125
    assert result['failed_files'] == ['logs/locked.log']
    assert bad.exists() and not link.exists() and outside.read_text() == 'keep external CSV'
    assert repo.list_jobs({})['total'] == 0


def test_expiration_checks_nested_file_age_and_no_symlink_traversal(setup):
    repo, cleanup, root = setup
    nested = root / 'logs' / 'nested'
    nested.mkdir()
    touch_at(nested / 'old.log', NOW - 15 * DAY)
    touch_at(nested / 'new.log', NOW)
    os.utime(nested, ns=((NOW - 20 * DAY) * 1_000_000,) * 2)
    cleanup.execute('automatic')
    assert not (nested / 'old.log').exists() and (nested / 'new.log').exists()
    assert repo.list_jobs({})['total'] == 125


def test_csv_all_pages_multidirection_bom_full_jd_optional_and_applications(setup):
    repo, cleanup, root = setup
    destination = root.parent / (root.name + '-export.csv')
    params = {'scope': 'discover', 'range': 'filtered', 'filter': {'direction_ids': [fixture_id(1), fixture_id(2)], 'sort': 'title_asc'}, 'include_jd': True, 'destination_path': str(destination)}
    assert export_csv(root / 'app.sqlite3', params)['row_count'] == 125
    assert destination.read_bytes().startswith(b'\xef\xbb\xbf')
    with destination.open(encoding='utf-8-sig', newline='') as file:
        rows = list(csv.DictReader(file))
    assert len({r['id'] for r in rows}) == 125
    assert rows[0]['directions'] == 'Software; Data'
    assert rows[0]['sources'] == 'linkedin; indeed'
    assert rows[0]['description'] == repo.detail({'job_id': rows[0]['id']})['description']
    assert 'scored_at' in rows[0] and rows[0]['salary_min'] == '0.0'
    assert rows[0]['first_seen_at'].endswith('+00:00')
    assert any(row['score'] == '0' for row in rows)
    repo.add({'job_id': fixture_id(1000)})
    repo.update({'job_id': fixture_id(1000), 'status': 'oa', 'notes': 'Comma, quote " and\nnew line 合成'})
    params.update(scope='applications', filter={'application_statuses': ['oa']}, include_jd=False)
    assert export_csv(root / 'app.sqlite3', params)['row_count'] == 1
    with destination.open(encoding='utf-8-sig', newline='') as file:
        row = next(csv.DictReader(file))
    assert row['notes'] == 'Comma, quote " and\nnew line 合成' and row['status'] == 'oa'
    assert 'description' not in row and row['added_at'].endswith('+00:00')
    params.update(scope='discover', filter={'text': 'not present'}, range='filtered')
    assert export_csv(root / 'app.sqlite3', params)['row_count'] == 0
    params['range'] = 'all'
    assert export_csv(root / 'app.sqlite3', params)['row_count'] == 125
    params['filter'] = {'scope': 'applications'}
    with pytest.raises(CommandError):
        export_csv(root / 'app.sqlite3', params)
