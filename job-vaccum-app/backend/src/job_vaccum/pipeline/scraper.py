"""Locked JobSpy boundary. Each invocation runs in an owned spawn process."""
from contextlib import contextmanager, redirect_stdout
from datetime import date, datetime
from enum import Enum
import logging
import math
import multiprocessing
import os
import re
import sys
import threading
import time
from urllib.parse import unquote, urlsplit

from job_vaccum.service.protocol import CommandError


def safe_text(value, proxy=None):
    value = str(value)
    if proxy:
        p = urlsplit(proxy)
        for secret in (proxy, p.username, p.password):
            if secret:
                value = value.replace(secret, '[redacted]').replace(unquote(secret), '[redacted]')
    value = re.sub(r'(?:https?|socks5)://[^\s<>\'"]+', '[url]', value)
    value = re.sub(r'(?i)(?:bearer\s+|(?:api[_-]?key|password|token)\s*[=:]\s*)[^\s,;]+', '[redacted]', value)
    return value[:1000]


class SafeLog(logging.Filter):
    def __init__(self, proxy):
        super().__init__()
        self.proxy = proxy

    def filter(self, record):
        record.msg, record.args = safe_text(record.getMessage(), self.proxy), ()
        record.exc_info, record.exc_text = None, None
        return True


def arguments(spec, parameters, proxy):
    site = spec['site']
    if site not in ('linkedin', 'indeed'):
        raise ValueError('Unsupported platform')
    args = {'site_name': site, 'search_term': spec['expression'], 'location': spec['location'],
            'distance': spec['distance_miles'], 'results_wanted': parameters['results_wanted'][site],
            'hours_old': parameters['hours_old'], 'offset': 0, 'description_format': 'markdown',
            'proxies': [proxy] if proxy else None, 'verbose': None}
    if site == 'linkedin':
        args['fetch_description'] = True
    else:
        args['country_indeed'] = spec['country_indeed']
    return args


