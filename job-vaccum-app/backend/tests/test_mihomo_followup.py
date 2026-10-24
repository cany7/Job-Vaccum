"""M6 scheduling and controller regressions; no real nodes or public traffic."""
import json
import threading

import pytest
import requests

from job_vaccum.proxy.mihomo import Controller, Instance, exit_ipv4, EXIT_URL, EXIT_FALLBACK_URL
from job_vaccum.service.protocol import CommandError
from test_mihomo import service, node_config, make_pool, setup_mihomo, FakeInstance
from test_pipeline import configure, outcome, record, drain, detail, start, ERROR


@pytest.mark.parametrize('value', [0, -1, True, None, float('inf')])
def test_failed_node_parameter_atomic(service, value):
    before = service.settings()
    with pytest.raises(CommandError):
        service.dispatch('settings.save', {'country_indeed': 'canada', 'mihomo': {'failed_node_cooldown_seconds': value}})
    assert service.settings() == before


def test_failed_node_config_snapshot_resume_and_legacy(service, node_config):
    s = service
    configure(s, sites=['linkedin'])
    setup_mihomo(s, node_config, port_count=1, failed_node_cooldown_seconds=17)
    seen = []
    factory = s.runs.retrieval_options['pool_factory']
    def capture(*args):
        pool = factory(*args)
        seen.append(pool.config['failed_node_cooldown_seconds'])
        return pool
    s.runs.retrieval_options['pool_factory'] = capture
    identifier = start(s)
    s.dispatch('settings.save', {'mihomo': {'failed_node_cooldown_seconds': 99}})
    drain(s)
    snapshot = detail(s, identifier)['config_snapshot']
    assert snapshot['mihomo']['failed_node_cooldown_seconds'] == 17
    def resume():
        with s.repo.db:
            s.repo.db.execute("UPDATE runs SET status='interrupted' WHERE id=?", (identifier,))
            s.repo.db.execute("UPDATE run_tasks SET status='pending' WHERE run_id=?", (identifier,))
        s.runs.resume({'run_id': identifier})
        drain(s)
    resume()
    assert seen == [17, 17]
    snapshot['mihomo'].pop('failed_node_cooldown_seconds')
    with s.repo.db:
        s.repo.db.execute('UPDATE runs SET config_snapshot_json=? WHERE id=?', (json.dumps(snapshot), identifier))
        s.repo.db.execute('UPDATE settings SET value_json=? WHERE key=?', (json.dumps(snapshot['mihomo']), 'mihomo'))
    assert s.settings()['mihomo']['failed_node_cooldown_seconds'] == 60
    resume()
    assert seen[-1] == 60


@pytest.mark.parametrize('seconds', [60, 7])
def test_failed_candidate_deadline_shared_between_ports(seconds):
    pool, ctrl, clock = make_pool({'a': '8.8.8.8'}, failed_node_cooldown_seconds=seconds)
    ctrl.bad.add('a')
    assert not pool.prepare(7901)
    ctrl.bad.clear()
    clock.now = seconds - .01
    assert not pool.prepare(7902) and len(ctrl.checks) == 2
    clock.now = seconds
    assert pool.prepare(7902) and len(ctrl.checks) == 4
    assert not pool.cooling


@pytest.mark.parametrize('bad_latency,new_ip,accepted', [
    (False, '1.1.1.1', True), (True, '1.1.1.1', False),
    (False, '9.9.9.9', False), (False, '8.8.4.4', False),
])
def test_retention_rechecks_delay_and_changed_exit(bad_latency, new_ip, accepted):
    ips = {'a': '8.8.8.8'}
    pool, ctrl, clock = make_pool(ips)
    assert pool.prepare(7901)
    pool.active[7902] = ('other', '9.9.9.9')
    pool.cooling['8.8.4.4'] = 300
    ips['a'] = new_ip
    if bad_latency:
        ctrl.bad.add('a')
    assert pool.prepare(7901) is accepted
    assert len(ctrl.checks) == 4
    assert pool.cooling['8.8.8.8'] == 300
    if accepted:
        assert pool.active[7901] == ('a', new_ip) and clock.waits == [5]
    else:
        assert 7901 not in pool.active


