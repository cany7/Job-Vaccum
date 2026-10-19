from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import queue
import socket
import threading
import time

import pytest

from job_vaccum.llm.http import generate, score_result, request_parts, extract, ModelError
from job_vaccum.llm.pool import LlmPool, RateGate
from job_vaccum.pipeline.configuration import validate_model
from job_vaccum.service.protocol import CommandError

CONNECT = socket.socket.connect
PROTOCOLS = ('chat_completions', 'responses', 'anthropic_messages', 'gemini_generate_content')


def model(protocol='chat_completions', **changes):
    return {'protocol': protocol, 'base_url': 'http://127.0.0.1:1/custom/v1', 'model_id': 'synthetic-model',
            **({'max_output_tokens': 200} if protocol == 'anthropic_messages' else {}), **changes}


def response(protocol, text='{"score":0,"reason":"Valid zero."}'):
    return {
        'chat_completions': {'choices': [{'finish_reason': 'stop', 'message': {'content': text}}]},
        'responses': {'status': 'completed', 'output': [{'type': 'reasoning', 'summary': []},
            {'type': 'message', 'content': [{'type': 'output_text', 'text': text}]}]},
        'anthropic_messages': {'stop_reason': 'end_turn', 'content': [{'type': 'thinking', 'thinking': 'private'}, {'type': 'text', 'text': text}]},
        'gemini_generate_content': {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [
            {'thought': True, 'text': 'private'}, {'text': text}]}}]},
    }[protocol]


@pytest.fixture
def http_server(monkeypatch):
    # Explicitly permit only this fixture's loopback HTTP server; public traffic stays blocked.
    def local_connect(sock, address):
        assert address[0] == '127.0.0.1'
        return CONNECT(sock, address)
    monkeypatch.setattr(socket.socket, 'connect', local_connect)
    @contextmanager
    def start(replies):
        seen, pending = [], queue.Queue()
        for reply in replies:
            pending.put(reply)
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                seen.append((self.path, dict(self.headers), json.loads(self.rfile.read(int(self.headers['Content-Length']))), time.monotonic()))
                status, data, headers = pending.get(timeout=3)
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    if callable(data):
                        data = data()
                    self.wfile.write(data if isinstance(data, bytes) else json.dumps(data).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{server.server_port}/custom/v1', seen
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)
    return start


@pytest.mark.parametrize('protocol', PROTOCOLS)
def test_four_http_protocols_endpoint_auth_optional_zero_and_text(http_server, protocol):
    with http_server([(200, response(protocol), {})]) as (url, seen):
        config = model(protocol, base_url=url + '/', temperature=0, reasoning_effort='high', thinking={'budget_tokens': 32})
        assert score_result(generate(config, 'synthetic-secret', 'Rubric', 'Job'))['score'] == 0
        path, headers, body, _ = seen[0]
        suffix = {'chat_completions': '/chat/completions', 'responses': '/responses',
                  'anthropic_messages': '/messages', 'gemini_generate_content': '/models/synthetic-model:generateContent'}[protocol]
        assert path == '/custom/v1' + suffix
        assert 'synthetic-secret' in headers.get('Authorization', headers.get('x-api-key', headers.get('x-goog-api-key', '')))
        assert (body.get('generationConfig', body))['temperature'] == 0
        if protocol == 'responses':
            assert body['reasoning'] == {'effort': 'high'} and body['input'][0]['content'] == 'Rubric'
        elif protocol == 'chat_completions':
            assert body['reasoning_effort'] == 'high' and body['stream'] is False
        elif protocol == 'anthropic_messages':
            assert body['thinking'] == {'budget_tokens': 32} and headers['anthropic-version'] == '2023-06-01'
        else:
            assert body['generationConfig']['thinkingConfig'] == {'budget_tokens': 32}


