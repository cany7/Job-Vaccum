from contextlib import closing
import json
import queue
import threading
import time

import pytest

from job_vaccum.llm.drafts import SEARCH_PROMPT, RUBRIC_PROMPT, parse_generated
from job_vaccum.llm.fake import FakeLlm
from job_vaccum.llm.http import ModelError
from job_vaccum.pipeline.configuration import draft
from job_vaccum.service.protocol import CommandError
from job_vaccum.service.server import serve
from job_vaccum.storage.database import connect
from job_vaccum.storage.repository import Repository
from job_vaccum.storage.synthetic import import_synthetic
from test_business_protocol import request
from test_scoring import service, pump


SEARCH = {'directions': [{'name': 'Backend', 'queries': [
    {'expression': 'backend engineer', 'enabled': True},
    {'expression': 'python developer', 'enabled': True}]}],
    'cities': [{'location': 'Chicago, IL', 'distance_miles': 0, 'enabled': True}]}
RUBRIC = '# Fit rubric\n\n- 0: explicit conflict.\n- 5: partial fit.\n- 10: strong fit.\n'
QUESTION = {'directions': [], 'cities': [], 'clarification': 'Which kind of role?'}


def generate(s, kind='search', **user_input):
    return s.dispatch('drafts.generate', {'kind': kind, 'input': {'text': 'Synthetic user text', **user_input}})['operation_id']


def get(s, kind='search'):
    return s.dispatch('drafts.get', {'draft_kind': kind})


def test_search_generation_input_reuse_restart_and_apply(service):
    s = service
    rules = s.settings()['rules']
    rules['qualifications'] = {'requires_sponsorship': False, 'degrees': ['BS']}
    s.dispatch('settings.save', {'rules': rules})
    before = s.settings()
    s.llm.transport = FakeLlm(responses=[json.dumps(SEARCH)])
    op = generate(s, text='  Backend roles in Chicago\nUse Python.  ')
    events = pump(s)
    assert events == [('drafts.generated', {'operation_id': op, 'draft_kind': 'search'})]
    saved = get(s)
    assert saved['content'] == SEARCH
    assert saved['input'] == {'text': '  Backend roles in Chicago\nUse Python.  ', 'conditions': rules['qualifications']}
    assert s.settings() == before
    call = s.llm.transport.calls[0]
    assert call['system'] == SEARCH_PROMPT
    assert json.loads(call['prompt'])['input'] == saved['input']
    assert all('id' not in c for c in json.loads(call['prompt'])['current_cities'])
    with closing(connect(s.root / 'app.sqlite3')) as db:
        assert draft(Repository(db), 'get', {'draft_kind': 'search'}) == saved
    s.dispatch('drafts.apply', {'draft_kind': 'search'})
    settings = s.settings()
    assert settings['directions'][0]['id'] and settings['cities'][0]['id']
    assert settings['directions'][0]['name'] == 'Backend'
    assert settings['cities'][0]['distance_miles'] == 0
    assert settings['country_indeed'] == before['country_indeed']


def test_rubric_generation_edit_apply_and_real_scoring_path(service):
    s = service
    s.dispatch('directions.save', {'name': 'Backend'})
    s.dispatch('directions.save', {'name': 'Data'})
    s.llm.transport = FakeLlm(responses=[RUBRIC, json.dumps({'score': 0, 'reason': 'Explicit conflict.'})])
    original = s.settings()
    generate(s, 'rubric', text='Synthetic resume', conditions={'requires_sponsorship': True})
    pump(s)
    assert s.settings() == original
    context = json.loads(s.llm.transport.calls[0]['prompt'])
    assert context['search_directions'] == ['Backend', 'Data']
    assert context['input']['conditions']['requires_sponsorship'] is True
    assert s.llm.transport.calls[0]['system'] == RUBRIC_PROMPT
    edited = RUBRIC + '\nUser edit: prioritize Python.\n'
    s.dispatch('drafts.save', {'draft_kind': 'rubric', 'content': edited})
    s.dispatch('drafts.apply', {'draft_kind': 'rubric'})
    assert s.settings()['rubric'] == edited and not s.settings()['auto_score_enabled']
    assert get(s, 'rubric')['input']['text'] == 'Synthetic resume'
    import_synthetic(s.repo, {'count': 1})
    s.dispatch('jobs.score', {'filter': {}})
    pump(s)
    assert edited in s.llm.transport.calls[1]['system']
    assert s.repo.list_jobs({})['items'][0]['score'] == 0


