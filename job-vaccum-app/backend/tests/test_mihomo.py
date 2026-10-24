from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time

import pytest

from job_vaccum.pipeline.advanced import MIHOMO
from job_vaccum.pipeline.configuration import PARAMETERS
from job_vaccum.pipeline.scraper import process_attempt, retrieve
from job_vaccum.proxy.mihomo import Instance, check_ports, generated_config, nodes_from
from job_vaccum.proxy.pool import PortPool
from job_vaccum.service.protocol import CommandError
from job_vaccum.service.server import Service
from job_vaccum.storage.database import connect
from test_pipeline import configure, outcome, record, drain, detail, start
from test_scoring import pump


@pytest.fixture
def service(tmp_path):
    db = connect(tmp_path / 'app.sqlite3')
    (tmp_path / 'tmp').mkdir()
    s = Service(db, tmp_path, attempt=lambda *a: outcome([record()]))
    configure(s)
    yield s
    s.runs.close()
    db.close()


@pytest.mark.parametrize('patch', [
    {'llm_rpm': None}, {'llm_rpm': 0}, {'llm_rpm': float('inf')}, {'llm_concurrency': True},
    {'max_attempts': 1.5}, {'hours_old': -1}, {'retrieval_concurrency': {'linkedin': 0}},
    {'results_wanted': {'other': 1}}, {'llm_read_timeout_seconds': -1}, {'api_key': 'secret'},
])
def test_invalid_parameters_atomic(service, patch):
    before = service.settings()
    with pytest.raises(CommandError):
        service.dispatch('settings.save', {'country_indeed': 'canada', 'advanced_parameters': patch})
    assert service.settings() == before


@pytest.mark.parametrize('patch', [
    {'start_port': 65535, 'port_count': 2}, {'controller_port': 7901}, {'port_count': 0},
    {'http_429_ratio': 0}, {'http_429_ratio': 1.1}, {'cooldown_seconds': -1},
    {'config_path': 'relative.yaml'}, {'secret': 'private'}, {'concurrency_per_port': False},
])
def test_invalid_mihomo_atomic(service, patch):
    before = service.settings()
    with pytest.raises(CommandError):
        service.dispatch('settings.save', {'mihomo': patch})
    assert service.settings() == before


def test_partial_settings_restart_effective_snapshot_and_resume(service):
    s = service
    s.dispatch('settings.save', {'advanced_parameters': {'results_wanted': {'linkedin': 17}, 'llm_rpm': 22}})
    assert s.runs.preview({})['parameters']['results_wanted']['linkedin'] == 10
    s.dispatch('settings.save', {'run_mode': 'advanced', 'advanced_parameters': {'hours_old': 0}})
    assert s.settings()['advanced_parameters']['results_wanted'] == {'linkedin': 17, 'indeed': 200}
    assert s.settings()['advanced_parameters']['llm_rpm'] == 22
    calls = []
    s.runs.attempt = lambda spec, params, proxy, stop: (calls.append((spec, params, proxy)) or outcome())
    identifier = start(s)
    snapshot = detail(s, identifier)['config_snapshot']
    s.dispatch('settings.save', {'advanced_parameters': {'results_wanted': {'linkedin': 99}}})
    drain(s)
    assert all(p['hours_old'] == 0 and p['results_wanted']['linkedin'] == 17 and address is None for _, p, address in calls)
    assert detail(s, identifier)['config_snapshot'] == snapshot
    with s.repo.db:
        s.repo.db.execute("UPDATE runs SET status='interrupted' WHERE id=?", (identifier,))
        s.repo.db.execute("UPDATE run_tasks SET status='pending' WHERE run_id=?", (identifier,))
    s.runs.resume({'run_id': identifier})
    drain(s)
    assert all(p['results_wanted']['linkedin'] == 17 for _, p, _ in calls)
    other = connect(s.root / 'app.sqlite3')
    try:
        from job_vaccum.storage.repository import Repository
        assert Repository(other).settings()['advanced_parameters']['results_wanted']['linkedin'] == 99
    finally:
        other.close()


