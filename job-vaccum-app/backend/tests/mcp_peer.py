"""Electron MCP integration peer: real CLI/service/SQLite, injected fake I/O only."""
import socket
import time
from job_vaccum import __main__ as entry
from job_vaccum.service.server import serve
from job_vaccum.pipeline.fake import FakeScraper
from job_vaccum.pipeline.scraper import process_attempt
from job_vaccum.llm.fake import FakeLlm


def blocked(*args, **kwargs):
    raise AssertionError('MCP fixtures never access the network')


def attempt(spec, parameters, proxy, stop):
    return process_attempt(spec, parameters, proxy, stop, FakeScraper('delay', delay=0.3))


fake_llm = FakeLlm()


def model(*args):
    time.sleep(0.3)
    return fake_llm(*args)


def fake_serve(*args, **kwargs):
    return serve(*args, **kwargs, attempt=attempt,
                 llm_options={'transport': model, 'rpm': 600000, 'retry_base': 0})


if __name__ == '__main__':
    socket.socket.connect = blocked
    socket.create_connection = blocked
    entry.serve = fake_serve
    raise SystemExit(entry.main())
