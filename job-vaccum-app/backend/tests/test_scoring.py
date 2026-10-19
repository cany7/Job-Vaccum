from contextlib import closing
import json
import queue
import threading
import time

import pytest

from job_vaccum.llm.fake import FakeLlm
from job_vaccum.service.protocol import CommandError
from job_vaccum.service.server import Service, serve
from job_vaccum.storage.database import connect
from job_vaccum.storage.synthetic import import_synthetic
from test_pipeline import configure, record, outcome, NOW
from test_business_protocol import request


@pytest.fixture
def service(tmp_path):
    db = connect(tmp_path / 'app.sqlite3')
    s = Service(db, tmp_path, clock=lambda: NOW, attempt=lambda *args: outcome([record()]),
                llm_options={'transport': FakeLlm(), 'rpm': 600000, 'retry_base': 0})
    s.dispatch('internal.credentials', {'model_key': 'synthetic-test-key'})
    s.dispatch('settings.save', {'auto_score_enabled': False, 'rubric': 'Synthetic rubric', 'retention_days': 0,
        'model': {'protocol': 'chat_completions', 'base_url': 'http://127.0.0.1:1/v1', 'model_id': 'synthetic'}})
    yield s
    s.runs.close()
    db.close()


def pump(s, until=lambda: False, timeout=4):
    events = []
    event = lambda name, data: events.append((name, data))
    s.runs.advance(event)
    deadline = time.monotonic() + timeout
    while not until() and (s.runs.active() or s.model_operations):
        assert time.monotonic() < deadline
        kind, payload = s.inbox.get(timeout=timeout)
        if kind.startswith('llm_'): s.handle_llm(kind, payload, event)
        else: s.runs.handle(kind, payload, event)
    return events


def test_manual_fixed_filter_all_pages_independent_jobs_and_application_edits(service):
    s = service
    import_synthetic(s.repo, {'count': 205})
    ids = [j['id'] for j in s.repo.list_jobs({'page_size': 200})['items']]
    s.repo.add({'job_id': ids[0]})
    s.repo.update({'job_id': ids[0], 'notes': 'Before', 'status': 'applied'})
    started = s.dispatch('jobs.score', {'filter': {'scope': 'discover'}})
    assert started['job_count'] == 205
    import_synthetic(s.repo, {'count': 206})  # later insertion never enters the fixed set
    s.repo.update({'job_id': ids[0], 'notes': 'Edited during scoring', 'status': 'interviewing'})
    s.dispatch('settings.save', {'rubric': 'Changed', 'model': {
        'protocol': 'responses', 'base_url': 'http://127.0.0.1:2/v1', 'model_id': 'changed'}})
    pump(s)
    d = s.runs.detail({'run_id': started['run_id']})
    assert d['kind'] == 'rescore' and d['status'] == 'succeeded' and d['stats']['scoring']['succeeded'] == 205
    assert s.repo.db.execute('SELECT count(*) FROM jobs WHERE id NOT IN (SELECT job_id FROM run_jobs WHERE run_id=?)', (started['run_id'],)).fetchone()[0] == 1
    calls = s.llm.transport.calls
    assert len(calls) == 205 and all(c['model']['model_id'] == 'synthetic' for c in calls)
    assert all(c['system'].startswith('Synthetic rubric') for c in calls)
    job = s.repo.detail({'job_id': ids[0]})
    assert job['score'] == 0 and job['score_state'] == 'succeeded' and job['scored_at'] == NOW
    assert job['application']['notes'] == 'Edited during scoring' and job['application']['status'] == 'interviewing'
    assert s.runs.list({})['total'] == 0 and s.runs.list({'kind': 'rescore'})['total'] == 1
    # Shortlist filter and selected IDs both use the same entry, independent of the automatic switch.
    assert s.dispatch('jobs.score', {'filter': {'scope': 'applications'}})['job_count'] == 1
    pump(s)
    assert s.dispatch('jobs.score', {'job_ids': [ids[0], ids[0]]})['job_count'] == 1
    pump(s)


def test_repeated_equal_input_jobs_have_separate_requests_and_failed_rescore_keeps_old(service):
    s = service
    import_synthetic(s.repo, {'count': 2})
    ids = [j['id'] for j in s.repo.list_jobs({})['items']]
    with s.repo.db:
        s.repo.db.execute("UPDATE jobs SET title='Same',company='Same',description='Same JD'")
    s.dispatch('jobs.score', {'job_ids': ids})
    pump(s)
    assert len(s.llm.transport.calls) == 2
    assert s.llm.transport.calls[0]['prompt'] == s.llm.transport.calls[1]['prompt']
    before = s.repo.detail({'job_id': ids[0]})
    s.llm.transport = FakeLlm('invalid')
    run = s.dispatch('jobs.score', {'job_ids': [ids[0]]})['run_id']
    pump(s)
    after = s.repo.detail({'job_id': ids[0]})
    assert (after['score'], after['score_reason'], after['scored_at'], after['score_model']) == (before['score'], before['score_reason'], before['scored_at'], before['score_model'])
    assert after['score_state'] == 'failed' and 'invalid output' in after['last_score_error']
    assert s.runs.detail({'run_id': run})['tasks'][0]['attempt_count'] == 3
    s.llm.transport = FakeLlm(score=8)
    s.dispatch('runs.resume', {'run_id': run})
    pump(s)
    assert s.repo.detail({'job_id': ids[0]})['score'] == 8
    assert s.runs.detail({'run_id': run})['tasks'][0]['attempt_count'] == 4


