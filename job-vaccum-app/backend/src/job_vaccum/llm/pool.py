"""One process-wide pool and non-bursting gate, including every retry/test."""
from concurrent.futures import ThreadPoolExecutor
import threading
import time

from job_vaccum.llm.http import generate, ModelError


class RateGate:
    def __init__(self, rpm, *, clock=time.monotonic, concurrency=None):
        self.interval, self.clock = 60 / rpm, clock
        self.next_start = 0
        self.last_start = None
        self.concurrency, self.active = concurrency, 0
        self.lock = threading.Lock()

    def enter(self, cancel):
        while not cancel.is_set():
            with self.lock:
                delay = self.next_start - self.clock()
                if delay <= 0 and (self.concurrency is None or self.active < self.concurrency):
                    self.last_start = self.clock()
                    self.next_start = self.last_start + self.interval
                    self.active += 1
                    return True
            cancel.wait(min(max(delay, 0.01), 0.1))
        return False

    def release(self):
        with self.lock:
            self.active -= 1


class LlmPool:
    def __init__(self, inbox, *, transport=generate, concurrency=1, rpm=10,
                 max_attempts=3, retry_base=5):
        self.inbox, self.transport = inbox, transport
        self.max_attempts, self.retry_base = max_attempts, retry_base
        self.gate = RateGate(rpm, concurrency=concurrency)
        self.concurrency = concurrency
        self.runtime_overrides = {}
        self.executor = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix='llm')
        self.cancellations = {}
        self.futures = {}

    def configure(self, parameters):
        concurrency = self.runtime_overrides.get('concurrency', parameters['llm_concurrency'])
        rpm = self.runtime_overrides.get('rpm', parameters['llm_rpm'])
        with self.gate.lock:
            interval = 60 / rpm
            if interval != self.gate.interval and self.gate.last_start is not None:
                self.gate.next_start = self.gate.last_start + interval
            self.gate.interval = interval
            self.gate.concurrency = concurrency
        if concurrency != self.concurrency:
            old = self.executor
            self.executor = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix='llm')
            self.concurrency = concurrency
            old.shutdown(wait=False)

    def submit(self, token, model, key, system, prompt, parser, cancel, parameters=None):
        self.cancellations[token] = cancel
        parameters = parameters or {}
        max_attempts = self.runtime_overrides.get('max_attempts', parameters.get('max_attempts', self.max_attempts))
        retry_base = self.runtime_overrides.get('retry_base', parameters.get('retry_base_seconds', self.retry_base))
        timeout = (parameters.get('llm_connect_timeout_seconds', 10), parameters.get('llm_read_timeout_seconds', 120))
        def work():
            attempts = 0
            result, error = None, {'code': 'CANCELLED', 'message': 'Model operation cancelled.', 'retryable': False}
            for attempt in range(max_attempts):
                if not self.gate.enter(cancel):
                    error = {'code': 'CANCELLED', 'message': 'Model operation cancelled.', 'retryable': False}
                    break
                self.inbox.put(('llm_attempt', token))
                if cancel.is_set():
                    self.gate.release()
                    error = {'code': 'CANCELLED', 'message': 'Model operation cancelled.', 'retryable': False}
                    break
                try:
                    attempts += 1
                    try:
                        text = (self.transport(model, key, system, prompt, timeout=timeout) if self.transport is generate
                                else self.transport(model, key, system, prompt))
                    finally:
                        self.gate.release()
                    result = parser(text)
                    error = None
                    break
                except ModelError as exc:
                    error = exc.error
                    if not error['retryable'] or attempt + 1 == max_attempts:
                        break
                    if cancel.wait(max(retry_base * 2**attempt, exc.retry_after)):
                        error = {'code': 'CANCELLED', 'message': 'Model operation cancelled.', 'retryable': False}
                        break
                except Exception:
                    error = {'code': 'INTERNAL_ERROR', 'message': 'Model request could not be completed.', 'retryable': False}
                    break
            self.inbox.put(('llm_result', (token, result, error, attempts)))
        self.futures[token] = self.executor.submit(work)

    def cancel(self, token):
        cancel = self.cancellations.get(token)
        if cancel:
            cancel.set()
        future = self.futures.get(token)
        if future and not future.cancelled() and future.cancel():
            # cancel() runs on the receiver thread. Publish asynchronously, as a
            # worker does, so a full bounded inbox cannot block its own consumer.
            result = ('llm_result', (token, None,
                {'code': 'CANCELLED', 'message': 'Model operation cancelled.', 'retryable': False}, 0))
            threading.Thread(target=self.inbox.put, args=(result,), name='llm-cancel', daemon=True).start()

    def complete(self, token):
        self.cancellations.pop(token, None)
        self.futures.pop(token, None)

    def close(self):
        for token in list(self.cancellations):
            self.cancel(token)
        self.executor.shutdown(wait=False)