@pytest.mark.parametrize('protocol', PROTOCOLS)
def test_optional_nulls_omitted_and_protocol_token_mapping(protocol):
    config = model(protocol, temperature=None, reasoning_effort=None, thinking=None)
    _, _, body = request_parts(config, 'key', '', 'Prompt')
    assert 'temperature' not in body and 'reasoning' not in body and 'generationConfig' not in body
    if protocol != 'anthropic_messages':
        assert not any(k in body for k in ('max_tokens', 'max_output_tokens', 'max_completion_tokens'))
    config['max_output_tokens'] = 12
    _, _, body = request_parts(config, 'key', '', 'Prompt')
    key = dict(zip(PROTOCOLS, ('max_completion_tokens', 'max_output_tokens', 'max_tokens', 'maxOutputTokens')))[protocol]
    assert body.get('generationConfig', body)[key] == 12
    # Model names never change parameter handling.
    config['model_id'] = 'arbitrary-provider-model'
    assert request_parts(config, 'key', '', 'Prompt')[2] == {**body, **({'model': 'arbitrary-provider-model'} if 'model' in body else {})}


@pytest.mark.parametrize('protocol', PROTOCOLS)
@pytest.mark.parametrize('scenario', ['empty', 'truncated', 'refused', 'malformed', 'error'])
def test_invalid_responses_are_never_scores(http_server, protocol, scenario):
    data = response(protocol, '') if scenario == 'empty' else response(protocol)
    if scenario == 'truncated':
        if protocol == 'chat_completions': data['choices'][0]['finish_reason'] = 'length'
        elif protocol == 'responses': data['status'] = 'incomplete'
        elif protocol == 'anthropic_messages': data['stop_reason'] = 'max_tokens'
        else: data['candidates'][0]['finishReason'] = 'MAX_TOKENS'
    elif scenario == 'refused':
        if protocol == 'chat_completions': data['choices'][0]['message']['refusal'] = 'secret'
        elif protocol == 'responses': data['output'][1]['content'] = [{'type': 'refusal', 'refusal': 'secret'}]
        elif protocol == 'anthropic_messages': data['stop_details'] = {'type': 'refusal'}
        else: data['promptFeedback'] = {'blockReason': 'SAFETY'}
    elif scenario == 'malformed': data = b'invalid JSON synthetic-secret'
    elif scenario == 'error': data = {'error': {'message': 'synthetic-secret http://u:password@host'}}
    with http_server([(200, data, {})]) as (url, _):
        with pytest.raises(ModelError) as exc:
            generate(model(protocol, base_url=url), 'synthetic-secret', '', 'Job')
        assert exc.value.error['code'] == 'INVALID_MODEL_OUTPUT'
        assert 'synthetic-secret' not in str(exc.value) and 'password' not in str(exc.value)


def test_multi_block_final_text_and_empty_candidates():
    d = response('responses', '{"score":')
    d['output'].append({'type': 'message', 'content': [{'type': 'output_text', 'text': '0,"reason":"ok"}'}]})
    assert score_result(extract('responses', d))['score'] == 0
    d = response('anthropic_messages', '{"score":')
    d['content'].append({'type': 'text', 'text': '0,"reason":"ok"}'})
    assert score_result(extract('anthropic_messages', d))['score'] == 0
    for protocol, data in [('chat_completions', {'choices': []}), ('gemini_generate_content', {'candidates': []}), ('responses', {'status': 'completed', 'output': []})]:
        with pytest.raises(ModelError): extract(protocol, data)


@pytest.mark.parametrize('text', ['{"score":11,"reason":"x"}', '{"score":true,"reason":"x"}', '{"score":0.0,"reason":"x"}', '{"score":0,"reason":null}', '[]', '```json\n{}\n```'])
def test_score_validation(text):
    with pytest.raises(ModelError): score_result(text)


@pytest.mark.parametrize('status,attempts,code', [(400, 1, 'NETWORK_ERROR'), (401, 1, 'AUTH_ERROR'), (403, 1, 'AUTH_ERROR'), (408, 3, 'NETWORK_ERROR'), (429, 3, 'RATE_LIMITED'), (503, 3, 'NETWORK_ERROR')])
def test_http_retry_budget_and_redaction(http_server, status, attempts, code):
    with http_server([(status, {'error': 'synthetic-secret http://user:password@host'}, {'Retry-After': '0'})] * attempts) as (url, seen):
        inbox, cancel = queue.Queue(), threading.Event()
        pool = LlmPool(inbox, rpm=600000, retry_base=0)
        try:
            pool.submit('test', model(base_url=url), 'synthetic-secret', '', 'OK', str, cancel)
            messages = []
            while not messages or messages[-1][0] != 'llm_result': messages.append(inbox.get(timeout=3))
            error = messages[-1][1][2]
            assert error['code'] == code and error['http_status'] == status
            assert len(seen) == attempts and sum(m[0] == 'llm_attempt' for m in messages) == attempts
            assert not any(secret in json.dumps(messages) for secret in ('synthetic-secret', 'password'))
        finally: pool.close()


