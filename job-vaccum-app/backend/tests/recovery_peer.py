"""Subprocess-only fault harness; never installed or reachable by the protocol.

Every scrape/model response is synthetic. Hard exits bypass finally/SQLite
rollback so recovery tests exercise the on-disk crash boundary.
"""
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import time

from job_vaccum import __main__ as entry
from job_vaccum.service import server
from job_vaccum.pipeline.configuration import PARAMETERS
from job_vaccum.pipeline.scraper import process_attempt

MODE = sys.argv.pop(1) if __name__ == '__main__' else 'normal'
ROOT = Path(sys.argv[sys.argv.index('--data-dir') + 1]) if __name__ == '__main__' else None
CALLS = ROOT.parent / (ROOT.name + '-calls.jsonl') if ROOT else None
PARAMETERS['retry_base_seconds'] = 0


def blocked(*args, **kwargs):
    raise AssertionError('Recovery fixtures never access the network')


socket.socket.connect = blocked
socket.create_connection = blocked


def record_call(kind, **fields):
    with CALLS.open('a') as stream:
        stream.write(json.dumps({'kind': kind, **fields}) + '\n')


def crash():
    os._exit(73)


class FaultConnection(sqlite3.Connection):
    boundary = None

    def execute(self, sql, parameters=()):
        if "INSERT INTO run_tasks" in sql and "'score'" in sql and MODE == 'register_before':
            crash()
        result = super().execute(sql, parameters)
        if "INSERT INTO run_tasks" in sql and "'score'" in sql and MODE == 'register_after':
            crash()
        if sql.startswith('UPDATE run_tasks SET status=?,') and parameters[0] == 'succeeded':
            kind = super().execute('SELECT kind FROM run_tasks WHERE id=?', (parameters[-1],)).fetchone()[0]
            self.boundary = 'batch' if kind == 'retrieval' else 'score'
        return result

    def __exit__(self, exc_type, exc, traceback):
        boundary, self.boundary = self.boundary, None
        if exc_type is None and MODE == f'{boundary}_before_commit':
            crash()
        value = super().__exit__(exc_type, exc, traceback)
        if exc_type is None and MODE == f'{boundary}_after_commit':
            crash()
        return value


original_sqlite_connect = sqlite3.connect


def fault_connect(*args, **kwargs):
    return original_sqlite_connect(*args, factory=FaultConnection, **kwargs)


sqlite3.connect = fault_connect


def fake_attempt(spec, parameters, proxy, stop):
    record_call('scrape', site=spec['site'], location=spec['location'])
    if MODE.startswith('score_') and spec['site'] == 'linkedin':
        # Keep the next batch uncommitted until the score boundary crashes us.
        # Thread scheduling must not decide which transaction the test observes.
        while True:
            time.sleep(1)
    if MODE == 'hang_scrape':
        return process_attempt(spec, parameters, proxy, stop, HangingScraper(CALLS))
    if MODE == 'worker_crash':
        return process_attempt(spec, parameters, proxy, stop, ExitingScraper())
    records = [{'id': name, 'site': spec['site'], 'title': 'Engineer', 'company': 'Example',
                'description': 'Build software.', 'job_url': f'https://example.test/{name}',
                'job_url_direct': f'https://external.test/{name}'} for name in ('a', 'b')]
    return {'records': records, 'error': None, 'warnings': []}


class HangingScraper:
    def __init__(self, calls):
        self.calls = calls

    def __call__(self, **kwargs):
        import signal
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        with self.calls.open('a') as stream:
            stream.write(json.dumps({'kind': 'child', 'pid': os.getpid()}) + '\n')
        while True:
            time.sleep(1)


class ExitingScraper:
    def __call__(self, **kwargs):
        os._exit(74)


def fake_model(model, key, system, prompt):
    if MODE == 'score_dispatch':
        crash()
    record_call('model', model=model['model_id'], key=key, system=system)
    if MODE in ('hang_model', 'slow_model'):
        if MODE == 'slow_model':
            time.sleep(0.4)
        else:
            while True:
                time.sleep(1)
    return '{"score":0,"reason":"Synthetic success"}'


original_serve = server.serve


def fake_serve(*args, **kwargs):
    kwargs.update(attempt=fake_attempt, llm_options={'transport': fake_model, 'rpm': 600000, 'retry_base': 0})
    return original_serve(*args, **kwargs)


entry.serve = fake_serve

if MODE == 'cleanup_failure':
    real_unlink = Path.unlink
    def fail_unlink(path, *args, **kwargs):
        if path.name == 'injected.tmp':
            raise PermissionError('Synthetic deletion failure')
        return real_unlink(path, *args, **kwargs)
    Path.unlink = fail_unlink

if __name__ == '__main__':
    raise SystemExit(entry.main())
