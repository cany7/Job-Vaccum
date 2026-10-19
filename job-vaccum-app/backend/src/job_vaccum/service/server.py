from contextlib import closing, redirect_stdout
from importlib.metadata import version
from io import BufferedReader
import logging
from pathlib import Path
import platform
import sqlite3
import sys
import queue
import threading
import time
from uuid import uuid4
from typing import BinaryIO

from job_vaccum import APP_VERSION, JOBSPY_COMMIT, PROTOCOL_VERSION
from job_vaccum.service.protocol import CommandError, decode, lines, validate, write
from job_vaccum.storage.database import SCHEMA_VERSION, connect, storage_check
from job_vaccum.storage.repository import Repository, now_ms
from job_vaccum.storage.filters import fields, choice, string
from job_vaccum.storage.cleanup import Cleanup
from job_vaccum.storage.export import export_csv, validate_export
from job_vaccum.storage.synthetic import import_synthetic
from job_vaccum.pipeline.configuration import draft, proxy_origin, validate_model
from job_vaccum.pipeline.runs import Runs
from job_vaccum.llm.pool import LlmPool


def diagnostics(connection: sqlite3.Connection) -> dict:
    # Import checks are explicit, offline, and also exercise frozen native libraries.
    with redirect_stdout(sys.stderr):
        import jobspy
        import pandas
        import curl_cffi
        from curl_cffi import Curl

        with closing(Curl()) as curl:
            curl_version = curl.version().decode("utf-8")
    return {"python_version": platform.python_version(), "machine": platform.machine(),
            "frozen": bool(getattr(sys, "frozen", False)),
            "jobspy_commit": JOBSPY_COMMIT, "jobspy_version": version("python-jobspy"),
            "pandas_version": pandas.__version__, "curl_cffi_version": curl_cffi.__version__,
            "curl_version": curl_version, "sqlite_version": sqlite3.sqlite_version,
            "storage": storage_check(connection)}