@pytest.mark.parametrize('kind,text', [
    ('search', 'not JSON'), ('search', '[]'), ('search', '{}'),
    ('search', json.dumps({'directions': [], 'cities': []})),
    ('search', json.dumps({**SEARCH, 'id': 'model-id'})),
    ('search', json.dumps({**SEARCH, 'cities': [{'location': 'Chicago', 'distance_miles': True, 'enabled': True}]})),
    ('search', json.dumps({**SEARCH, 'directions': [{'name': 'Test', 'queries': [{'expression': ' ', 'enabled': True}]}]})),
    ('search', json.dumps({**SEARCH, 'directions': [{'name': 'Test', 'queries': [{'expression': 'Python', 'enabled': 'yes'}]}]})),
    ('search', json.dumps({**SEARCH, 'clarification': 'Question with an actionable draft?'})),
    ('search', json.dumps({**QUESTION, 'clarification': ''})),
    ('rubric', ''), ('rubric', '   '), ('rubric', '{}'), ('rubric', '"Markdown in JSON"'),
    ('rubric', '```markdown\n# Wrapped rubric\n```'), ('rubric', None),
])
def test_invalid_generation_is_retryable_and_never_echoes_output(kind, text):
    with pytest.raises(ModelError) as exc:
        parse_generated(kind, text, user_input={'text': 'Private synthetic resume'})
    assert exc.value.error['code'] == 'INVALID_MODEL_OUTPUT' and exc.value.error['retryable']
    assert 'Private synthetic resume' not in str(exc.value)


@pytest.mark.parametrize('kind', ['search', 'rubric'])
@pytest.mark.parametrize('failure', ['invalid', 'auth'])
def test_failure_keeps_input_previous_draft_and_settings(service, kind, failure):
    s = service
    previous = SEARCH if kind == 'search' else RUBRIC
    s.dispatch('drafts.save', {'draft_kind': kind, 'content': previous})
    settings = s.settings()
    response = ' ' if failure == 'invalid' else ModelError('AUTH_ERROR', 'Synthetic authentication failure.')
    s.llm.transport = FakeLlm(responses=[response] * 3)
    op = generate(s, kind, text='New synthetic input', conditions={})
    event = pump(s)[-1]
    assert event[0] == 'operation.failed' and event[1]['operation_id'] == op
    assert event[1]['error']['code'] == ('INVALID_MODEL_OUTPUT' if failure == 'invalid' else 'AUTH_ERROR')
    assert len(s.llm.transport.calls) == (3 if failure == 'invalid' else 1)
    assert s.settings() == settings and get(s, kind)['content'] == previous
    with closing(connect(s.root / 'app.sqlite3')) as db:
        saved = draft(Repository(db), 'get', {'draft_kind': kind})
        assert saved['input'] == {'text': 'New synthetic input', 'conditions': {}}
        assert saved['content'] == previous


def test_invalid_then_valid_and_one_clarification_round(service):
    s = service
    s.llm.transport = FakeLlm(responses=['invalid', json.dumps(QUESTION), json.dumps(SEARCH)])
    generate(s)
    pump(s)
    assert get(s)['content'] == QUESTION and len(s.llm.transport.calls) == 2
    before = s.settings()
    with pytest.raises(CommandError):
        s.dispatch('drafts.apply', {'draft_kind': 'search'})
    assert s.settings() == before
    generate(s, clarification_answer='Backend roles using Python, Chicago')
    pump(s)
    assert get(s)['content'] == SEARCH
    assert json.loads(s.llm.transport.calls[-1]['prompt'])['clarification'] == QUESTION['clarification']
    with pytest.raises(ModelError):
        parse_generated('search', json.dumps(QUESTION), user_input={'text': 'Jobs', 'clarification_answer': 'Backend'})