@pytest.mark.parametrize('mode', ['off', 'ordinary'])
def test_platform_concurrency_and_ordinary_routing(service, mode):
    s = service
    configure(s, directions=3)
    s.dispatch('settings.save', {'run_mode': 'advanced', 'advanced_parameters': {
        'retrieval_concurrency': {'linkedin': 2, 'indeed': 1}},
        'proxy': {'mode': mode, 'url': 'http://127.0.0.1:8181'}})
    barrier, lock = threading.Barrier(3), threading.Lock()
    counts, peaks, calls = {'linkedin': 0, 'indeed': 0}, {'linkedin': 0, 'indeed': 0}, []
    def attempt(spec, params, address, stop):
        site = spec['site']
        with lock:
            calls.append(address)
            counts[site] += 1
            peaks[site] = max(peaks[site], counts[site])
            first = len(calls) <= 3
        if first:
            barrier.wait(3)
        time.sleep(.02)
        with lock:
            counts[site] -= 1
        return outcome()
    s.runs.attempt = attempt
    identifier = start(s)
    drain(s)
    assert detail(s, identifier)['status'] == 'succeeded'
    assert peaks == {'linkedin': 2, 'indeed': 1}
    assert set(calls) == ({None} if mode == 'off' else {'http://127.0.0.1:8181'})


class FakeController:
    def __init__(self):
        self.selected, self.checks, self.switches = {}, [], []
        self.bad = set()

    def delay(self, node, threshold):
        self.checks.append((node, threshold))
        return node not in self.bad

    def select(self, port, node):
        self.selected[port] = node
        self.switches.append((port, node))


class Clock:
    def __init__(self):
        self.now, self.waits = 0, []

    def __call__(self):
        return self.now

    def wait(self, seconds):
        self.waits.append(seconds)
        self.now += seconds
        return False


def make_pool(ips=None, **changes):
    controller, clock, stop = FakeController(), Clock(), threading.Event()
    ips = ips or {'a': '8.8.8.8', 'b': '1.1.1.1', 'c': '9.9.9.9'}
    pool = PortPool({**MIHOMO, **changes}, list(ips), controller, stop,
                    probe=lambda p: ips[controller.selected[p]], clock=clock, wait=clock.wait, shuffle=lambda x: None)
    return pool, controller, clock


def test_exit_dedup_restore_and_cooldown():
    ips = {'a': '8.8.8.8', 'b': '8.8.8.8', 'c': '1.1.1.1'}
    pool, ctrl, clock = make_pool(ips)
    assert pool.prepare(7901) and pool.active[7901] == ('a', '8.8.8.8')
    assert pool.prepare(7902) and pool.active[7902] == ('c', '1.1.1.1')
    assert pool.prepare(7901)  # duplicate b rejected; a is reverified and retained
    assert ctrl.selected[7901] == 'a' and clock.waits == [5]
    assert pool.stats['candidate_failures'] == 1  # failed b is shared across ports
    assert ctrl.checks.count(('a', 1000)) == 4  # retention repeats both checks
    pool.disable(7901)
    assert not pool.prepare(7903)  # old exit cooling, other node occupied
    clock.now += 300
    assert pool.prepare(7903) and pool.active[7903][1] == '8.8.8.8'


def test_node_reservation_during_concurrent_detection():
    pool, ctrl, clock = make_pool()
    entered, release = threading.Event(), threading.Event()
    original = ctrl.delay
    def delay(node, threshold):
        if node == 'a' and not entered.is_set():
            entered.set()
            assert release.wait(3)
        return original(node, threshold)
    ctrl.delay = delay
    t = threading.Thread(target=pool.prepare, args=(7901,))
    t.start()
    assert entered.wait(3)
    assert pool.prepare(7902) and pool.active[7902][0] == 'b'
    release.set()
    t.join(3)
    assert pool.active[7901][0] == 'a' and not pool.testing


