"""M4 / R01–R16 backend boundaries with real crash/restart and synthetic I/O."""
from contextlib import closing
import json
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import threading
import time

import pytest

from job_vaccum.pipeline.configuration import PARAMETERS
from job_vaccum.pipeline.scraper import retrieve
from job_vaccum.service.protocol import CommandError
from job_vaccum.storage.database import connect
from test_pipeline import configure, detail, drain, ERROR, outcome, record, service, start


class Peer:
    def __init__(self, root, mode):
        self.root = root
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('recovery_peer.py')),
            mode, '--data-dir', str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0)
        self.number = 0
        assert self.read()['name'] == 'ready'

    def read(self, timeout=5):
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            assert selector.select(timeout), 'Service output timed out'
        line = self.process.stdout.readline()
        assert line, f'Service exited: {self.process.poll()}'
        return json.loads(line)

    def call(self, method, params=None):
        self.number += 1
        identifier = str(self.number)
        self.process.stdin.write((json.dumps({'type': 'request', 'id': identifier, 'method': method,
                                             'params': params or {}}) + '\n').encode())
        while True:
            message = self.read()
            if message.get('id') == identifier:
                return message

    def result(self, method, params=None):
        response = self.call(method, params)
        assert response['ok'], response
        return response['result']

    def finished(self, status='succeeded'):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            message = self.read()
            if message.get('name') == 'run.updated' and message['data']['status'] == status:
                return
        pytest.fail('Run did not finish')

    def calls(self):
        file = self.root.parent / (self.root.name + '-calls.jsonl')
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def wait_call(self, kind):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            found = [c for c in self.calls() if c['kind'] == kind]
            if found:
                return found[-1]
            time.sleep(0.01)
        pytest.fail(f'No {kind} call')

    def configure(self):
        self.result('internal.credentials', {'model_key': 'synthetic-original-key'})
        self.result('settings.save', {'auto_score_enabled': True, 'rubric': 'Original rubric',
            'retention_days': 0, 'cities': [{'location': 'Chicago', 'distance_miles': 25, 'enabled': True}],
            'platforms': ['indeed', 'linkedin'],
            'model': {'protocol': 'chat_completions', 'base_url': 'http://127.0.0.1:1/v1', 'model_id': 'original'}})
        direction = self.result('directions.save', {'name': 'Synthetic search'})['id']
        self.result('queries.save', {'direction_id': direction, 'expression': 'engineer'})

    def dispose(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


@pytest.fixture
def peers(tmp_path):
    opened = []
    def launch(mode='normal'):
        peer = Peer(tmp_path / 'data', mode)
        opened.append(peer)
        return peer
    yield launch
    for peer in opened:
        peer.dispose()


@pytest.mark.parametrize('fault', ['register_before', 'register_after', 'batch_before_commit',
    'batch_after_commit', 'score_dispatch', 'score_before_commit', 'score_after_commit'])
def test_hard_crash_transactions_and_resume(peers, fault):
    """R05/06/07/13: actual os._exit, no finally/explicit rollback."""
    first = peers(fault)
    first.configure()
    run = first.result('runs.start')['run_id']
    assert first.process.wait(timeout=6) == 73
    batch_saved = fault in ('batch_after_commit', 'score_dispatch', 'score_before_commit', 'score_after_commit')
    score_saved = fault == 'score_after_commit'
    with closing(connect(first.root / 'app.sqlite3')) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        tasks_before = db.execute('SELECT id,kind,status,attempt_count FROM run_tasks ORDER BY kind,stable_order').fetchall()
        assert db.execute('SELECT count(*) FROM jobs').fetchone()[0] == (2 if batch_saved else 0)
        assert sum(t[1] == 'score' for t in tasks_before) == (2 if batch_saved else 0)
        assert sum(t[1] == 'retrieval' and t[2] == 'succeeded' for t in tasks_before) == int(batch_saved)
        assert sum(t[1] == 'score' and t[2] == 'succeeded' for t in tasks_before) == int(score_saved)
        assert db.execute("SELECT count(*) FROM jobs WHERE score_state='succeeded'").fetchone()[0] == int(score_saved)
        snapshot = db.execute('SELECT config_snapshot_json FROM runs').fetchone()[0]
        if batch_saved:
            stats = json.loads(db.execute('SELECT stats_json FROM runs').fetchone()[0])
            assert stats['new_job_count'] == stats['scoring']['total'] == 2
        assert not list((first.root / 'tmp').iterdir())
    old_calls = first.calls()
    restarted = peers()
    recovered = restarted.result('runs.detail', {'run_id': run})
    assert recovered['status'] == 'interrupted'
    assert recovered['stats']['retrieval']['active'] == recovered['stats']['scoring']['active'] == 0
    assert not restarted.result('app.status')['active_run']
    assert [t['id'] for t in recovered['tasks']] == [t[0] for t in tasks_before]
    restarted.result('internal.credentials', {'model_key': 'synthetic-corrected-key'})
    restarted.result('settings.save', {'auto_score_enabled': False, 'rubric': 'Changed rubric',
        'cities': [], 'model': {'protocol': 'responses', 'base_url': 'http://127.0.0.1:2', 'model_id': 'changed'}})
    assert restarted.result('runs.resume', {'run_id': run}) == {'run_id': run}
    restarted.finished()
    recovered = restarted.result('runs.detail', {'run_id': run})
    assert recovered['status'] == 'succeeded' and recovered['new_job_count'] == 2
    assert json.loads(snapshot) == recovered['config_snapshot']
    calls = restarted.calls()[len(old_calls):]
    assert sum(c['kind'] == 'scrape' for c in calls) == (1 if batch_saved else 2)
    model_calls = [c for c in calls if c['kind'] == 'model']
    assert len(model_calls) == (1 if score_saved else 2)
    assert all(c['model'] == 'original' and c['key'] == 'synthetic-corrected-key'
               and c['system'].startswith('Original rubric') for c in model_calls)
    for old_id, _, status, attempts in tasks_before:
        task = next(t for t in recovered['tasks'] if t['id'] == old_id)
        if status == 'succeeded':
            assert task['attempt_count'] == attempts
    assert all(j['score'] == 0 for j in restarted.result('jobs.list')['items'])
    assert restarted.result('app.ping', {'message': 'alive'}) == {'message': 'alive'}


def test_explicit_resume_renews_full_finite_budgets_and_preserves_success(service, monkeypatch):
    """R03/08: three attempts per explicit resume, cumulative attempts 3/6/9."""
    s = configure(service, scoring=True)
    monkeypatch.setitem(PARAMETERS, 'retry_base_seconds', 0)
    from job_vaccum.llm.fake import FakeLlm
    s.llm.transport = FakeLlm('invalid')
    s.runs.attempt = lambda spec, *args: outcome([record(site=spec['site'])], ERROR if spec['site'] == 'linkedin' else None)
    run = start(s)
    drain(s)
    first = detail(s, run)
    succeeded = next(t['id'] for t in first['tasks'] if t['status'] == 'succeeded')
    ids = {t['id'] for t in first['tasks']}
    for expected in (6, 9):
        assert s.runs.active() is None
        assert s.inbox.empty()  # no autonomous retry after budget exhaustion
        s.dispatch('runs.resume', {'run_id': run})
        drain(s)
        d = detail(s, run)
        assert d['status'] == 'partial' and {t['id'] for t in d['tasks']} == ids
        assert all(t['attempt_count'] == (1 if t['id'] == succeeded else expected) for t in d['tasks'])
        assert d['stats']['received_count'] == 2 and d['new_job_count'] == 1
    s.llm.transport = FakeLlm()
    s.runs.attempt = lambda *args: outcome([record()])
    s.dispatch('runs.resume', {'run_id': run})
    drain(s)
    assert detail(s, run)['status'] == 'succeeded'
    assert all(t['attempt_count'] == (1 if t['id'] == succeeded else 10) for t in detail(s, run)['tasks'])
    new_run = start(s)
    assert new_run != run and detail(s, run)['status'] == 'succeeded'
    drain(s)


def test_scrape_cancel_after_blocked_notification_sends_nothing():
    """Same send-boundary cancellation as R15, also for retrieval."""
    stop, notified, release = threading.Event(), threading.Event(), threading.Event()
    calls, results = [], []
    def notify():
        notified.set()
        assert release.wait(3)
    thread = threading.Thread(target=lambda: results.append(retrieve({}, PARAMETERS, None, stop,
        lambda *args: calls.append(args), notify)))
    thread.start()
    try:
        assert notified.wait(3)
        stop.set()
    finally:
        release.set()
        thread.join(3)
    assert not thread.is_alive() and not calls
    assert results[0]['error']['code'] == 'CANCELLED' and results[0]['attempts'] == 0


@pytest.mark.parametrize('ending', ['eof', 'sigterm'])
def test_shutdown_saves_inflight_success_and_cancels_unsent(peers, ending):
    peer = peers('slow_model')
    peer.configure()
    run = peer.result('runs.start')['run_id']
    peer.wait_call('model')
    if ending == 'eof':
        peer.process.stdin.close()
    else:
        peer.process.send_signal(signal.SIGTERM)
    assert peer.process.wait(timeout=5) == 0
    restored = peers()
    d = restored.result('runs.detail', {'run_id': run})
    assert d['status'] == 'stopped' and d['stats']['scoring']['succeeded'] == 1
    assert d['stats']['scoring']['cancelled'] == 1
    assert sum(c['kind'] == 'model' for c in peer.calls()) == 1


@pytest.mark.parametrize('ending', ['eof', 'sigterm'])
def test_shutdown_has_deadline_for_hung_llm_and_recovers(peers, ending):
    peer = peers('hang_model')
    peer.configure()
    run = peer.result('runs.start')['run_id']
    peer.wait_call('model')
    before = time.monotonic()
    if ending == 'eof':
        peer.process.stdin.close()
    else:
        peer.process.send_signal(signal.SIGTERM)
    assert peer.process.wait(timeout=13) == 0
    assert 9 <= time.monotonic() - before < 13
    assert b'SHUTDOWN_TIMEOUT' in peer.process.stderr.read()
    restored = peers()
    d = restored.result('runs.detail', {'run_id': run})
    assert d['status'] == 'interrupted' and d['stats']['scoring']['active'] == 0
    restored.result('internal.credentials', {'model_key': 'synthetic-key'})
    restored.result('runs.resume', {'run_id': run})
    restored.finished()
    assert restored.result('runs.detail', {'run_id': run})['stats']['scoring']['succeeded'] == 2


def assert_dead(pid):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            import os
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.02)
    pytest.fail(f'Owned worker {pid} remained alive')