def test_scoring_overlaps_next_scrape_and_does_not_duplicate_after_later_hit(service):
    s = configure(service, scoring=True)
    entered, release = threading.Event(), threading.Event()
    count = [0]
    def scraper(*args):
        count[0] += 1
        if count[0] == 2:
            entered.set()
            assert release.wait(4)
        return outcome([record(site='indeed' if count[0] == 1 else 'linkedin')])
    s.runs.attempt = scraper
    run = s.dispatch('runs.start', {})['run_id']
    try:
        pump(s, until=lambda: bool(s.repo.db.execute("SELECT 1 FROM jobs WHERE score_state='succeeded'").fetchone()))
        assert entered.wait(3)
        assert s.runs.active()['stage'] == 'retrieving'
        assert len(s.llm.transport.calls) == 1
        payload = json.loads(s.llm.transport.calls[0]['prompt'])
        assert set(payload) == {'title', 'company', 'description'}
        s.dispatch('applications.add', {'job_id': s.repo.list_jobs({})['items'][0]['id']})
        with pytest.raises(CommandError) as exc: s.dispatch('cleanup.execute', {'mode': 'manual'})
        assert exc.value.code == 'BUSY'
    finally: release.set()
    pump(s)
    assert s.runs.detail({'run_id': run})['stats']['scoring']['succeeded'] == 1
    assert len(s.llm.transport.calls) == 1


def test_stop_preserves_inflight_zero_and_resumes_only_unfinished(service):
    s = service
    import_synthetic(s.repo, {'count': 3})
    entered, release = threading.Event(), threading.Event()
    s.llm.transport = FakeLlm(entered=entered, release=release)
    run = s.dispatch('jobs.score', {'filter': {}})['run_id']
    s.runs.advance(lambda *args: None)
    assert entered.wait(3)
    s.dispatch('runs.stop', {'run_id': run})
    s.runs.advance(lambda *args: None)
    assert s.runs.active()['status'] == 'stopping'
    with pytest.raises(CommandError) as exc: s.dispatch('jobs.score', {'filter': {}})
    assert exc.value.code == 'BUSY'
    release.set()
    pump(s)
    d = s.runs.detail({'run_id': run})
    assert d['status'] == 'stopped' and d['stats']['scoring']['succeeded'] == 1
    assert d['stats']['scoring']['cancelled'] == 2
    completed = next(t['id'] for t in d['tasks'] if t['status'] == 'succeeded')
    s.dispatch('runs.resume', {'run_id': run})
    pump(s)
    assert len(s.llm.transport.calls) == 3
    assert next(t for t in s.runs.detail({'run_id': run})['tasks'] if t['id'] == completed)['attempt_count'] == 1


def test_key_validation_secrecy_and_model_test_cancel_discards_late_success(service):
    s = service
    import_synthetic(s.repo, {'count': 1})
    s.dispatch('internal.credentials', {'model_key': None})
    with pytest.raises(CommandError): s.dispatch('jobs.score', {'filter': {}})
    s.dispatch('internal.credentials', {'model_key': 'synthetic-secret'})
    s.dispatch('internal.credentials', {'proxy_url': 'http://user:synthetic-password@localhost:8888'})
    assert s.settings()['has_key'] and s.settings()['has_proxy_credentials']
    entered, release = threading.Event(), threading.Event()
    s.llm.transport = FakeLlm(entered=entered, release=release)
    operation = s.dispatch('model.test', {'model': {'protocol': 'responses', 'base_url': 'http://127.0.0.1:1/test', 'model_id': 'unsaved'}})['operation_id']
    assert entered.wait(3)
    s.dispatch('operations.cancel', {'operation_id': operation})
    with pytest.raises(CommandError) as exc: s.dispatch('cleanup.execute', {'mode': 'manual'})
    assert exc.value.code == 'BUSY'
    assert s.dispatch('app.status', {})['operations'][0]['status'] == 'cancelling'
    release.set()
    events = pump(s)
    assert events == [('operation.failed', {'operation_id': operation, 'error': {'code': 'CANCELLED', 'message': 'Model operation cancelled.', 'retryable': False}})]
    assert s.settings()['model']['model_id'] == 'synthetic'
    events = pump_after_test(s)
    assert events[0][0] == 'model.test.completed' and events[0][1]['connected']
    assert not any(v in json.dumps(s.settings()) for v in ('synthetic-secret', 'synthetic-password'))
    assert not any(v in '\n'.join(s.repo.db.iterdump()) for v in ('synthetic-secret', 'synthetic-password'))


def pump_after_test(s):
    s.dispatch('model.test', {})
    return pump(s)


