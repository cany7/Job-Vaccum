import json
import selectors
import subprocess
import sys

import pytest


def read_line(process):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        assert selector.select(15), "Backend output timed out"
    return json.loads(process.stdout.readline())


@pytest.fixture
def launch(tmp_path):
    processes = []

    def start():
        process = subprocess.Popen([sys.executable, "-m", "job_vaccum", "--data-dir", str(tmp_path / "data with spaces")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   bufsize=0, cwd=tmp_path,
                                   env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)})
        processes.append(process)
        return process

    yield start
    for process in processes:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)


def test_real_process_fragments_utf8_and_exits_on_eof(launch):
    process = launch()
    assert read_line(process)["name"] == "ready"
    payload = json.dumps({"type": "request", "id": "fragmented", "method": "app.ping",
                          "params": {"message": "合成 🧪"}}, ensure_ascii=False).encode() + b"\n"
    split = payload.index("合".encode()) + 1
    process.stdin.write(payload[:split])
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        assert not selector.select(0.05)
    process.stdin.write(payload[split:])
    assert read_line(process)["result"]["message"] == "合成 🧪"
    process.stdin.close()
    assert process.wait(timeout=5) == 0


def test_second_process_refused_and_lock_released_after_crash(launch):
    first = launch()
    assert read_line(first)["name"] == "ready"
    second = launch()
    stdout, stderr = second.communicate(timeout=10)
    assert second.returncode == 2 and stdout == b"" and b"BUSY" in stderr
    first.kill()
    first.wait(timeout=5)
    third = launch()
    assert read_line(third)["name"] == "ready"
    third.terminate()
    assert third.wait(timeout=5) == 0
    fourth = launch()
    assert read_line(fourth)["name"] == "ready"


def test_relative_data_directory_is_rejected(tmp_path):
    result = subprocess.run([sys.executable, "-m", "job_vaccum", "--data-dir", "relative"],
                            cwd=tmp_path, capture_output=True, timeout=10)
    assert result.returncode == 2 and not result.stdout
    assert b"must be absolute" in result.stderr


def test_invalid_database_fails_before_ready_without_traceback(tmp_path, launch):
    data = tmp_path / "data with spaces"
    data.mkdir()
    (data / "app.sqlite3").write_bytes(b"synthetic invalid database")
    process = launch()
    stdout, stderr = process.communicate(timeout=10)
    assert process.returncode == 2 and stdout == b""
    assert b"STARTUP_ERROR" in stderr and b"Traceback" not in stderr