def test_pressure_finite_backoff_no_retain_and_actual_ratio():
    pool, ctrl, clock = make_pool({'a': '8.8.8.8'}, max_candidates=1)
    assert pool.prepare(7901)
    assert not pool.pressured([{'http_requests': 100, 'http_429': 1}])
    assert pool.pressured([{'http_requests': 20, 'http_429': 3}])
    assert pool.pressured([{'http_requests': 20, 'http_429': 0, 'access_failed': True}])
    assert not pool.prepare(7901, pressure=True)
    assert clock.waits == [30, 30]
    assert not pool.active and pool.stats['disabled_ports'] == 1 and pool.stats['retained'] == 0


def test_pressure_wait_interrupts():
    pool, ctrl, clock = make_pool()
    pool.wait = lambda seconds: pool.stop.set() or True
    assert not pool.prepare(7901, pressure=True)
    assert not ctrl.checks


@pytest.fixture
def node_config(tmp_path):
    source = tmp_path / 'nodes.yaml'
    source.write_text('proxies:\n  - name: synthetic-node\n    type: socks5\n    server: 127.0.0.1\n    port: 4444\n    password: synthetic-password\nproxy-providers:\n  ignored: {}\n')
    return {**MIHOMO, 'executable_path': sys.executable, 'config_path': str(source)}


def test_node_validation_original_unchanged_and_generated_isolation(node_config):
    source = Path(node_config['config_path'])
    original = source.read_bytes()
    nodes = nodes_from(node_config)
    cfg = generated_config(node_config, nodes, 'synthetic-secret')
    assert len(cfg['listeners']) == 8 and all(l['listen'] == '127.0.0.1' and l['proxy'].startswith('job-vaccum-') for l in cfg['listeners'])
    assert 'proxy-providers' not in cfg and cfg['rules'] == ['MATCH,REJECT']
    assert source.read_bytes() == original
    for content in ['proxy-providers: {test: {}}', 'proxies: [not-a-node]', '!!python/object:secret {}',
                    'proxies: [{name: a, type: direct, server: localhost, port: 1}]']:
        source.write_text(content)
        with pytest.raises(CommandError, match='concrete'):
            nodes_from(node_config)


def test_port_conflict_leaves_other_service_alive(node_config, loopback):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        node_config['controller_port'] = listener.getsockname()[1]
        with pytest.raises(CommandError, match='occupied'):
            check_ports(node_config)
        with socket.socket() as client:
            client.connect(listener.getsockname())


class FakeInstance:
    instances = []
    def __init__(self, config, root, stop):
        self.nodes = [{'name': n} for n in ['a', 'b', 'c']]
        self.controller = FakeController()
        self.closed = False
        self.instances.append(self)
    def start(self):
        return self
    def close(self):
        self.closed = True


def setup_mihomo(s, config, *, ips=None, **changes):
    s.dispatch('settings.save', {'run_mode': 'advanced', 'mihomo': {**config, **changes}, 'proxy': {'mode': 'mihomo', 'url': None}})
    ips = ips or {'a': '8.8.8.8', 'b': '1.1.1.1', 'c': '9.9.9.9'}
    clock = Clock()
    s.runs.retrieval_options = {'instance_factory': FakeInstance,
        'pool_factory': lambda c, n, ctrl, stop: PortPool(c, n, ctrl, stop,
            probe=lambda p: ips[ctrl.selected[p]], clock=clock, wait=clock.wait, shuffle=lambda x: None)}
    return clock