def scalar(value):
    import pandas as pd
    if isinstance(value, Enum):
        value = value.value
    if isinstance(value, dict):
        return {k: scalar(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [scalar(v) for v in value]
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    if hasattr(value, 'item'):
        value = value.item()
    return value


def dataframe_result(df, site, proxy=None):
    # attrs must be copied before any record conversion.
    error = df.attrs.get('errors', {}).get(site)
    warnings = [safe_text(w, proxy) for w in df.attrs.get('warnings', {}).get(site, [])]
    records = []
    columns = ('id', 'title', 'company', 'location', 'description', 'job_type', 'date_posted', 'job_url', 'job_url_direct')
    for raw in df.to_dict(orient='records'):
        record = {key: scalar(raw.get(key)) for key in columns}
        record['site'] = site
        loc = record['location']
        if isinstance(loc, dict):
            record['location'] = ', '.join(str(loc[k]) for k in ('city', 'state', 'country') if loc.get(k)) or None
        types = record['job_type']
        if isinstance(types, list):
            record['job_type'] = ', '.join(str(v[0] if isinstance(v, list) else v) for v in types) or None
        for key in ('id', 'title', 'company', 'description', 'location', 'job_type', 'date_posted', 'job_url', 'job_url_direct'):
            if record[key] is not None:
                record[key] = str(record[key])
        for old, new in (('min_amount', 'salary_min'), ('max_amount', 'salary_max')):
            v = scalar(raw.get(old))
            try:
                record[new] = float(v) if v is not None and math.isfinite(float(v)) else None
            except (ValueError, TypeError):
                record[new] = None
        record['salary_currency'] = scalar(raw.get('currency'))
        record['salary_interval'] = scalar(raw.get('interval'))
        if record['date_posted']:
            try:
                record['date_posted'] = date.fromisoformat(record['date_posted'][:10]).isoformat()
            except ValueError:
                record['date_posted'] = None
        records.append(record)
    return {'records': records, 'warnings': warnings,
            'error': {'code': 'NETWORK_ERROR', 'message': safe_text(error, proxy), 'retryable': True} if error else None,
            'missing_jd_count': sum(not r['description'] or not r['description'].strip() for r in records)}


@contextmanager
def observe_http():
    # The only coupling to the pinned network layer. Never installed in service/LLM.
    import requests
    from curl_cffi import requests as curl_requests
    counts = {'http_requests': 0, 'http_429': 0}
    old_send, old_request = requests.Session.send, curl_requests.Session.request
    def wrap(original):
        def call(*args, **kwargs):
            counts['http_requests'] += 1
            response = original(*args, **kwargs)
            if response.status_code == 429:
                counts['http_429'] += 1
            return response
        return call
    requests.Session.send, curl_requests.Session.request = wrap(old_send), wrap(old_request)
    try:
        yield counts
    finally:
        requests.Session.send, curl_requests.Session.request = old_send, old_request


def invoke(spec, parameters, proxy, scrape=None):
    if scrape is None:
        from jobspy import scrape_jobs
        scrape = scrape_jobs
    try:
        with redirect_stdout(sys.stderr):
            df = scrape(**arguments(spec, parameters, proxy))
        return dataframe_result(df, spec['site'], proxy)
    except (ValueError, TypeError):
        return {'records': [], 'warnings': [], 'error': {'code': 'VALIDATION_ERROR', 'message': 'JobSpy rejected the task parameters.', 'retryable': False}}
    except Exception:
        return {'records': [], 'warnings': [], 'error': {'code': 'NETWORK_ERROR', 'message': 'JobSpy request failed.', 'retryable': True}}


def worker(send, spec, parameters, proxy, scrape):
    # No inherited environment proxies, including when proxy mode is off.
    for key in list(os.environ):
        if key.casefold() in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
            os.environ.pop(key)
    handler = logging.StreamHandler(sys.stderr)
    handler.addFilter(SafeLog(proxy))
    logging.basicConfig(handlers=[handler], level=logging.INFO, force=True)
    try:
        with observe_http() as counts:
            result = invoke(spec, parameters, proxy, scrape)
        send.send({**result, **counts})
    finally:
        send.close()


def process_attempt(spec, parameters, proxy, stop, scrape=None):
    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=False)
    child = context.Process(target=worker, args=(send, spec, parameters, proxy, scrape), name='jobspy-task')
    child.start()
    send.close()
    deadline, stopping_at = time.monotonic() + parameters['timeout_seconds'], None
    try:
        while True:
            if stop.is_set():
                stopping_at = stopping_at or time.monotonic()
                if time.monotonic() - stopping_at >= 10:
                    break
            if receive.poll(0.05):
                try:
                    return receive.recv()
                except EOFError:
                    break
            if not child.is_alive() or time.monotonic() >= deadline:
                break
        return {'records': [], 'warnings': [], 'error': {
            'code': 'CANCELLED' if stop.is_set() else 'WORKER_EXITED',
            'message': 'Scrape stopped.' if stop.is_set() else 'Scrape worker exited or exceeded its timeout.', 'retryable': not stop.is_set()}}
    finally:
        receive.close()
        if child.is_alive():
            child.terminate()
        child.join(1)
        if child.is_alive():
            child.kill()
            child.join(1)
        child.close()


def retrieve(spec, parameters, proxy, stop, attempt=process_attempt, on_attempt=lambda: None):
    result = {'records': [], 'warnings': [], 'http_requests': 0, 'http_429': 0, 'error': None}
    for index in range(parameters['max_attempts']):
        if stop.is_set():
            break
        on_attempt()
        current = attempt(spec, parameters, proxy, stop)
        result['records'].extend(current['records'])
        result['warnings'].extend(w for w in current.get('warnings', []) if w not in result['warnings'])
        for key in ('http_requests', 'http_429'):
            result[key] += current.get(key, 0)
        result['error'] = current['error']
        if not current['error'] or not current['error']['retryable']:
            break
        if index + 1 < parameters['max_attempts'] and stop.wait(parameters['retry_base_seconds'] * (2 ** index)):
            break
    if stop.is_set():
        # A stopped task has no committed partial batch, so resume starts it anew.
        result['records'] = []
        result['error'] = {'code': 'CANCELLED', 'message': 'Scrape stopped.', 'retryable': False}
    return result
