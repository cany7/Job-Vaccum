from contextlib import closing
from io import BytesIO
import json
import queue
import threading

from job_vaccum.service.server import serve
from job_vaccum.storage.database import connect
from job_vaccum.storage.repository import Repository
from job_vaccum.storage.synthetic import fixture_id, import_synthetic
from test_repository import NOW


def request(identifier, method, params=None):
    return json.dumps({'type': 'request', 'id': identifier, 'method': method, 'params': params or {}}).encode() + b'\n'


def run(tmp_path, data, **kwargs):
    output = BytesIO()
    serve(tmp_path, BytesIO(data), output, clock=lambda: NOW, **kwargs)
    messages = [json.loads(line) for line in output.getvalue().splitlines()]
    responses = {m['id']: m for m in messages if m['type'] == 'response'}
    events = [m for m in messages if m['type'] == 'event']
    assert [m['seq'] for m in events] == list(range(1, len(events) + 1))
    return responses, events


def test_command_errors_continue_and_development_gate(tmp_path):
    responses, events = run(tmp_path, request('denied', 'dev.import_synthetic'))
    assert responses['denied']['error']['code'] == 'NOT_FOUND'
    data = request('import', 'dev.import_synthetic', {'count': 3})
    data += request('bad-update', 'applications.update', {'job_id': fixture_id(1000), 'status': 'invalid'})
    data += request('bad-bulk', 'applications.add_many', {'job_ids': [fixture_id(1000), 1]})
    data += request('valid-bulk', 'applications.add_many', {'job_ids': [fixture_id(1000), 'missing']})
    data += request('settings', 'settings.save', {'retention_days': 0})
    data += request('list', 'jobs.list', {'scope': 'applications'})
    responses, events = run(tmp_path, data, enable_dev=True)
    assert responses['import']['result']['added_count'] == 3
    assert responses['bad-update']['error']['code'] == responses['bad-bulk']['error']['code'] == 'VALIDATION_ERROR'
    assert responses['valid-bulk']['result']['counts'] == {'added': 1, 'not_found': 1, 'already_present': 0}
    assert responses['list']['result']['total'] == 1
    assert any(e['name'] == 'jobs.changed' for e in events)


def test_export_async_completion_and_failure_events(tmp_path):
    params = {'scope': 'discover', 'range': 'all', 'include_jd': True, 'destination_path': str(tmp_path.parent / (tmp_path.name + '-export.csv'))}
    data = request('import', 'dev.import_synthetic', {'count': 125}) + request('export', 'export.csv', params)
    responses, events = run(tmp_path, data, enable_dev=True)
    completed = next(e for e in events if e['name'] == 'operation.completed')
    assert completed['data'] == {'operation_id': responses['export']['result']['operation_id'], 'row_count': 125}
    params['destination_path'] = str(tmp_path.parent / (tmp_path.name + '-nonexistent') / 'file.csv')
    responses, events = run(tmp_path, request('export', 'export.csv', params))
    failed = next(e for e in events if e['name'] == 'operation.failed')
    assert failed['data']['operation_id'] == responses['export']['result']['operation_id']
    assert failed['data']['error']['code'] == 'EXPORT_ERROR'
    assert str(tmp_path) not in failed['data']['error']['message']


def test_export_keeps_receiver_responsive_cleanup_busy_and_auto_deferred(tmp_path, monkeypatch):
    released = threading.Event()
    def slow_export(database, params):
        assert released.wait(5), 'List request was blocked by export'
        return {'row_count': 0}
    monkeypatch.setattr('job_vaccum.service.server.export_csv', slow_export)
    class Output(BytesIO):
        def write(self, data):
            message = json.loads(data)
            if message.get('id') == 'list':
                released.set()
            return super().write(data)
    params = {'scope': 'discover', 'range': 'all', 'include_jd': False, 'destination_path': str(tmp_path.parent / (tmp_path.name + '-file.csv'))}
    data = request('export', 'export.csv', params)
    data += request('busy', 'cleanup.execute', {'mode': 'manual'})
    data += request('export-busy', 'export.csv', params)
    data += request('status', 'app.status') + request('list', 'jobs.list')
    output = Output()
    serve(tmp_path, BytesIO(data), output, clock=lambda: NOW)
    messages = [json.loads(line) for line in output.getvalue().splitlines()]
    responses = {m['id']: m for m in messages if m['type'] == 'response'}
    assert responses['busy']['error']['code'] == responses['export-busy']['error']['code'] == 'BUSY'
    assert responses['status']['result']['operations'][0]['operation_id'] == responses['export']['result']['operation_id']
    assert responses['list']['ok'] is True


def test_startup_automatic_cleanup_and_frozen_fixture_gate(tmp_path, monkeypatch):
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        repo = Repository(db, lambda: NOW - 30 * 86_400_000)
        import_synthetic(repo, {'count': 2})
        repo.add({'job_id': fixture_id(1000)})
    (tmp_path / 'tmp').mkdir()
    (tmp_path / 'tmp' / 'stale').write_text('App temporary resource')
    monkeypatch.setattr('sys.frozen', True, raising=False)
    responses, _ = run(tmp_path, request('list', 'jobs.list') + request('denied', 'dev.import_synthetic'), enable_dev=True)
    assert responses['list']['result']['total'] == 1
    assert responses['denied']['error']['code'] == 'NOT_FOUND'
    assert not (tmp_path / 'tmp' / 'stale').exists()