@pytest.mark.parametrize('quit_service', [False, True], ids=['stop', 'quit'])
def test_hung_scrape_is_killed_within_bound(peers, quit_service):
    peer = peers('hang_scrape')
    peer.configure()
    run = peer.result('runs.start')['run_id']
    child = peer.wait_call('child')['pid']
    before = time.monotonic()
    try:
        if quit_service:
            peer.process.stdin.close()
            assert peer.process.wait(timeout=14) == 0
            restored = peers()
            assert restored.result('runs.detail', {'run_id': run})['status'] in ('interrupted', 'stopped')
        else:
            peer.result('runs.stop', {'run_id': run})
            assert peer.result('app.status')['active_run']['status'] == 'stopping'
            assert peer.call('runs.start')['error']['code'] == 'BUSY'
            deadline = time.monotonic() + 14
            while True:
                assert time.monotonic() < deadline
                msg = peer.read(timeout=14)
                if msg.get('name') == 'run.updated' and msg['data']['status'] == 'stopped':
                    break
            assert peer.result('app.ping', {'message': 'alive'})['message'] == 'alive'
        assert time.monotonic() - before < 14
        assert_dead(child)
    finally:
        import os
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_worker_crash_is_finite_and_service_remains_responsive(peers):
    peer = peers('worker_crash')
    peer.configure()
    peer.result('settings.save', {'platforms': ['linkedin']})
    run = peer.result('runs.start')['run_id']
    peer.finished('failed')
    task = peer.result('runs.detail', {'run_id': run})['tasks'][0]
    assert task['attempt_count'] == 3 and task['error']['code'] == 'WORKER_EXITED'
    assert len(peer.calls()) == 3
    assert peer.result('app.ping', {'message': 'alive'})['message'] == 'alive'