@pytest.mark.parametrize('missing', ['model', 'key', 'text'])
def test_input_saved_before_prerequisite_failure(service, missing):
    s = service
    if missing == 'model': s.dispatch('settings.save', {'model': None})
    if missing == 'key': s.dispatch('internal.credentials', {'model_key': None})
    text = '' if missing == 'text' else 'Keep this resume'
    with pytest.raises(CommandError) as exc:
        generate(s, 'rubric', text=text)
    assert exc.value.code == ('AUTH_ERROR' if missing == 'key' else 'VALIDATION_ERROR')
    assert get(s, 'rubric')['input']['text'] == text
    assert not s.model_operations and not s.llm.transport.calls


def test_input_only_autosave_and_validation_are_atomic(service):
    s = service
    saved = s.dispatch('drafts.save', {'draft_kind': 'rubric', 'input': {'text': ''}})
    assert saved == {'draft_kind': 'rubric', 'content': None, 'input': {'text': ''}}
    with pytest.raises(CommandError):
        s.dispatch('drafts.save', {'draft_kind': 'rubric', 'content': RUBRIC,
                                 'input': {'text': 'New', 'conditions': {'requires_sponsorship': 'yes'}}})
    assert get(s, 'rubric') == saved
    with pytest.raises(CommandError):
        generate(s, 'rubric', clarification_answer='Not a rubric field')
    assert get(s, 'rubric') == saved


def test_cancel_inflight_retains_slot_and_keeps_reads_and_edits_responsive(service):
    s = service
    import_synthetic(s.repo, {'count': 1})
    job = s.repo.list_jobs({})['items'][0]['id']
    s.repo.add({'job_id': job})
    entered, release = threading.Event(), threading.Event()
    fake = FakeLlm(entered=entered, release=release, responses=[RUBRIC, 'OK', json.dumps({'score': 0, 'reason': 'Fit'})])
    s.llm.transport = fake
    try:
        op = generate(s, 'rubric')
        assert entered.wait(2)
        s.dispatch('operations.cancel', {'operation_id': op})
        assert s.dispatch('app.status', {})['operations'] == [
            {'operation_id': op, 'kind': 'draft_generate', 'draft_kind': 'rubric', 'status': 'cancelling'}]
        s.dispatch('model.test', {})
        s.dispatch('jobs.score', {'job_ids': [job]})
        s.runs.advance(lambda *args: None)
        s.dispatch('applications.update', {'job_id': job, 'notes': 'Still responsive'})
        assert s.dispatch('jobs.detail', {'job_id': job})['application']['notes'] == 'Still responsive'
        with pytest.raises(CommandError) as exc: s.dispatch('cleanup.execute', {'mode': 'manual'})
        assert exc.value.code == 'BUSY'
        assert len(fake.calls) == 1
    finally:
        release.set()
    events = pump(s)
    assert ('operation.failed', {'operation_id': op, 'error': {
        'code': 'CANCELLED', 'message': 'Model operation cancelled.', 'retryable': False}}) in events
    assert get(s, 'rubric')['content'] is None
    assert len(fake.calls) == 3


@pytest.mark.parametrize('waiting', ['queue', 'rpm', 'retry'])
def test_cancel_queued_rpm_or_retry_draft_without_more_requests(service, waiting):
    s = service
    entered, release = threading.Event(), threading.Event()
    fake = FakeLlm(entered=entered, release=release if waiting == 'queue' else None,
                   responses=['OK'] if waiting == 'queue' else [ModelError('RATE_LIMITED', 'Synthetic 429', retryable=True, retry_after=60)])
    s.llm.transport = fake
    try:
        if waiting == 'queue':
            s.dispatch('model.test', {})
            assert entered.wait(2)
        if waiting == 'rpm': s.llm.gate.next_start = time.monotonic() + 60
        op = generate(s, 'rubric')
        if waiting == 'retry': assert entered.wait(2)
        s.dispatch('operations.cancel', {'operation_id': op})
    finally:
        release.set()
    events = pump(s)
    assert any(n == 'operation.failed' and d['operation_id'] == op and d['error']['code'] == 'CANCELLED' for n, d in events)
    assert len(fake.calls) == (0 if waiting == 'rpm' else 1)
    assert get(s, 'rubric')['input']['text'] == 'Synthetic user text'


