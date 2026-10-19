from io import BytesIO
import json

import pytest

from job_vaccum.service.protocol import MAX_MESSAGE_BYTES
from job_vaccum.service.server import serve


def messages(tmp_path, data):
    output = BytesIO()
    serve(tmp_path, BytesIO(data), output)
    return [json.loads(line) for line in output.getvalue().splitlines()]


def test_ready_and_multiple_requests(tmp_path):
    result = messages(tmp_path, b'{"type":"request","id":"1","method":"app.status"}\n'
                               b'{"type":"request","id":"2","method":"app.ping","params":{"message":"hello"}}\n')
    assert result[0] == {"type": "event", "name": "ready", "seq": 1,
                         "data": {"protocol_version": 1, "app_version": "0.1.0", "schema_version": 3}}
    assert result[1]["id"] == "1" and result[1]["result"]["active_run"] is None
    assert result[2] == {"type": "response", "id": "2", "ok": True, "result": {"message": "hello"}}


@pytest.mark.parametrize("line,request_id,code", [
    (b'not-json', None, "VALIDATION_ERROR"),
    (b'\xff', None, "VALIDATION_ERROR"),
    ('{}'.encode("utf-16"), None, "VALIDATION_ERROR"),
    (b'[]', None, "VALIDATION_ERROR"),
    (b'{"type":"request","id":false,"method":"app.status"}', None, "VALIDATION_ERROR"),
    (b'{"type":"event","id":"bad","method":"app.status"}', "bad", "VALIDATION_ERROR"),
    (b'{"type":"request","id":"bad","method":[],"params":{}}', "bad", "VALIDATION_ERROR"),
    (b'{"type":"request","id":"bad","method":"app.status","params":null}', "bad", "VALIDATION_ERROR"),
    (b'{"type":"request","id":"bad","method":"app.status","params":{"key":"synthetic-secret"}}', "bad", "VALIDATION_ERROR"),
    (b'{"type":"request","id":"bad","method":"app.status","extra":1}', "bad", "VALIDATION_ERROR"),
    (b'{"type":"request","id":"bad","method":"app.ping","params":{"message":0}}', "bad", "VALIDATION_ERROR"),
    (b'{"type":"request","id":"bad","method":"app.ping","params":{"message":NaN}}', None, "VALIDATION_ERROR"),
    (b'{"type":"request","id":"bad","method":"arbitrary.sql"}', "bad", "NOT_FOUND"),
])
def test_bad_request_is_safe_and_next_request_works(tmp_path, line, request_id, code):
    result = messages(tmp_path, line + b'\n{"type":"request","id":"next","method":"app.status"}\n')
    assert result[1]["id"] == request_id
    assert result[1]["ok"] is False
    assert result[1]["error"]["code"] == code
    assert "synthetic-secret" not in json.dumps(result)
    assert result[2]["id"] == "next" and result[2]["ok"] is True


def test_oversized_line_is_discarded_once(tmp_path):
    result = messages(tmp_path, b'x' * (MAX_MESSAGE_BYTES * 3) + b'\n'
                               b'{"type":"request","id":"next","method":"app.status"}\n')
    assert len(result) == 3
    assert "1 MiB" in result[1]["error"]["message"]
    assert result[2]["ok"] is True


def test_internal_error_does_not_expose_exception_and_service_continues(tmp_path, monkeypatch, caplog):
    def fail(_):
        raise RuntimeError("synthetic-secret")
    monkeypatch.setattr("job_vaccum.service.server.diagnostics", fail)
    result = messages(tmp_path, b'{"type":"request","id":"1","method":"app.diagnostics"}\n'
                               b'{"type":"request","id":"2","method":"app.status"}\n')
    assert result[1]["error"]["code"] == "INTERNAL_ERROR"
    assert result[2]["ok"] is True
    assert "synthetic-secret" not in caplog.text + json.dumps(result)


def test_native_dependency_and_sqlite_diagnostics(tmp_path):
    result = messages(tmp_path, b'{"type":"request","id":"1","method":"app.diagnostics"}\n')[1]
    assert result["ok"] is True
    diagnostic = result["result"]
    assert diagnostic["jobspy_commit"] == "1988484ac76ff9ae57784750346842e967e8ba10"
    assert diagnostic["jobspy_version"] == "1.3.0"
    assert diagnostic["machine"] == "arm64"
    assert diagnostic["storage"]["read_write"] is True
    assert "libcurl" in diagnostic["curl_version"]


def test_response_limit_uses_actual_serialization_and_keeps_request_id():
    from job_vaccum.service.protocol import encode, write
    output = BytesIO()
    write(output, {'type': 'response', 'id': 'large', 'ok': True,
                   'result': {'notes': '中' * 180_000}})
    # ensure_ascii JSON escapes make this larger than 1 MiB although UTF-8 input is smaller.
    error = json.loads(output.getvalue())
    assert error['id'] == 'large' and error['error']['code'] == 'RESPONSE_TOO_LARGE'
    assert len(output.getvalue()) - 1 < MAX_MESSAGE_BYTES
    envelope = {'type': 'response', 'id': 'boundary', 'ok': True, 'result': ''}
    base_size = len(encode(envelope)) - 1
    envelope['result'] = 'x' * (MAX_MESSAGE_BYTES - base_size)
    assert len(encode(envelope)) - 1 == MAX_MESSAGE_BYTES
    envelope['result'] += 'x'
    write(output, envelope)
    assert json.loads(output.getvalue().splitlines()[-1])['error']['code'] == 'RESPONSE_TOO_LARGE'
