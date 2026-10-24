"""Electron draft bridge peer: real service/SQLite, synthetic model I/O only."""
import json
import socket
import time

from job_vaccum import __main__ as entry
from job_vaccum.llm.drafts import SEARCH_PROMPT
from job_vaccum.service.server import serve


def blocked(*args, **kwargs):
    raise AssertionError('Draft fixtures never access the network')


def model(config, key, system, prompt):
    assert key == 'synthetic-draft-key'
    user_input = json.loads(prompt)['input']
    if user_input['text'] == 'slow synthetic resume':
        time.sleep(1)
    if system != SEARCH_PROMPT:
        return '# Synthetic rubric\nScore role fit from 0 to 10.'
    if 'clarification_answer' not in user_input:
        return json.dumps({'directions': [], 'cities': [], 'clarification': 'Which role?'})
    return json.dumps({'directions': [{'name': 'Software', 'queries': [
        {'expression': 'software engineer', 'enabled': True},
        {'expression': 'backend engineer', 'enabled': True},
    ]}], 'cities': [{'location': 'Chicago', 'distance_miles': 25, 'enabled': True}]})


def fake_serve(*args, **kwargs):
    return serve(*args, **kwargs, llm_options={'transport': model, 'rpm': 600000, 'retry_base': 0})


if __name__ == '__main__':
    socket.socket.connect = blocked
    socket.create_connection = blocked
    entry.serve = fake_serve
    raise SystemExit(entry.main())
