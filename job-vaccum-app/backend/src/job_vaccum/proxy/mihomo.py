"""Isolated Mihomo configuration, controller, and owner-loss cleanup."""
import ipaddress
import json
import logging
import multiprocessing
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import quote

import requests
import yaml

from job_vaccum.service.protocol import CommandError

DELAY_URL = 'https://www.gstatic.com/generate_204'
EXIT_URL = 'https://api.ipify.org'


def failure(message):
    return CommandError(message, 'PROXY_ERROR')


def nodes_from(config):
    """Read only explicit proxies. Never echo YAML/parser errors or node secrets."""
    executable, source = config['executable_path'], config['config_path']
    if not executable or not Path(executable).is_file() or not os.access(executable, os.X_OK):
        raise failure('Select an executable Mihomo kernel.')
    if not source:
        raise failure('Select a local Mihomo configuration containing concrete proxies.')
    try:
        with open(source, encoding='utf-8') as stream:
            value = yaml.safe_load(stream)
        nodes = value.get('proxies') if isinstance(value, dict) else None
        if not isinstance(nodes, list) or not nodes:
            raise ValueError
        names = set()
        for node in nodes:
            if not isinstance(node, dict) or not all(isinstance(node.get(k), str) and node[k].strip() for k in ('name', 'type', 'server')):
                raise ValueError
            # Each node must be independently dialable; user groups/providers and
            # direct pseudo-nodes cannot turn a failed pool into direct traffic.
            if (node['name'] in names or node['name'] in ('DIRECT', 'REJECT', 'GLOBAL')
                    or node['name'].startswith('job-vaccum-') or 'dialer-proxy' in node
                    or node['type'].lower() in ('direct', 'reject', 'pass', 'dns', 'selector', 'url-test', 'fallback', 'load-balance')):
                raise ValueError
            if type(node.get('port')) is not int or not 1 <= node['port'] <= 65535:
                raise ValueError
            names.add(node['name'])
        # Serialize to ensure no YAML-only objects enter the generated config.
        json.dumps(nodes, allow_nan=False)
        return nodes
    except (OSError, ValueError, TypeError, yaml.YAMLError, RecursionError):
        raise failure('Mihomo requires valid YAML with unique, concrete standalone proxies; subscriptions and provider-only files are unsupported.') from None


def check_ports(config):
    sockets = []
    try:
        for port in [config['controller_port'], *range(config['start_port'], config['start_port'] + config['port_count'])]:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(sock)
            # Reuse closed connections in TIME_WAIT, never an active listener.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(('127.0.0.1', port))
            sock.listen(1)
    except OSError:
        raise failure('A Mihomo controller or listener port is occupied. Choose unused ports; no existing process was changed.') from None
    finally:
        for sock in sockets:
            sock.close()


def generated_config(config, nodes, secret):
    names = [n['name'] for n in nodes]
    groups, listeners = [], []
    for port in range(config['start_port'], config['start_port'] + config['port_count']):
        group = f'job-vaccum-{port}'
        groups.append({'name': group, 'type': 'select', 'proxies': names})
        listeners.append({'name': group, 'type': 'http', 'listen': '127.0.0.1', 'port': port, 'proxy': group})
    return {'allow-lan': False, 'bind-address': '127.0.0.1', 'mode': 'rule', 'ipv6': False,
            'log-level': 'silent', 'external-controller': f"127.0.0.1:{config['controller_port']}",
            'secret': secret, 'profile': {'store-selected': False, 'store-fake-ip': False},
            'proxies': nodes, 'proxy-groups': groups, 'listeners': listeners, 'rules': ['MATCH,REJECT']}


