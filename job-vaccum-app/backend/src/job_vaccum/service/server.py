from contextlib import closing, redirect_stdout
from importlib.metadata import version
import logging
from pathlib import Path
import platform
import sqlite3
import sys
from typing import BinaryIO

from job_vaccum import APP_VERSION, JOBSPY_COMMIT, PROTOCOL_VERSION
from job_vaccum.service.protocol import CommandError, decode, lines, validate, write
from job_vaccum.storage.database import SCHEMA_VERSION, connect, storage_check


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


def dispatch(method: str, params: dict, connection: sqlite3.Connection) -> dict:
    if method == "app.ping":
        if set(params) != {"message"} or not isinstance(params["message"], str) or len(params["message"]) > 256:
            raise CommandError("app.ping requires a message string of at most 256 characters.")
        return {"message": params["message"]}
    if method not in {"app.status", "app.diagnostics"}:
        raise CommandError("Unknown method for this backend milestone.", "NOT_FOUND")
    if params:
        raise CommandError("This method does not accept parameters.")
    if method == "app.diagnostics":
        return diagnostics(connection)
    return {"active_run": None, "operations": [], "cleanup": {"status": "idle"},
            "configuration_complete": False,
            "storage": {"schema_version": SCHEMA_VERSION, "journal_mode": "wal"}}


def serve(root: Path, source: BinaryIO, destination: BinaryIO) -> None:
    # M0's receive loop is the only database writer. Later workers submit to it;
    # they must never share this connection or hold a transaction over network I/O.
    with closing(connect(root / "app.sqlite3")) as connection:
        write(destination, {"type": "event", "name": "ready", "seq": 1,
                            "data": {"protocol_version": PROTOCOL_VERSION,
                                     "app_version": APP_VERSION, "schema_version": SCHEMA_VERSION}})
        for line in lines(source):
            request_id = None
            try:
                request_id, method, request = decode(line)
                result = dispatch(method, validate(request), connection)
                response = {"type": "response", "id": request_id, "ok": True, "result": result}
            except CommandError as exc:
                response = {"type": "response", "id": request_id, "ok": False,
                            "error": {"code": exc.code, "message": str(exc), "retryable": False}}
            except Exception:
                logging.error("INTERNAL_ERROR: Backend command failed.")
                response = {"type": "response", "id": request_id, "ok": False,
                            "error": {"code": "INTERNAL_ERROR", "message": "Backend command failed.", "retryable": False}}
            write(destination, response)
