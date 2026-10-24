"""Run against a built backend with a local rejecting fake kernel, never real nodes.

uv run --locked python tests/mihomo_service_smoke.py /absolute/path/to/job-vaccum-service
"""
import json
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    executable = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix='m6-frozen-') as directory:
        root = Path(directory)
        fake = root / 'fake kernel'
        fake.write_text('#!' + sys.executable + '\n' + Path(__file__).with_name('fake_mihomo_kernel.py').read_text())
        fake.chmod(0o700)
        nodes = root / 'nodes.yaml'
        nodes.write_text('proxies:\n  - name: synthetic\n    type: socks5\n    server: 127.0.0.1\n    port: 1\n    password: synthetic-secret\n')
        child = subprocess.Popen([executable, '--data-dir', str(root / 'data')], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                 cwd='/', env={'PATH': '/usr/bin:/bin'})
        messages, sequence = queue.Queue(), 0
        def read():
            for line in child.stdout:
                messages.put(json.loads(line))
        threading.Thread(target=read, daemon=True).start()
        def request(method, params=None):
            nonlocal sequence
            sequence += 1
            child.stdin.write(json.dumps({'type': 'request', 'id': str(sequence), 'method': method, 'params': params or {}}) + '\n')
            child.stdin.flush()
            while True:
                value = messages.get(timeout=20)
                if value.get('id') == str(sequence):
                    assert value['ok'], value
                    return value['result']
        try:
            assert messages.get(timeout=15)['name'] == 'ready'
            diagnostics = request('app.diagnostics')
            assert diagnostics['frozen']
            request('settings.save', {'auto_score_enabled': False, 'platforms': ['linkedin'],
                'cities': [{'location': 'Synthetic', 'distance_miles': 1, 'enabled': True}],
                'run_mode': 'advanced', 'proxy': {'mode': 'mihomo', 'url': None},
                'mihomo': {'executable_path': str(fake), 'config_path': str(nodes), 'port_count': 1,
                           'start_port': free_port(), 'controller_port': free_port()}})
            direction = request('directions.save', {'name': 'Synthetic'})
            request('queries.save', {'direction_id': direction['id'], 'expression': 'synthetic'})
            run = request('runs.start')['run_id']
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                result = request('runs.detail', {'run_id': run})
                if result['status'] not in ('running', 'stopping'):
                    break
                time.sleep(.05)
            assert result['status'] == 'failed', result
            assert result['error']['code'] == 'PROXY_ERROR'
            assert result['stats']['proxy']['candidate_failures'] == 1  # kernel/controller actually worked
            assert result['tasks'][0]['attempt_count'] == 0  # no JobSpy/public traffic
            assert 'synthetic-secret' not in json.dumps(result)
            assert not list((root / 'data' / 'tmp').iterdir())
            child.stdin.close()
            assert child.wait(timeout=12) == 0
            print('PASS: frozen imports, M6 protocol, YAML, spawned owner/controller, local exit rejection, no direct fallback, cleanup and EOF')
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(3)
            error = child.stderr.read()
            assert 'synthetic-secret' not in error


if __name__ == '__main__':
    main()