@pytest.mark.parametrize('reported', ['wrong', None, 'chosen'])
def test_controller_reads_selection_after_put(reported):
    ctrl = Controller(9099, 'synthetic')
    calls = []
    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {'now': reported} if method == 'GET' else None
    ctrl.request = request
    if reported == 'chosen':
        ctrl.select(7901, 'chosen')
    else:
        with pytest.raises(CommandError, match='confirmed'):
            ctrl.select(7901, 'chosen')
    assert [c[0] for c in calls] == ['PUT', 'GET']
    assert calls[0][1] == calls[1][1] and calls[0][2]['json'] == {'name': 'chosen'}


@pytest.mark.parametrize('first,second,cancel,expected', [
    ('8.8.8.8', None, False, '8.8.8.8'),
    ('127.0.0.1', '1.1.1.1', False, '1.1.1.1'),
    ('error', '1.1.1.1', False, '1.1.1.1'),
    ('error', 'invalid', False, None), ('error', '1.1.1.1', True, None),
])
def test_exit_fallback_same_listener_and_stop(monkeypatch, first, second, cancel, expected):
    calls, stop = [], threading.Event()
    class Session:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def get(self, url, **kwargs):
            assert self.trust_env is False
            calls.append((url, kwargs))
            value = first if len(calls) == 1 else second
            if cancel:
                stop.set()
            if value == 'error':
                raise requests.ConnectionError('synthetic')
            self.text = value
            return self
        def raise_for_status(self):
            pass
    monkeypatch.setattr(requests, 'Session', Session)
    if expected:
        assert exit_ipv4(7901, stop) == expected
    else:
        with pytest.raises(CommandError):
            exit_ipv4(7901, stop)
    assert [url for url, _ in calls] == ([EXIT_URL] if first == '8.8.8.8' or cancel else [EXIT_URL, EXIT_FALLBACK_URL])
    for _, kwargs in calls:
        assert kwargs['proxies'] == {'http': 'http://127.0.0.1:7901', 'https': 'http://127.0.0.1:7901'}
        assert kwargs['timeout'] == (3, 5) and kwargs['allow_redirects'] is False


@pytest.mark.parametrize('sites', [['indeed'], ['linkedin', 'indeed']])
def test_invalid_mihomo_file_cannot_block_indeed(service, sites):
    s = service
    configure(s, sites=sites)
    s.dispatch('settings.save', {'run_mode': 'advanced', 'proxy': {'mode': 'mihomo', 'url': None}})
    calls, starts = [], []
    class ObservedInstance(Instance):
        def start(self):
            starts.append(True)
            return super().start()
    s.runs.retrieval_options['instance_factory'] = ObservedInstance
    def attempt(spec, params, proxy, stop):
        calls.append((spec['site'], proxy))
        return outcome([record(spec['query_id'], site='indeed')])
    s.runs.attempt = attempt
    assert s.runs.preview({})['task_count'] > 0
    identifier = start(s)
    drain(s)
    result = detail(s, identifier)
    assert calls and set(calls) == {('indeed', None)}
    assert result['status'] == ('succeeded' if sites == ['indeed'] else 'partial')
    assert len(starts) == (0 if sites == ['indeed'] else 1)
    for task in result['tasks']:
        assert task['attempt_count'] == (1 if task['spec']['site'] == 'indeed' else 0)
    # Resume with the same missing paths also leaves Indeed independent.
    with s.repo.db:
        s.repo.db.execute("UPDATE runs SET status='interrupted' WHERE id=?", (identifier,))
        s.repo.db.execute("UPDATE run_tasks SET status='pending' WHERE run_id=?", (identifier,))
    s.runs.resume({'run_id': identifier})
    drain(s)
    assert detail(s, identifier)['status'] == result['status']