class Service:
    def __init__(self, connection, root, *, clock=now_ms, enable_dev=False, inbox=None, attempt=None, llm_options=None):
        self.repo = Repository(connection, clock)
        self.root = root
        self.cleanup = Cleanup(self.repo, root)
        self.enable_dev = enable_dev and not getattr(sys, "frozen", False)
        self.operations = {}
        self.inbox = inbox if inbox is not None else queue.Queue()
        self.llm = LlmPool(self.inbox, **(llm_options or {}))
        self.model_operations = {}
        self.runs = Runs(self.repo, self.inbox, llm=self.llm, **({"attempt": attempt} if attempt else {}))

    def dispatch(self, method, params, request_id=None):
        if method == "app.ping":
            if set(params) != {"message"} or not isinstance(params["message"], str) or len(params["message"]) > 256:
                raise CommandError("app.ping requires a message string of at most 256 characters.")
            return {"message": params["message"]}
        if method in {"app.status", "app.diagnostics", "settings.get"}:
            fields(params, set())
            if method == "app.diagnostics":
                return diagnostics(self.repo.db)
            if method == "settings.get":
                return self.settings()
            return {"active_run": self.runs.active(), "operations": [{"operation_id": key, "kind": "export"} for key in self.operations] +
                    [{"operation_id": key, "kind": "model_test", "status": 'cancelling' if cancel.is_set() else 'running'} for key, cancel in self.model_operations.items()],
                    "cleanup": {"status": "idle"}, "configuration_complete": self.configuration_complete(),
                    "storage": {"schema_version": SCHEMA_VERSION, "journal_mode": "wal"}}
        commands = {
            "jobs.list": self.repo.list_jobs, "jobs.detail": self.repo.detail,
            "jobs.score": self.runs.score,
            "settings.save": lambda p: self.save_settings(p),
            "drafts.get": lambda p: draft(self.repo, "get", p),
            "drafts.save": lambda p: draft(self.repo, "save", p),
            "drafts.apply": lambda p: draft(self.repo, "apply", p),
            "runs.preview": self.runs.preview, "runs.start": self.runs.start,
            "runs.list": self.runs.list, "runs.detail": self.runs.detail,
            "runs.stop": self.runs.stop, "runs.resume": self.runs.resume,
            "directions.save": self.repo.direction_save, "directions.delete": self.repo.direction_delete,
            "directions.reorder": self.repo.direction_reorder,
            "queries.save": self.repo.query_save, "queries.delete": self.repo.query_delete,
            "applications.add": self.repo.add,
            "applications.add_many": lambda p: self.repo.add(p, many=True),
            "applications.update": lambda p: self.repo.update(p, response_id=request_id), "applications.set_status": self.repo.set_status,
            "applications.remove": lambda p: self.repo.remove(p, response_id=request_id), "applications.restore": self.repo.restore,
        }
        if method in commands:
            return commands[method](params)
        if method in {"cleanup.preview", "cleanup.execute"}:
            fields(params, {"mode"}, {"mode"})
            mode = choice(params["mode"], "mode", ("manual", "automatic") if method.endswith("preview") else ("manual",))
            if method == "cleanup.preview":
                return self.cleanup.preview(mode)
            if self.operations or self.model_operations or self.runs.active():
                raise CommandError("Wait for the active operation before cleaning data.", "BUSY")
            return self.cleanup.execute(mode)
        if method == "internal.credentials":
            fields(params, {"proxy_url", "model_key"})
            if not params:
                raise CommandError('Provide a credential field.')
            if params.get('proxy_url') is not None:
                proxy_origin(params['proxy_url'], credentials=True)
            if params.get('model_key') is not None:
                key = string(params['model_key'], 'API key')
                if '\r' in key or '\n' in key:
                    raise CommandError('API key must be a single line.')
            if 'proxy_url' in params:
                self.runs.proxy_credential = params['proxy_url']
            if 'model_key' in params:
                self.runs.model_key = params['model_key']
            return {'has_key': self.runs.model_key is not None,
                    'has_proxy_credentials': self.runs.proxy_credential is not None}
        if method == 'model.test':
            fields(params, {'model'})
            model = params.get('model', self.repo.settings()['model'])
            validate_model(model)
            if model is None or not self.runs.model_key:
                raise CommandError('Configure a model and save an API key before testing.')
            operation_id, cancel = str(uuid4()), threading.Event()
            self.model_operations[operation_id] = cancel
            self.llm.submit(operation_id, model, self.runs.model_key, '', 'Reply with OK.', lambda text: {'connected': True}, cancel)
            return {'operation_id': operation_id}
        if method == 'operations.cancel':
            fields(params, {'operation_id'}, {'operation_id'})
            identifier = string(params['operation_id'], 'operation_id')
            if identifier not in self.model_operations:
                raise CommandError('Model operation not found.', 'NOT_FOUND')
            self.llm.cancel(identifier)
            return {'operation_id': identifier}
        if method == "dev.import_synthetic" and self.enable_dev:
            return import_synthetic(self.repo, params)
        if method == "export.csv":
            validate_export(params, self.root / "app.sqlite3")
            if self.operations:
                raise CommandError("An export is already running.", "BUSY")
            operation_id = str(uuid4())
            self.operations[operation_id] = True
            def run_export():
                try:
                    result = export_csv(self.root / "app.sqlite3", params)
                    self.inbox.put(("export", (operation_id, result, None)))
                except Exception:
                    self.inbox.put(("export", (operation_id, None, {"code": "EXPORT_ERROR", "message": "CSV export failed. Check the destination and available space; a partial file may remain.", "retryable": False})))
            threading.Thread(target=run_export, name="csv-export", daemon=True).start()
            return {"operation_id": operation_id}
        raise CommandError("Unknown method for this backend milestone.", "NOT_FOUND")

    def settings(self):
        return {**self.repo.settings(), 'has_key': self.runs.model_key is not None, 'has_proxy_credentials': self.runs.proxy_credential is not None}

    def handle_llm(self, kind, payload, event):
        token = payload if kind == 'llm_attempt' else payload[0]
        if kind == 'llm_result':
            self.llm.complete(token)
        if token not in self.model_operations:
            self.runs.handle_score(kind, payload, event)
        elif kind == 'llm_result':
            _, result, error = payload
            if self.model_operations.pop(token).is_set():
                error = {'code': 'CANCELLED', 'message': 'Model operation cancelled.', 'retryable': False}
            event('operation.failed' if error else 'model.test.completed',
                  {'operation_id': token, **({'error': error} if error else result)})

    def save_settings(self, params):
        self.repo.save_settings(params)
        return self.settings()

    def configuration_complete(self):
        try:
            self.runs.preview({})
            return True
        except CommandError:
            return False