def _terminate(child):
    if child and child.poll() is None:
        child.terminate()
        try:
            child.wait(2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def own_kernel(connection, executable, directory):
    """A pipe EOF also cleans up after SIGKILL of the service; no saved PIDs."""
    child = None
    try:
        env = {k: v for k, v in os.environ.items() if k.casefold() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
        command = [executable, '-d', directory, '-f', str(Path(directory) / 'config.yaml')]
        child = subprocess.Popen([*command, '-t'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        deadline = time.monotonic() + 10
        while child.poll() is None:
            if connection.poll(0.05):
                connection.recv()  # stop or owner EOF
                return
            if time.monotonic() >= deadline:
                connection.send(False)
                return
        if child.returncode:
            connection.send(False)
            return
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        connection.send(True)
        while child.poll() is None:
            if connection.poll(0.1):
                connection.recv()
                return
    except (EOFError, BrokenPipeError, OSError):
        pass
    finally:
        _terminate(child)
        connection.close()
        try:
            shutil.rmtree(directory)
        except OSError:
            logging.error('CLEANUP_ERROR: Could not remove App Mihomo temporary resources.')


class Controller:
    def __init__(self, port, secret):
        self.base = f'http://127.0.0.1:{port}'
        self.secret = secret

    def request(self, method, path, *, timeout=(2, 3), **kwargs):
        try:
            with requests.Session() as session:
                session.trust_env = False
                with session.request(method, self.base + path, headers={'Authorization': 'Bearer ' + self.secret},
                                     timeout=timeout, allow_redirects=False, **kwargs) as response:
                    if not 200 <= response.status_code < 300:
                        raise ValueError
                    return response.json() if response.content else None
        except (requests.RequestException, ValueError):
            raise failure('Mihomo control request failed. Check the App kernel and configuration.') from None

    def ready(self):
        value = self.request('GET', '/version')
        if not isinstance(value, dict) or not value.get('version'):
            raise failure('Mihomo controller returned an invalid version.')

    def select(self, port, node):
        self.request('PUT', '/proxies/' + quote(f'job-vaccum-{port}', safe=''), json={'name': node})

    def delay(self, node, threshold):
        value = self.request('GET', '/proxies/' + quote(node, safe='') + '/delay',
                             params={'url': DELAY_URL, 'timeout': max(1, int(threshold)), 'expected': '204'},
                             timeout=(2, threshold / 1000 + 2))
        delay = value.get('delay') if isinstance(value, dict) else None
        return type(delay) in (int, float) and 0 < delay <= threshold


def exit_ipv4(port):
    try:
        with requests.Session() as session:
            session.trust_env = False
            proxy = f'http://127.0.0.1:{port}'
            with session.get(EXIT_URL, proxies={'http': proxy, 'https': proxy}, timeout=(3, 5), allow_redirects=False) as response:
                response.raise_for_status()
                address = ipaddress.IPv4Address(response.text.strip())
                if not address.is_global:
                    raise ValueError
                return str(address)
    except (requests.RequestException, ValueError):
        raise failure('Could not verify a public IPv4 through the Mihomo listener.') from None


class Instance:
    def __init__(self, config, root, stop):
        self.config, self.root, self.stop = config, root, stop
        self.owner = self.connection = self.directory = None
        self.nodes = []
        self.controller = None

    def start(self):
        self.nodes = nodes_from(self.config)
        check_ports(self.config)
        if self.stop.is_set():
            raise failure('Mihomo startup cancelled.')
        self.directory = Path(tempfile.mkdtemp(prefix='mihomo-', dir=self.root / 'tmp'))
        secret = secrets.token_urlsafe(32)
        config_file = self.directory / 'config.yaml'
        with config_file.open('x', encoding='utf-8') as stream:
            os.chmod(config_file, 0o600)
            json.dump(generated_config(self.config, self.nodes, secret), stream)
        context = multiprocessing.get_context('spawn')
        self.connection, child_connection = context.Pipe()
        self.owner = context.Process(target=own_kernel, args=(child_connection, self.config['executable_path'], str(self.directory)), name='mihomo-owner')
        self.owner.start()
        child_connection.close()
        self.controller = Controller(self.config['controller_port'], secret)
        deadline, validated = time.monotonic() + 15, False
        while not self.stop.is_set() and time.monotonic() < deadline and self.owner.is_alive():
            if not validated:
                if self.connection.poll(0.05):
                    try:
                        validated = self.connection.recv()
                    except EOFError:
                        break
                    if not validated:
                        break
            else:
                try:
                    self.controller.ready()
                    return self
                except CommandError:
                    self.stop.wait(0.1)
        raise failure('Mihomo failed validation or startup. Check the kernel, concrete nodes and free ports; no direct fallback was used.')

    def close(self):
        if self.connection:
            self.connection.close()  # owner kills/reaps its child, then removes temp
            self.connection = None
        if self.owner:
            self.owner.join(4)
            if self.owner.is_alive():
                raise failure('Mihomo owner did not finish cleanup.')
            self.owner.close()
            self.owner = None
        if self.directory and self.directory.exists():
            try:
                shutil.rmtree(self.directory)
            except OSError:
                raise failure('Could not remove App Mihomo temporary resources.') from None
