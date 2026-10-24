from contextlib import closing
from io import BytesIO
import json
import queue
import sqlite3
import threading

import pytest

from job_vaccum.service.server import serve
from job_vaccum.storage.cleanup import Cleanup, DAY
from job_vaccum.storage.database import connect
from job_vaccum.storage.repository import Repository
from job_vaccum.storage.synthetic import fixture_id, import_synthetic
from test_business_protocol import request
from test_repository import NOW


def score_run(db, identifier, created_at, jobs, statuses=None):
    db.execute("INSERT INTO runs(id,kind,status,created_at,started_at,config_snapshot_json) VALUES (?,'rescore','stopped',?,?,'{}')",
               (identifier, created_at, created_at))
    for index, job_id in enumerate(jobs):
        db.execute("INSERT INTO run_tasks(id,run_id,kind,stable_order,spec_json,status) VALUES (?,?,'score',?,?,?)",
                   (f'{identifier}-{index}', identifier, index, json.dumps({'job_id': job_id}),
                    statuses[index] if statuses else 'cancelled'))


@pytest.fixture
def setup(tmp_path):
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        repo = Repository(db, lambda: NOW)
        import_synthetic(repo, {'count': 5})
        ids = [fixture_id(1000 + index) for index in range(5)]
        repo.add({'job_ids': ids}, many=True)
        with db:
            db.execute("UPDATE jobs SET first_seen_at=?,score=NULL,score_reason=NULL,scored_at=NULL,score_model=NULL,score_state='pending',last_score_error=NULL",
                       (NOW - 30 * DAY,))
            for job_id, score in zip(ids[1:3], (0, 7)):
                db.execute("UPDATE jobs SET score=?,score_reason='Previous fit',scored_at=?,score_model='old-model' WHERE id=?",
                           (score, NOW - 20 * DAY, job_id))
            db.execute("UPDATE jobs SET score_state='failed',last_score_error='Previous failure' WHERE id=?", (ids[3],))
            db.execute("UPDATE jobs SET score_state='succeeded',score=4 WHERE id=?", (ids[4],))
            score_run(db, 'expired', NOW - 15 * DAY, ids)
        yield repo, Cleanup(repo, tmp_path), ids


@pytest.mark.parametrize('mode', ['manual', 'automatic'])
def test_cleanup_pending_without_tasks_restores_last_result_and_preserves_shortlist(setup, mode):
    repo, cleanup, ids = setup
    before = [repo.detail({'job_id': job_id}) for job_id in ids]
    result = cleanup.execute(mode)
    assert result['deleted_jobs'] == 0 and result['deleted_runs'] == 1
    assert repo.db.execute('SELECT count(*) FROM run_tasks').fetchone()[0] == 0
    for job_id, expected, state in zip(ids, before, ('unscored', 'succeeded', 'succeeded', 'failed', 'succeeded')):
        expected['score_state'] = state
        assert repo.detail({'job_id': job_id}) == expected


def test_cleanup_pending_preserves_surviving_unfinished_tasks_and_retention_zero(setup):
    repo, cleanup, ids = setup
    with repo.db:
        repo.db.execute("UPDATE jobs SET score_state='pending',last_score_error=NULL,first_seen_at=?", (NOW,))
        score_run(repo.db, 'retained', NOW - 14 * DAY, ids, ['pending', 'running', 'failed', 'cancelled', 'succeeded'])
    # A recent, non-shortlisted job is protected by the automatic age cutoff too.
    repo.remove({'job_ids': [ids[4]]})
    repo.save_settings({'retention_days': 0})
    assert cleanup.execute('automatic')['deleted_runs'] == 0
    assert all(repo.detail({'job_id': job_id})['score_state'] == 'pending' for job_id in ids)
    repo.save_settings({'retention_days': 14})
    assert cleanup.execute('automatic')['deleted_runs'] == 1
    assert [repo.detail({'job_id': job_id})['score_state'] for job_id in ids] == ['pending'] * 4 + ['succeeded']
    assert repo.db.execute('SELECT count(*) FROM run_tasks').fetchone()[0] == 5


def test_cleanup_pending_state_update_and_deletions_are_one_transaction(setup):
    repo, cleanup, ids = setup
    repo.remove({'job_ids': [ids[4]]})
    with repo.db:
        repo.db.execute("CREATE TRIGGER fail_cleanup_state BEFORE UPDATE OF score_state ON jobs BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END")
    with pytest.raises(sqlite3.IntegrityError, match='synthetic write failure'):
        cleanup.execute('manual')
    assert repo.db.execute('SELECT count(*) FROM jobs').fetchone()[0] == 5
    assert repo.db.execute('SELECT count(*) FROM runs').fetchone()[0] == 1
    assert repo.db.execute('SELECT count(*) FROM run_tasks').fetchone()[0] == 5
    assert repo.detail({'job_id': ids[0]})['score_state'] == 'pending'


def test_startup_cleanup_pending_is_normalized_before_first_query(setup, tmp_path):
    _, _, ids = setup
    output = BytesIO()
    serve(tmp_path, BytesIO(request('detail', 'jobs.detail', {'job_id': ids[1]})), output, clock=lambda: NOW)
    messages = [json.loads(line) for line in output.getvalue().splitlines()]
    result = next(m['result'] for m in messages if m.get('id') == 'detail')
    assert result['score_state'] == 'succeeded' and result['score'] == 0


def test_periodic_cleanup_pending_notifies_jobs_when_only_runs_are_deleted(setup, tmp_path):
    repo, _, ids = setup
    with repo.db:
        repo.db.execute('UPDATE runs SET created_at=?', (NOW - 13 * DAY,))
    inputs, outputs = queue.Queue(), queue.Queue()
    current, errors = [NOW], []

    class Input:
        def readline(self, _):
            return inputs.get(timeout=10)

    class Output:
        def write(self, data):
            outputs.put(json.loads(data))

        def flush(self):
            pass

    def service():
        try:
            serve(tmp_path, Input(), Output(), clock=lambda: current[0], cleanup_interval=0.02)
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=service)
    thread.start()
    try:
        assert outputs.get(timeout=5)['name'] == 'ready'
        current[0] += 2 * DAY
        event = outputs.get(timeout=5)
        assert event['name'] == 'cleanup.completed'
        assert event['data']['deleted_jobs'] == 0 and event['data']['deleted_runs'] == 1
        assert outputs.get(timeout=5)['name'] == 'jobs.changed'
        inputs.put(request('detail', 'jobs.detail', {'job_id': ids[0]}))
        result = outputs.get(timeout=5)
        assert result['id'] == 'detail' and result['result']['score_state'] == 'unscored'
    finally:
        inputs.put(b'')
        thread.join(5)
    assert not thread.is_alive() and not errors