def test_scoring_validation_and_auto_rubric_invariant(service):
    s = service
    import_synthetic(s.repo, {'count': 1})
    for params in ({}, {'job_ids': [], 'filter': {}}, {'filter': {'page_size': 200}}, {'job_ids': []}):
        with pytest.raises(CommandError): s.dispatch('jobs.score', params)
    with pytest.raises(CommandError) as exc: s.dispatch('jobs.score', {'job_ids': ['missing']})
    assert exc.value.code == 'NOT_FOUND'
    s.dispatch('settings.save', {'rubric': ''})
    with pytest.raises(CommandError): s.dispatch('settings.save', {'auto_score_enabled': True})
    with pytest.raises(CommandError): s.dispatch('jobs.score', {'filter': {}})
    s.dispatch('settings.save', {'rubric': 'Restored'})
    assert not s.settings()['auto_score_enabled']


def test_stop_cancels_unsent_score_while_test_request_keeps_pool_slot(service):
    s = service
    import_synthetic(s.repo, {'count': 1})
    entered, release = threading.Event(), threading.Event()
    s.llm.transport = FakeLlm(entered=entered, release=release)
    s.dispatch('model.test', {})
    assert entered.wait(3)
    run = s.dispatch('jobs.score', {'filter': {}})['run_id']
    s.runs.advance(lambda *args: None)
    s.dispatch('runs.stop', {'run_id': run})
    try:
        pump(s, until=lambda: not s.runs.active())
        assert s.runs.detail({'run_id': run})['status'] == 'stopped'
        assert s.runs.detail({'run_id': run})['tasks'][0]['attempt_count'] == 0
        assert s.model_operations and len(s.llm.transport.calls) == 1
    finally:
        release.set()
        pump(s)


def test_restart_keeps_committed_scores_and_requeues_unfinished(service, tmp_path):
    s = service
    import_synthetic(s.repo, {'count': 2})
    run = s.dispatch('jobs.score', {'filter': {}})['run_id']
    # Persist one result and simulate exit before dispatching the other task.
    task = s.runs.detail({'run_id': run})['tasks'][0]
    with s.repo.db:
        s.repo.db.execute("UPDATE run_tasks SET status='succeeded',attempt_count=1 WHERE id=?", (task['id'],))
        s.repo.db.execute("UPDATE jobs SET score=0,score_state='succeeded',scored_at=? WHERE id=?", (NOW, task['spec']['job_id']))
    s.runs.close()
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        restored = Service(db, tmp_path, llm_options={'transport': FakeLlm(), 'rpm': 600000})
        try:
            assert restored.runs.detail({'run_id': run})['status'] == 'interrupted'
            restored.dispatch('internal.credentials', {'model_key': 'corrected-key'})
            restored.dispatch('runs.resume', {'run_id': run})
            pump(restored)
            assert len(restored.llm.transport.calls) == 1
            assert restored.repo.detail({'job_id': task['spec']['job_id']})['score'] == 0
        finally: restored.runs.close()


def test_real_receive_loop_response_before_score_events(tmp_path):
    incoming, outgoing, failures = queue.Queue(), queue.Queue(), []
    class Input:
        def readline(self, _): return incoming.get(timeout=5)
    class Output:
        def write(self, data): outgoing.put(json.loads(data))
        def flush(self): pass
    def work():
        try: serve(tmp_path, Input(), Output(), enable_dev=True, llm_options={'transport': FakeLlm(), 'rpm': 600000})
        except BaseException as exc: failures.append(exc)
    thread = threading.Thread(target=work)
    thread.start()
    seen = []
    def call(identifier, method, params=None):
        incoming.put(request(identifier, method, params))
        while True:
            msg = outgoing.get(timeout=4)
            seen.append(msg)
            if msg.get('id') == identifier: return msg
    try:
        assert outgoing.get(timeout=4)['name'] == 'ready'
        call('import', 'dev.import_synthetic', {'count': 1})
        call('key', 'internal.credentials', {'model_key': 'synthetic-secret'})
        call('settings', 'settings.save', {'auto_score_enabled': False, 'rubric': 'Rubric', 'model': {
            'protocol': 'responses', 'base_url': 'http://127.0.0.1:1/v1', 'model_id': 'fake'}})
        accepted = call('score', 'jobs.score', {'filter': {}})
        run = accepted['result']['run_id']
        assert not any(m.get('name') == 'run.updated' for m in seen)
        while True:
            msg = outgoing.get(timeout=4)
            seen.append(msg)
            if msg.get('name') == 'run.updated' and msg['data']['status'] == 'succeeded': break
        assert call('detail', 'runs.detail', {'run_id': run})['result']['stats']['scoring']['succeeded'] == 1
        accepted = call('test', 'model.test')
        while True:
            msg = outgoing.get(timeout=4)
            seen.append(msg)
            if msg.get('name') == 'model.test.completed':
                assert msg['data']['operation_id'] == accepted['result']['operation_id']
                break
        assert 'synthetic-secret' not in json.dumps(seen)
    finally:
        incoming.put(b'')
        thread.join(5)
    assert not thread.is_alive() and not failures