def test_pool_pressure_unassigned_tasks_preserved_partial_and_cleanup(service, node_config):
    s = service
    configure(s, directions=4)
    clock = setup_mihomo(s, node_config, ips={'a': '8.8.8.8', 'b': '8.8.8.8', 'c': '8.8.8.8'},
                         port_count=1, batch_size=2, concurrency_per_port=2)
    calls = []
    def attempt(spec, params, address, stop):
        calls.append((spec['site'], address))
        return outcome([record(spec['query_id'], site=spec['site'])], http_requests=2, http_429=1)
    s.runs.attempt = attempt
    identifier = start(s)
    drain(s)
    result = detail(s, identifier)
    assert result['status'] == 'partial' and result['error']['code'] == 'PROXY_ERROR'
    assert sum(site == 'linkedin' for site, _ in calls) == 2
    assert all(address is None for site, address in calls if site == 'indeed')
    assert all(address == 'http://127.0.0.1:7901' for site, address in calls if site == 'linkedin')
    unexecuted = [t for t in result['tasks'] if t['attempt_count'] == 0]
    assert unexecuted and all(t['error']['code'] == 'PROXY_ERROR' for t in unexecuted)
    assert result['stats']['proxy']['disabled_ports'] == 1 and clock.waits == [30, 30]
    assert FakeInstance.instances[-1].closed
    assert 'synthetic-password' not in json.dumps(result)


def test_rotation_waits_for_whole_batch_and_other_port_continues(service, node_config):
    s = service
    configure(s, sites=['linkedin'], directions=5)
    setup_mihomo(s, node_config, port_count=2, batch_size=2, concurrency_per_port=2)
    lock = threading.Lock()
    active, calls = {}, []
    blocked, release, other = threading.Event(), threading.Event(), threading.Event()
    def attempt(spec, params, address, stop):
        port = int(address.rsplit(':', 1)[1])
        ctrl = FakeInstance.instances[-1].controller
        with lock:
            node = ctrl.selected[port]
            active[port] = active.get(port, 0) + 1
            calls.append(port)
            first = len(calls) == 1
        if first:
            blocked.set()
            assert release.wait(4)
        else:
            other.set()
            time.sleep(.03)
        assert ctrl.selected[port] == node
        with lock:
            active[port] -= 1
        return outcome()
    s.runs.attempt = attempt
    identifier = start(s)
    s.runs.advance(lambda *a: None)
    assert blocked.wait(3) and other.wait(3)
    release.set()
    drain(s)
    assert detail(s, identifier)['status'] == 'succeeded'
    assert set(calls) == {7901, 7902} and FakeInstance.instances[-1].closed


def test_stop_during_pool_start_cleanup_no_direct_fallback(service, node_config):
    s = service
    configure(s, sites=['linkedin'])
    setup_mihomo(s, node_config, port_count=1)
    entered = threading.Event()
    class SlowInstance(FakeInstance):
        def __init__(self, config, root, stop):
            super().__init__(config, root, stop)
            self.stop = stop
        def start(self):
            entered.set()
            assert self.stop.wait(3)
            raise CommandError('Cancelled pool startup.', 'PROXY_ERROR')
    s.runs.retrieval_options['instance_factory'] = SlowInstance
    s.runs.attempt = lambda *a: pytest.fail('Must not fall back to direct')
    identifier = start(s)
    s.runs.advance(lambda *a: None)
    assert entered.wait(3)
    s.runs.stop({'run_id': identifier})
    drain(s)
    assert detail(s, identifier)['status'] == 'stopped' and FakeInstance.instances[-1].closed

CONNECT = socket.socket.connect


@pytest.fixture
def loopback(monkeypatch):
    def local_connect(sock, address):
        assert address[0] == '127.0.0.1'
        return CONNECT(sock, address)
    monkeypatch.setattr(socket.socket, 'connect', local_connect)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


@pytest.fixture
def kernel_config(node_config, tmp_path):
    script = tmp_path / 'fake kernel'
    script.write_text('#!' + sys.executable + '\n' + Path(__file__).with_name('fake_mihomo_kernel.py').read_text())
    script.chmod(0o700)
    return {**node_config, 'executable_path': str(script), 'port_count': 1,
            'start_port': free_port(), 'controller_port': free_port()}


def wait_dead(pid):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(.02)
    pytest.fail('Owned test process was not reaped')