@pytest.mark.parametrize('action', ['save', 'apply', 'generate'])
def test_late_result_cannot_overwrite_later_user_action(service, action):
    s = service
    s.dispatch('drafts.save', {'draft_kind': 'rubric', 'content': RUBRIC})
    entered, release = threading.Event(), threading.Event()
    s.llm.transport = FakeLlm(entered=entered, release=release, responses=['# Stale rubric', '# New rubric'])
    try:
        op = generate(s, 'rubric')
        assert entered.wait(2)
        if action == 'generate':
            generate(s, 'rubric', text='Newer input')
        elif action == 'save':
            s.dispatch('drafts.save', {'draft_kind': 'rubric', 'content': '# User edit'})
        else:
            s.dispatch('drafts.apply', {'draft_kind': 'rubric'})
    finally:
        release.set()
    events = pump(s)
    assert any(n == 'operation.failed' and d['operation_id'] == op and d['error']['code'] == 'CANCELLED' for n, d in events)
    assert get(s, 'rubric')['content'] == {'save': '# User edit', 'apply': RUBRIC, 'generate': '# New rubric'}[action]
    if action == 'generate': assert get(s, 'rubric')['input']['text'] == 'Newer input'


def test_failed_generation_commit_rolls_back_and_service_stays_usable(service):
    s = service
    s.dispatch('drafts.save', {'draft_kind': 'rubric', 'content': RUBRIC})
    s.repo.db.execute("CREATE TRIGGER fail_generated BEFORE UPDATE ON settings WHEN NEW.key='draft:rubric' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END")
    s.llm.transport = FakeLlm(responses=['# Replacement'])
    generate(s, 'rubric')
    assert pump(s)[-1][1]['error']['code'] == 'STORAGE_ERROR'
    assert get(s, 'rubric')['content'] == RUBRIC
    assert get(s, 'rubric')['input']['text'] == 'Synthetic user text'
    assert not s.dispatch('app.status', {})['operations']


def test_wire_acceptance_precedes_completion_and_restart_reads_saved_result(tmp_path):
    incoming, outgoing, failures = queue.Queue(), queue.Queue(), []
    class Input:
        def readline(self, *_): return incoming.get(timeout=5)
    class Output:
        def write(self, data): outgoing.put(json.loads(data))
        def flush(self): pass
    def work():
        try:
            serve(tmp_path, Input(), Output(), llm_options={
                'transport': FakeLlm(responses=[json.dumps(SEARCH)]), 'rpm': 600000})
        except BaseException as exc: failures.append(exc)
    thread = threading.Thread(target=work)
    thread.start()
    seen = []
    def call(identifier, method, params):
        incoming.put(request(identifier, method, params))
        while True:
            message = outgoing.get(timeout=4)
            seen.append(message)
            if message.get('id') == identifier: return message
    try:
        assert outgoing.get(timeout=4)['name'] == 'ready'
        call('key', 'internal.credentials', {'model_key': 'synthetic-secret'})
        call('settings', 'settings.save', {'model': {'protocol': 'responses',
             'base_url': 'http://127.0.0.1:1/v1', 'model_id': 'fake'}})
        accepted = call('generate', 'drafts.generate', {'kind': 'search', 'input': {'text': 'Backend in Chicago'}})
        assert accepted['ok'] and not any(m.get('name') == 'drafts.generated' for m in seen)
        while True:
            message = outgoing.get(timeout=4)
            seen.append(message)
            if message.get('name') == 'drafts.generated': break
        assert message['data'] == {'operation_id': accepted['result']['operation_id'], 'draft_kind': 'search'}
        saved = call('draft', 'drafts.get', {'draft_kind': 'search'})['result']
        assert saved['content'] == SEARCH
        assert 'synthetic-secret' not in json.dumps(seen)
    finally:
        incoming.put(b'')
        thread.join(5)
    assert not thread.is_alive() and not failures
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        repo = Repository(db)
        assert draft(repo, 'get', {'draft_kind': 'search'}) == saved
        assert repo.settings()['directions'] == []