def test_invalid_output_retries_success_and_retry_after_cancel(http_server):
    with http_server([(200, response('chat_completions', 'invalid'), {}), (200, response('chat_completions'), {})]) as (url, seen):
        inbox, cancel = queue.Queue(), threading.Event()
        pool = LlmPool(inbox, rpm=600000, retry_base=0)
        try:
            pool.submit('test', model(base_url=url), 'key', '', 'Job', score_result, cancel)
            while True:
                kind, payload = inbox.get(timeout=3)
                if kind == 'llm_result': break
            assert payload[1]['score'] == 0 and len(seen) == 2
        finally: pool.close()
    with http_server([(429, {}, {'Retry-After': '300'})]) as (url, seen):
        inbox, cancel = queue.Queue(), threading.Event()
        pool = LlmPool(inbox, rpm=600000, retry_base=0)
        try:
            pool.submit('test', model(base_url=url), 'key', '', 'Job', str, cancel)
            assert inbox.get(timeout=3)[0] == 'llm_attempt'
            deadline = time.monotonic() + 3
            while not seen and time.monotonic() < deadline: time.sleep(0.005)
            cancel.set()
            assert inbox.get(timeout=3)[1][2]['code'] == 'CANCELLED'
            assert len(seen) == 1
        finally: pool.close()


def test_global_pool_concurrency_and_spacing_include_retries():
    inbox, lock = queue.Queue(), threading.Lock()
    active, maximum, starts = 0, 0, []
    def transport(*args):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
            starts.append(time.monotonic())
            index = len(starts)
        time.sleep(0.01)
        with lock: active -= 1
        if index == 1: raise ModelError('NETWORK_ERROR', 'Synthetic', retryable=True)
        return 'OK'
    pool = LlmPool(inbox, transport=transport, rpm=1200, retry_base=0)
    try:
        for token in ('score', 'model_test', 'next_score'):
            pool.submit(token, model(), 'key', '', '', str, threading.Event())
        completed = 0
        while completed < 3:
            kind, _ = inbox.get(timeout=3)
            completed += kind == 'llm_result'
        assert maximum == 1 and len(starts) == 4
        assert all(b - a >= 0.045 for a, b in zip(starts, starts[1:]))
        assert LlmPool.__init__.__kwdefaults__['rpm'] == 10
        assert LlmPool.__init__.__kwdefaults__['concurrency'] == 1
    finally: pool.close()
    current = [100.0]
    gate = RateGate(10, clock=lambda: current[0])
    cancel = threading.Event()
    assert gate.enter(cancel) and gate.next_start == 106
    current[0] = 200
    assert gate.enter(cancel) and gate.next_start == 206


def test_anthropic_required_and_bad_endpoint_validation():
    with pytest.raises(CommandError): validate_model(model('anthropic_messages', max_output_tokens=None))
    with pytest.raises(CommandError): validate_model(model('gemini_generate_content', model_id='models/example'))
    with pytest.raises(CommandError): validate_model(model(base_url='http://localhost:bad/v1'))


def test_local_http_read_timeout_is_controlled(http_server):
    def delayed():
        time.sleep(0.1)
        return response('chat_completions')
    with http_server([(200, delayed, {})]) as (url, seen):
        with pytest.raises(ModelError) as exc:
            generate(model(base_url=url), 'synthetic-secret', '', 'Prompt', timeout=(0.1, 0.02))
        assert exc.value.error['code'] == 'NETWORK_ERROR' and exc.value.error['retryable']
        assert len(seen) == 1 and 'synthetic-secret' not in str(exc.value)
