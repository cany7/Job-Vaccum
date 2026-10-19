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
from job_vaccum.storage.filters import fields, choice
from job_vaccum.storage.cleanup import Cleanup
from job_vaccum.storage.export import export_csv, validate_export
from job_vaccum.storage.synthetic import import_synthetic


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
    def __init__(self, connection, root, *, clock=now_ms, enable_dev=False, inbox=None):
        self.repo = Repository(connection, clock)
        self.root = root
        self.cleanup = Cleanup(self.repo, root)
        self.enable_dev = enable_dev and not getattr(sys, "frozen", False)
        self.operations = {}
        self.inbox = inbox

    def dispatch(self, method, params):
        if method == "app.ping":
            if set(params) != {"message"} or not isinstance(params["message"], str) or len(params["message"]) > 256:
                raise CommandError("app.ping requires a message string of at most 256 characters.")
            return {"message": params["message"]}
        if method in {"app.status", "app.diagnostics", "settings.get"}:
            fields(params, set())
            if method == "app.diagnostics":
                return diagnostics(self.repo.db)
            if method == "settings.get":
                return self.repo.settings()
            return {"active_run": None, "operations": [{"operation_id": key, "kind": "export"} for key in self.operations],
                    "cleanup": {"status": "idle"}, "configuration_complete": False,
                    "storage": {"schema_version": SCHEMA_VERSION, "journal_mode": "wal"}}
        commands = {
            "jobs.list": self.repo.list_jobs, "jobs.detail": self.repo.detail,
            "settings.save": self.repo.save_settings,
            "directions.save": self.repo.direction_save, "directions.delete": self.repo.direction_delete,
            "directions.reorder": self.repo.direction_reorder,
            "queries.save": self.repo.query_save, "queries.delete": self.repo.query_delete,
            "applications.add": self.repo.add,
            "applications.add_many": lambda p: self.repo.add(p, many=True),
            "applications.update": self.repo.update, "applications.set_status": self.repo.set_status,
            "applications.remove": self.repo.remove, "applications.restore": self.repo.restore,
        }
        if method in commands:
            return commands[method](params)
        if method in {"cleanup.preview", "cleanup.execute"}:
            fields(params, {"mode"}, {"mode"})
            mode = choice(params["mode"], "mode", ("manual", "automatic") if method.endswith("preview") else ("manual",))
            if method == "cleanup.preview":
                return self.cleanup.preview(mode)
            if self.operations:
                raise CommandError("Wait for the active operation before cleaning data.", "BUSY")
            return self.cleanup.execute(mode)
        if method == "dev.import_synthetic" and self.enable_dev:
            return import_synthetic(self.repo, params)
        if method == "export.csv":
            validate_export(params)
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


def serve(root: Path, source: BinaryIO, destination: BinaryIO, *, clock=now_ms, enable_dev=False,
          cleanup_interval=60) -> None:
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
        service = Service(connection, root, clock=clock, enable_dev=enable_dev, inbox=inbox)
        service.cleanup.clear_tmp()
        service.cleanup.execute("automatic")
        seq = 0
        def event(name, data):
            nonlocal seq
            seq += 1
            write(destination, {"type": "event", "name": name, "seq": seq, "data": data})
        event("ready", {"protocol_version": PROTOCOL_VERSION, "app_version": APP_VERSION, "schema_version": SCHEMA_VERSION})
        threading.Thread(target=read_input, name="protocol-input", daemon=True).start()
        deadline = time.monotonic() + cleanup_interval
        ended = False
        while not ended or service.operations:
            timeout = max(0, deadline - time.monotonic())
            try:
                kind, payload = inbox.get(timeout=timeout)
            except queue.Empty:
                kind, payload = "tick", None
            if time.monotonic() >= deadline:
                if not service.operations:
                    try:
                        cleaned = service.cleanup.execute("automatic")
                        if cleaned["deleted_jobs"] or cleaned["deleted_files"] or cleaned["failed_files"]:
                            event("cleanup.completed", cleaned)
                            if cleaned["deleted_jobs"]:
                                event("jobs.changed", {})
                    except Exception:
                        logging.error("CLEANUP_ERROR: Automatic cleanup failed.")
                deadline = time.monotonic() + cleanup_interval
            if kind == "eof":
                ended = True
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
                result = service.dispatch(method, validate(request))
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
                              or method in {"dev.import_synthetic", "cleanup.execute"}):
                event("jobs.changed", {})