@pytest.mark.parametrize('succeed', [True, False])
def test_retry_after_rotation_preserves_budget_partial_and_http(service, node_config, succeed):
    s = service
    s.dispatch('settings.save', {'platforms': ['linkedin'], 'advanced_parameters': {'max_attempts': 3}})
    clock = setup_mihomo(s, node_config, port_count=1, batch_size=1, concurrency_per_port=1)
    nodes = []
    def attempt(spec, params, proxy, stop):
        nodes.append(FakeInstance.instances[-1].controller.selected[7901])
        if len(nodes) > 1:
            assert len(clock.waits) == len(nodes) - 1
        rows = [record('same'), record(str(len(nodes)), description=f'Unique work {len(nodes)}')]
        return outcome(rows, None if succeed and len(nodes) == 3 else ERROR, http_requests=4, http_429=1)
    s.runs.attempt = attempt
    identifier = start(s)
    drain(s)
    result = detail(s, identifier)
    assert nodes == ['a', 'b', 'c'] and clock.waits == [30, 30]
    assert result['tasks'][0]['attempt_count'] == 3
    assert result['tasks'][0]['stats']['http_requests'] == 12 and result['tasks'][0]['stats']['http_429'] == 3
    assert result['status'] == ('succeeded' if succeed else 'partial')
    assert result['stats']['received_count'] == 4  # duplicate response row only ingested once
    assert FakeInstance.instances[-1].closed


def test_stranded_retry_commits_partial_once_with_actual_attempts(service, node_config):
    s = service
    s.dispatch('settings.save', {'platforms': ['linkedin']})
    setup_mihomo(s, node_config, port_count=1, batch_size=1, ips={'a': '8.8.8.8'})
    s.runs.attempt = lambda *args: outcome([record()], ERROR, http_requests=3, http_429=2)
    identifier = start(s)
    drain(s)
    result = detail(s, identifier)
    assert result['status'] == 'partial' and result['error']['code'] == 'PROXY_ERROR'
    task = result['tasks'][0]
    assert task['attempt_count'] == 1 and task['error']['code'] == 'PROXY_ERROR'
    assert task['stats']['http_requests'] == 3 and task['stats']['http_429'] == 2
    assert result['stats']['received_count'] == 1


def test_stop_while_retry_waits_does_not_send_again(service, node_config):
    s = service
    s.dispatch('settings.save', {'platforms': ['linkedin']})
    setup_mihomo(s, node_config, port_count=1, batch_size=1)
    waiting, calls = threading.Event(), []
    factory = s.runs.retrieval_options['pool_factory']
    def pool_factory(*args):
        pool = factory(*args)
        def wait(seconds):
            waiting.set()
            assert pool.stop.wait(3)
            return True
        pool.wait = wait
        return pool
    s.runs.retrieval_options['pool_factory'] = pool_factory
    s.runs.attempt = lambda *args: calls.append(True) or outcome([record()], ERROR, http_requests=1)
    identifier = start(s)
    s.runs.advance(lambda *a: None)
    assert waiting.wait(3)
    s.runs.stop({'run_id': identifier})
    drain(s)
    result = detail(s, identifier)
    assert result['status'] == 'stopped' and len(calls) == 1
    assert result['stats']['received_count'] == 0 and FakeInstance.instances[-1].closed


def test_disabled_port_returns_retry_to_other_live_port(service, node_config):
    s = service
    # Existing fixture has one query; add one more so both ports start a batch.
    configure(s, sites=['linkedin'])
    setup_mihomo(s, node_config, port_count=2, batch_size=1, concurrency_per_port=1)
    barrier, disabled = threading.Barrier(2), threading.Event()
    calls = []
    factory = s.runs.retrieval_options['pool_factory']
    def pool_factory(*args):
        pool = factory(*args)
        prepare = pool.prepare
        def dispatch(port, *, pressure=False):
            if port == 7901 and pressure:
                pool.disable(port)
                disabled.set()
                return False
            return prepare(port, pressure=pressure)
        pool.prepare = dispatch
        return pool
    s.runs.retrieval_options['pool_factory'] = pool_factory
    def attempt(spec, params, proxy, stop):
        calls.append((spec['query_id'], proxy))
        if len(calls) <= 2:
            barrier.wait(3)
            if proxy.endswith(':7901'):
                return outcome([record('partial')], ERROR, http_requests=2, http_429=1)
            assert disabled.wait(3)
        return outcome([record(spec['query_id'])], http_requests=1)
    s.runs.attempt = attempt
    identifier = start(s)
    drain(s)
    result = detail(s, identifier)
    assert result['status'] == 'succeeded' and len(calls) == 3
    failed_query = next(q for q, address in calls if address.endswith(':7901'))
    assert calls[-1] == (failed_query, 'http://127.0.0.1:7902')
    task = next(t for t in result['tasks'] if t['spec']['query_id'] == failed_query)
    assert task['attempt_count'] == 2 and task['stats']['http_requests'] == 3 and task['stats']['http_429'] == 1