def test_periodic_cleanup_without_incoming_requests(tmp_path):
    # Queue-backed input lets the actual receive loop idle while its timer fires.
    lines, output_messages = queue.Queue(), queue.Queue()
    class Input:
        def readline(self, _):
            return lines.get(timeout=5)
    class Output:
        def write(self, data):
            output_messages.put(json.loads(data))
        def flush(self):
            pass
    current = [NOW]
    errors = []
    def service():
        try:
            serve(tmp_path, Input(), Output(), clock=lambda: current[0], enable_dev=True, cleanup_interval=0.02)
        except BaseException as exc:
            errors.append(exc)
    thread = threading.Thread(target=service)
    thread.start()
    try:
        assert output_messages.get(timeout=5)['name'] == 'ready'
        lines.put(request('import', 'dev.import_synthetic', {'count': 2}))
        while output_messages.get(timeout=5).get('name') != 'jobs.changed':
            pass
        current[0] += 15 * 86_400_000
        while True:
            message = output_messages.get(timeout=5)
            if message.get('name') == 'cleanup.completed':
                assert message['data']['deleted_jobs'] == 2
                break
        lines.put(request('list', 'jobs.list'))
        while True:
            message = output_messages.get(timeout=5)
            if message.get('id') == 'list':
                assert message['result']['total'] == 0
                break
    finally:
        lines.put(b'')
        thread.join(5)
    assert not thread.is_alive() and not errors


def test_large_list_and_remove_return_errors_without_losing_data_or_connection(tmp_path):
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        repo = Repository(db, lambda: NOW)
        import_synthetic(repo, {'count': 200})
        identifiers = [fixture_id(1000 + index) for index in range(200)]
        repo.add({'job_ids': identifiers}, many=True)
        for identifier in identifiers:
            repo.update({'job_id': identifier, 'notes': 'x' * 6000})
    data = request('large-list', 'jobs.list', {'scope': 'applications', 'page_size': 200})
    data += request('large-remove', 'applications.remove', {'job_ids': identifiers})
    data += request('small-list', 'jobs.list', {'scope': 'applications', 'page_size': 50})
    data += request('ping', 'app.ping', {'message': 'still connected'})
    responses, events = run(tmp_path, data)
    for identifier in ('large-list', 'large-remove'):
        assert responses[identifier]['error']['code'] == 'RESPONSE_TOO_LARGE'
    assert responses['small-list']['result']['total'] == 200
    assert len(responses['small-list']['result']['items']) == 50
    assert all(row['application']['notes'] == 'x' * 6000 for row in responses['small-list']['result']['items'])
    assert responses['ping']['result']['message'] == 'still connected'
    assert not any(event['name'] == 'jobs.changed' for event in events)
    # Reducing the selection returns complete, restorable snapshots.
    responses, _ = run(tmp_path, request('remove', 'applications.remove', {'job_ids': identifiers[:50]}))
    removed = responses['remove']['result']['items']
    assert len(removed) == 50 and all(item['notes'] == 'x' * 6000 for item in removed)
    responses, _ = run(tmp_path, request('restore', 'applications.restore', {'items': removed})
                       + request('count', 'jobs.list', {'scope': 'applications', 'page_size': 1}))
    assert responses['restore']['result']['counts']['restored'] == 50
    assert responses['count']['result']['total'] == 200


def test_non_ascii_update_response_is_checked_before_commit(tmp_path):
    identifier = fixture_id(1000)
    with closing(connect(tmp_path / 'app.sqlite3')) as db:
        repo = Repository(db, lambda: NOW)
        import_synthetic(repo, {'count': 1})
        repo.add({'job_id': identifier})
        repo.update({'job_id': identifier, 'notes': 'original'})
    # A literal UTF-8 request fits the input limit, but escaped output would not.
    update = json.dumps({'type': 'request', 'id': 'unicode-update', 'method': 'applications.update',
                         'params': {'job_id': identifier, 'notes': '中' * 180_000}}, ensure_ascii=False).encode() + b'\n'
    responses, _ = run(tmp_path, update + request('detail', 'jobs.detail', {'job_id': identifier}))
    assert responses['unicode-update']['error']['code'] == 'RESPONSE_TOO_LARGE'
    assert responses['detail']['result']['application']['notes'] == 'original'


def test_export_worker_rechecks_path_after_command_acceptance(tmp_path, monkeypatch):
    from job_vaccum.storage.export import export_csv
    destination = tmp_path.parent / (tmp_path.name + '-retargeted.csv')
    def retarget_then_export(database, params):
        destination.symlink_to(database)
        return export_csv(database, params)
    monkeypatch.setattr('job_vaccum.service.server.export_csv', retarget_then_export)
    params = {'scope': 'discover', 'range': 'all', 'include_jd': False, 'destination_path': str(destination)}
    responses, events = run(tmp_path, request('import', 'dev.import_synthetic', {'count': 3})
                             + request('export', 'export.csv', params), enable_dev=True)
    assert responses['export']['ok'] is True
    assert any(event['name'] == 'operation.failed' for event in events)
    assert (tmp_path / 'app.sqlite3').read_bytes().startswith(b'SQLite format 3\x00')
    responses, _ = run(tmp_path, request('list', 'jobs.list'))
    assert responses['list']['result']['total'] == 3