def test_real_owner_process_local_controller_and_cleanup(kernel_config, tmp_path, loopback):
    (tmp_path / 'tmp').mkdir()
    instance = Instance(kernel_config, tmp_path, threading.Event())
    source = Path(kernel_config['config_path']).read_bytes()
    try:
        instance.start()
        pid = int((instance.directory / 'kernel.pid').read_text())
        directory = instance.directory
        assert (directory / 'config.yaml').stat().st_mode & 0o777 == 0o600
        assert directory.stat().st_mode & 0o777 == 0o700
        instance.controller.select(kernel_config['start_port'], 'synthetic-node')
        assert instance.controller.delay('synthetic-node', 1000)
    finally:
        instance.close()
    wait_dead(pid)
    assert not directory.exists()
    assert Path(kernel_config['config_path']).read_bytes() == source
    check_ports(kernel_config)


def test_owner_loss_reaps_kernel_without_pid_scan(kernel_config, tmp_path):
    (tmp_path / 'tmp').mkdir()
    helper = tmp_path / 'owner.py'
    helper.write_text('''from pathlib import Path
import json, threading, sys, time
from job_vaccum.proxy.mihomo import Instance
if __name__ == '__main__':
    instance = Instance(json.loads(sys.argv[1]), Path(sys.argv[2]), threading.Event())
    instance.start()
    print(json.dumps({'directory': str(instance.directory), 'pid': int((instance.directory / 'kernel.pid').read_text())}), flush=True)
    time.sleep(60)
''')
    parent = subprocess.Popen([sys.executable, str(helper), json.dumps(kernel_config), str(tmp_path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        import select
        assert select.select([parent.stdout], [], [], 15)[0]
        result = json.loads(parent.stdout.readline())
        parent.kill()
        parent.wait(3)
        wait_dead(result['pid'])
        deadline = time.monotonic() + 3
        while Path(result['directory']).exists() and time.monotonic() < deadline:
            time.sleep(.02)
        assert not Path(result['directory']).exists()
        check_ports(kernel_config)
    finally:
        if parent.poll() is None:
            parent.kill()
        parent.communicate(timeout=8)


def test_kernel_validation_failure_is_sanitized_and_cleans(kernel_config, tmp_path):
    script = Path(kernel_config['executable_path'])
    script.write_text('#!' + sys.executable + '\nimport sys\nprint("synthetic-password")\nsys.exit(1)\n')
    (tmp_path / 'tmp').mkdir()
    instance = Instance(kernel_config, tmp_path, threading.Event())
    try:
        with pytest.raises(CommandError, match='validation') as exc:
            instance.start()
        assert 'synthetic-password' not in str(exc.value)
    finally:
        instance.close()
    assert not list((tmp_path / 'tmp').iterdir())


def observed_scrape(**kwargs):
    """Exercise the pinned JobSpy network wrapper inside a real spawn worker."""
    import pandas as pd
    from jobspy.util import RequestsRotating
    from curl_cffi import requests as curl_requests
    with RequestsRotating() as session:
        assert session.get(kwargs['search_term']).status_code == 429
        assert session.get(kwargs['search_term']).status_code == 200
    with curl_requests.Session() as session:
        assert session.get(kwargs['search_term']).status_code == 200
    return pd.DataFrame()  # underlying recovered 429 is not a failed query


def test_actual_worker_http_statistics_recovered_429_no_query_retry():
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass
        def do_GET(self):
            calls.append(self.path)
            self.send_response(429 if len(calls) == 1 else 200)
            self.end_headers()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        spec = {'site': 'linkedin', 'expression': f'http://127.0.0.1:{server.server_port}/synthetic', 'location': 'Chicago', 'distance_miles': 25}
        result = retrieve(spec, PARAMETERS, None, threading.Event(), partial(process_attempt, scrape=observed_scrape))
        assert result['error'] is None and result['attempts'] == 1
        assert result['http_requests'] == 3 and result['http_429'] == 1 and len(calls) == 3
        pool, _, _ = make_pool()
        assert pool.pressured([result])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)


def test_llm_advanced_parallelism_shared_gate_and_snapshot(service):
    s = service
    from job_vaccum.storage.synthetic import import_synthetic
    import_synthetic(s.repo, {'count': 4})
    s.dispatch('internal.credentials', {'model_key': 'synthetic'})
    s.dispatch('settings.save', {'rubric': 'synthetic', 'model': {'protocol': 'chat_completions', 'model_id': 'fake', 'base_url': 'http://127.0.0.1:1'},
                               'run_mode': 'advanced', 'advanced_parameters': {'llm_concurrency': 2, 'llm_rpm': 1200, 'max_attempts': 1}})
    lock, release = threading.Lock(), threading.Event()
    entered, calls = threading.Event(), []
    def transport(*args):
        with lock:
            calls.append(time.monotonic())
            if len(calls) == 2:
                entered.set()
        assert release.wait(3)
        return '{"score":0,"reason":"synthetic"}'
    s.llm.transport = transport
    identifier = s.dispatch('jobs.score', {'filter': {'scope': 'discover'}})['run_id']
    s.runs.advance(lambda *a: None)
    assert entered.wait(3) and len(calls) == 2
    assert calls[1] - calls[0] >= .045
    s.dispatch('settings.save', {'advanced_parameters': {'llm_concurrency': 1, 'llm_rpm': 1}})
    s.dispatch('model.test', {})  # shares run limits, cannot create a third in-flight call
    time.sleep(.1)
    assert len(calls) == 2
    release.set()
    pump(s)
    assert detail(s, identifier)['status'] == 'succeeded' and len(calls) == 5
    assert all(b-a >= .045 for a, b in zip(calls, calls[1:]))


def test_llm_timeout_and_retry_parameters_reach_transport(service, monkeypatch):
    import job_vaccum.llm.pool as module
    from job_vaccum.llm.http import ModelError
    s = service
    seen = []
    def generate(*args, timeout):
        seen.append(timeout)
        raise ModelError('NETWORK_ERROR', 'Synthetic', retryable=True)
    monkeypatch.setattr(module, 'generate', generate)
    s.llm.transport = generate
    s.dispatch('internal.credentials', {'model_key': 'synthetic'})
    s.dispatch('settings.save', {'model': {'protocol': 'chat_completions', 'model_id': 'fake', 'base_url': 'http://127.0.0.1:1'},
        'run_mode': 'advanced', 'advanced_parameters': {'llm_rpm': 600000, 'max_attempts': 2,
        'retry_base_seconds': .01, 'llm_connect_timeout_seconds': 2, 'llm_read_timeout_seconds': 7}})
    s.dispatch('model.test', {})
    pump(s)
    assert seen == [(2, 7), (2, 7)]


def test_stopping_concurrent_pool_and_scores_waits_and_keeps_success(service, node_config):
    s = service
    configure(s, sites=['linkedin'], directions=4, scoring=True)
    s.dispatch('internal.credentials', {'model_key': 'synthetic'})
    s.dispatch('settings.save', {'advanced_parameters': {'llm_concurrency': 2, 'llm_rpm': 600000}})
    setup_mihomo(s, node_config, port_count=1, batch_size=2, concurrency_per_port=2)
    scores_started, scores_release, scrape_started = threading.Event(), threading.Event(), threading.Event()
    calls, score_calls = [], []
    lock = threading.Lock()
    def attempt(spec, params, address, stop):
        with lock:
            calls.append(spec['query_id'])
            number = len(calls)
        if number > 2:
            scrape_started.set()
            stop.wait(3)
        return outcome([record(spec['query_id'], company=spec['query_id'])])
    def llm(*args):
        with lock:
            score_calls.append(1)
            if len(score_calls) == 2:
                scores_started.set()
        assert scores_release.wait(4)
        return '{"score":0,"reason":"Saved while stopping"}'
    s.runs.attempt, s.llm.transport = attempt, llm
    identifier = start(s)
    event = lambda *a: None
    s.runs.advance(event)
    deadline = time.monotonic() + 4
    while not scores_started.is_set():
        assert time.monotonic() < deadline
        try:
            kind, payload = s.inbox.get(timeout=.1)
        except queue.Empty:
            continue
        if kind.startswith('llm_'):
            s.handle_llm(kind, payload, event)
        else:
            s.runs.handle(kind, payload, event)
    assert scrape_started.wait(3)
    s.runs.stop({'run_id': identifier})
    with pytest.raises(CommandError, match='active'):
        start(s)
    assert detail(s, identifier)['status'] == 'stopping'
    scores_release.set()
    pump(s)
    result = detail(s, identifier)
    assert result['status'] == 'stopped' and result['stats']['scoring']['succeeded'] == 2
    assert FakeInstance.instances[-1].closed and len(score_calls) == 2
    assert s.repo.db.execute('SELECT count(*) FROM jobs WHERE score=0').fetchone()[0] == 2


def test_scheduled_pool_failure_records_run_and_releases_waiting(service, node_config):
    s = service
    setup_mihomo(s, node_config, port_count=1)
    class FailedInstance(FakeInstance):
        def start(self):
            raise CommandError('Synthetic pool startup failure.', 'PROXY_ERROR')
    s.runs.retrieval_options['instance_factory'] = FailedInstance
    schedules = [s.dispatch('schedules.save', {'enabled': True, 'direction_ids': None,
                'time': '09:00', 'weekdays': [], 'timezone': 'America/Chicago'}) for _ in range(2)]
    now = s.schedules.list({})['items'][0]['next_at']
    s.repo.clock = lambda: now
    s.dispatch('schedules.trigger', {'schedule_id': schedules[0]['id'], 'scheduled_at': now})
    s.dispatch('schedules.trigger', {'schedule_id': schedules[1]['id'], 'scheduled_at': now})
    event = lambda *a: None
    s.schedules.advance(event)
    drain(s)
    assert not s.runs.active()
    s.schedules.advance(event)
    drain(s)
    runs = s.runs.list({})['items']
    assert len(runs) == 2 and all(r['status'] == 'partial' and r['error']['code'] == 'PROXY_ERROR' for r in runs)
    for run in runs:
        tasks = detail(s, run['id'])['tasks']
        assert all(t['status'] == ('succeeded' if t['spec']['site'] == 'indeed' else 'failed') for t in tasks)
    assert all(r['trigger']['source'] == 'schedule' for r in runs)
    assert not s.repo.db.execute("SELECT 1 FROM schedule_firings WHERE outcome='waiting'").fetchone()


def test_failed_port_leaves_remaining_queue_to_healthy_port(service, node_config):
    s = service
    configure(s, sites=['linkedin'], directions=4)
    setup_mihomo(s, node_config, port_count=2, batch_size=1)
    factory = s.runs.retrieval_options['pool_factory']
    def make(*args):
        pool = factory(*args)
        original = pool.prepare
        def prepare(port, **kwargs):
            if port == 7901:
                pool.disable(port)
                return False
            return original(port, **kwargs)
        pool.prepare = prepare
        return pool
    s.runs.retrieval_options['pool_factory'] = make
    addresses = []
    s.runs.attempt = lambda spec, params, address, stop: addresses.append(address) or outcome()
    identifier = start(s)
    drain(s)
    assert detail(s, identifier)['status'] == 'succeeded'
    assert len(addresses) == 5 and set(addresses) == {'http://127.0.0.1:7902'}


def test_slow_rate_change_preserves_non_bursting_gate():
    from job_vaccum.llm.pool import LlmPool
    pool = LlmPool(queue.Queue(), rpm=600)
    clock = Clock()
    pool.gate.clock = clock
    try:
        assert pool.gate.enter(threading.Event())
        pool.gate.release()
        pool.configure({**PARAMETERS, 'llm_rpm': 1})
        assert pool.gate.next_start == 60
    finally:
        pool.close()