def test_stop_both_pipelines_and_resume_scores_before_remaining_scrape(service):
    """R04/09/10/11/12: hold both I/O paths, inspect the live DB, stop, resume."""
    from job_vaccum.llm.fake import FakeLlm
    s = configure(service, scoring=True)
    scraping, scoring, release_scrape, release_score = [threading.Event() for _ in range(4)]
    calls = []
    def attempt(spec, *args):
        calls.append(spec['site'])
        if len(calls) >= 2:
            scraping.set()
            assert release_scrape.wait(5)
        return outcome([record(site=spec['site']), record('other', title='Other Engineer', description='Other JD')])
    s.runs.attempt = attempt
    s.llm.transport = FakeLlm(entered=scoring, release=release_score)
    run = start(s)
    try:
        drain(s, until=lambda: detail(s, run)['stats']['retrieval']['succeeded'] == 1)
        assert scraping.wait(3) and scoring.wait(3)
        # Consume the actual request notification before checking active counts.
        while not detail(s, run)['stats']['scoring']['active']:
            kind, payload = s.inbox.get(timeout=3)
            if kind.startswith('llm_'):
                s.handle_llm(kind, payload, lambda *_: None)
            else:
                s.runs.handle(kind, payload, lambda *_: None)
        job = s.dispatch('jobs.list', {})['items'][0]['id']
        s.dispatch('applications.add', {'job_id': job})
        s.dispatch('applications.update', {'job_id': job, 'notes': 'Edited during both requests'})
        assert s.dispatch('app.ping', {'message': 'alive'})['message'] == 'alive'
        with pytest.raises(CommandError) as error:
            s.dispatch('cleanup.execute', {'mode': 'manual'})
        assert error.value.code == 'BUSY'
        assert not s.repo.db.in_transaction
        s.dispatch('runs.stop', {'run_id': run})
        assert detail(s, run)['stats']['retrieval']['active'] == detail(s, run)['stats']['scoring']['active'] == 1
        for method, params in [('runs.start', {}), ('runs.resume', {'run_id': run}), ('jobs.score', {'filter': {}})]:
            with pytest.raises(CommandError) as error:
                s.dispatch(method, params)
            assert error.value.code == 'BUSY'
    finally:
        release_scrape.set()
        release_score.set()
    drain(s)
    d = detail(s, run)
    assert d['status'] == 'stopped' and d['stats']['scoring']['succeeded'] == 1
    assert len(calls) == 2 and len(s.llm.transport.calls) == 1
    release_scrape.clear()
    s.dispatch('runs.resume', {'run_id': run})
    try:
        drain(s, until=lambda: detail(s, run)['stats']['scoring']['succeeded'] == 2)
        assert detail(s, run)['status'] == 'running' and s.runs.active()['stage'] == 'retrieving'
    finally:
        release_scrape.set()
    drain(s)
    assert detail(s, run)['status'] == 'succeeded'
    assert len(calls) == 3 and len(s.llm.transport.calls) == 2
    assert s.repo.detail({'job_id': job})['application']['notes'] == 'Edited during both requests'