def serve(root: Path, source: BinaryIO, destination: BinaryIO, *, clock=now_ms, enable_dev=False,
          cleanup_interval=60, attempt=None, llm_options=None) -> None:
    # Only this receive loop writes SQLite or protocol output. The input reader and
    # CSV worker submit messages; neither shares the writer connection.
    inbox = queue.Queue(maxsize=64)
    def read_input():
        try:
            # A reader-owned buffer avoids locking interpreter-owned stdin during
            # SIGTERM shutdown, while still reading long requests in chunks.
            input_stream = BufferedReader(source.raw) if source is sys.stdin.buffer else source
            for line in lines(input_stream):
                inbox.put(("request", line))
        finally:
            inbox.put(("eof", None))
    with closing(connect(root / "app.sqlite3")) as connection:
        service = Service(connection, root, clock=clock, enable_dev=enable_dev, inbox=inbox, attempt=attempt, llm_options=llm_options)
        service.cleanup.clear_tmp()
        service.cleanup.execute("automatic")
        seq = 0
        def event(name, data):
            nonlocal seq
            if name == 'run.updated' and data['status'] not in ('running', 'stopping'):
                service.cleanup.clear_tmp()
            seq += 1
            write(destination, {"type": "event", "name": name, "seq": seq, "data": data})
        event("ready", {"protocol_version": PROTOCOL_VERSION, "app_version": APP_VERSION, "schema_version": SCHEMA_VERSION})
        threading.Thread(target=read_input, name="protocol-input", daemon=True).start()
        deadline = time.monotonic() + cleanup_interval
        ended = False
        try:
            while not ended or service.operations or service.model_operations or service.runs.active():
                timeout = max(0, deadline - time.monotonic())
                try:
                    kind, payload = inbox.get(timeout=timeout)
                except queue.Empty:
                    kind, payload = "tick", None
                if time.monotonic() >= deadline:
                    if not service.operations and not service.model_operations and not service.runs.active():
                        try:
                            cleaned = service.cleanup.execute("automatic")
                            if cleaned["deleted_jobs"] or cleaned["deleted_runs"] or cleaned["deleted_files"] or cleaned["failed_files"]:
                                event("cleanup.completed", cleaned)
                                if cleaned["deleted_jobs"]:
                                    event("jobs.changed", {})
                        except Exception:
                            logging.error("CLEANUP_ERROR: Automatic cleanup failed.")
                    deadline = time.monotonic() + cleanup_interval
                if kind == "eof":
                    ended = True
                    for token in list(service.model_operations):
                        service.llm.cancel(token)
                    active = service.runs.active()
                    if active:
                        service.runs.stop({'run_id': active['run_id']})
                        service.runs.advance(event)
                    continue
                if kind in ('llm_attempt', 'llm_result'):
                    service.handle_llm(kind, payload, event)
                    continue
                if kind in ('retrieval_attempt', 'retrieval_result'):
                    service.runs.handle(kind, payload, event)
                    continue
                if kind == "export":
                    operation_id, result, error = payload
                    service.operations.pop(operation_id)
                    event("operation.failed" if error else "operation.completed",
                          {"operation_id": operation_id, **({"error": error} if error else result)})
                    continue
                if kind != "request":
                    continue
                request_id = None
                succeeded = False
                try:
                    request_id, method, request = decode(payload)
                    result = service.dispatch(method, validate(request), request_id)
                    response = {"type": "response", "id": request_id, "ok": True, "result": result}
                    succeeded = True
                except CommandError as exc:
                    response = {"type": "response", "id": request_id, "ok": False,
                                "error": {"code": exc.code, "message": str(exc), "retryable": False}}
                except Exception:
                    logging.error("INTERNAL_ERROR: Backend command failed.")
                    response = {"type": "response", "id": request_id, "ok": False,
                                "error": {"code": "INTERNAL_ERROR", "message": "Backend command failed.", "retryable": False}}
                write(destination, response)
                if succeeded and method == "cleanup.execute":
                    event("cleanup.completed", result)
                if succeeded and (method.startswith(("applications.", "directions.", "queries."))
                                  or method in {"dev.import_synthetic", "cleanup.execute", "drafts.apply"}):
                    event("jobs.changed", {})
                if succeeded and method in {"runs.start", "runs.resume", "runs.stop", "jobs.score"}:
                    if method in {'jobs.score', 'runs.resume'}:
                        event('jobs.changed', {})
                    service.runs.notifications(result['run_id'], event)
                    service.runs.advance(event)
        finally:
            service.runs.close()