def test_tmp_removal_failure_does_not_invalidate_commits_and_restart_clears_it(peers):
    peer = peers('cleanup_failure')
    peer.configure()
    leftover = peer.root / 'tmp' / 'injected.tmp'
    leftover.write_text('App-owned temporary file')
    external = peer.root.parent / 'external'
    external.write_text('User-owned file')
    (peer.root / 'tmp' / 'external-link').symlink_to(external)
    run = peer.result('runs.start')['run_id']
    peer.finished()
    before = peer.result('runs.detail', {'run_id': run})
    assert before['status'] == 'succeeded' and before['new_job_count'] == 2
    assert leftover.exists()
    peer.process.stdin.close()
    assert peer.process.wait(timeout=5) == 0
    assert b'CLEANUP_ERROR' in peer.process.stderr.read()
    restored = peers()
    assert not list((restored.root / 'tmp').iterdir())
    assert external.read_text() == 'User-owned file'
    assert restored.result('runs.detail', {'run_id': run}) == before
    assert restored.result('jobs.list')['total'] == 2


def test_owner_process_crash_releases_service_and_lock(peers, tmp_path):
    """R05: the owning main process dies, leaving no main-side quit timer."""
    code = '''
import json, os, sys
from pathlib import Path
from test_recovery import Peer
peer = Peer(Path(sys.argv[1]), 'hang_model')
peer.configure()
run = peer.result('runs.start')['run_id']
peer.wait_call('model')
print(json.dumps({'pid': peer.process.pid, 'run_id': run}), flush=True)
os._exit(72)
'''
    owner = subprocess.run([sys.executable, '-c', code, str(tmp_path / 'data')],
        cwd=Path(__file__).parent, capture_output=True, timeout=6)
    assert owner.returncode == 72, owner.stderr
    info = json.loads(owner.stdout)
    try:
        deadline = time.monotonic() + 13
        import os
        while time.monotonic() < deadline:
            try:
                os.kill(info['pid'], 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            pytest.fail('Backend survived owner exit past its shutdown bound')
        restored = peers()
        assert restored.result('runs.detail', {'run_id': info['run_id']})['status'] == 'interrupted'
        assert restored.result('app.status')['active_run'] is None
    finally:
        try:
            os.kill(info['pid'], signal.SIGKILL)
        except ProcessLookupError:
            pass
