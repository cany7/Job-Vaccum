"""Network-only coordinator; SQLite writes remain on the service receive loop."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

from job_vaccum.pipeline.scraper import retrieve
from job_vaccum.proxy.mihomo import Instance
from job_vaccum.proxy.pool import PortPool
from job_vaccum.service.protocol import CommandError


def execute(tasks, snapshot, proxy, stop, attempt, inbox, root, *, instance_factory=Instance, pool_factory=PortPool):
    parameters = snapshot['parameters']
    instance, proxy_stats, error = None, {}, None
    queues_lock = threading.Lock()
    ready = threading.Condition(queues_lock)
    in_flight = 0
    accumulated = {}

    def take(queue, count):
        with queues_lock:
            if stop.is_set():
                return []
            return [queue.popleft() for _ in range(min(count, len(queue)))]

    def run_task(task, address, *, single=False):
        if stop.is_set():
            return {'error': None}
        inbox.put(('retrieval_started', task['id']))
        attempts = 0
        def on_attempt():
            nonlocal attempts
            attempts += 1
            inbox.put(('retrieval_attempt', task['id']))
        try:
            result = retrieve(task['spec'], {**parameters, 'max_attempts': 1} if single else parameters, address, stop, attempt,
                              on_attempt)
            result['attempt_count'] = task['attempt_count'] + result.pop('attempts')
        except Exception:
            result = {'records': [], 'warnings': [], 'attempt_count': task['attempt_count'] + attempts,
                      'error': {'code': 'WORKER_EXITED', 'message': 'Scrape worker failed.', 'retryable': False}, 'access_failed': True}
        if not single:
            inbox.put(('retrieval_result', (task['id'], result)))
        return result

    def lane(queue, address):
        while batch := take(queue, 1):
            run_task(batch[0], address)

    def port_lane(queue, port, pool):
        nonlocal in_flight
        pressure = False
        while not stop.is_set():
            with ready:
                # Other ports may return failed attempts. Stay available until
                # both the queue and all batches are exhausted.
                while not queue and in_flight and not stop.is_set():
                    ready.wait(.1)
                if stop.is_set() or not queue:
                    return
                batch = [queue.popleft() for _ in range(min(snapshot['mihomo']['batch_size'], len(queue)))]
                in_flight += len(batch)
            retry = list(batch)
            try:
                if not pool.prepare(port, pressure=pressure):
                    return
                # Publish retries only after every attempt in this batch drains.
                with ThreadPoolExecutor(max_workers=min(len(batch), snapshot['mihomo']['concurrency_per_port'])) as workers:
                    futures = {workers.submit(run_task, task, f'http://127.0.0.1:{port}', single=True): task for task in batch}
                    results = [(futures[f], f.result()) for f in as_completed(futures)]
                pressure = pool.pressured([r for _, r in results])
                retry = []
                for task, result in results:
                    if 'attempt_count' not in result:
                        continue  # stopped before an attempt was sent
                    total = accumulated.setdefault(task['id'], {'records': [], 'warnings': [], 'http_requests': 0,
                        'http_429': 0, 'attempt_count': task['attempt_count'], 'error': None})
                    total['records'].extend(result['records'])
                    total['warnings'].extend(w for w in result['warnings'] if w not in total['warnings'])
                    for key in ('http_requests', 'http_429'):
                        total[key] += result.get(key, 0)
                    total['attempt_count'] += result['attempt_count'] - task['attempt_count']
                    total['error'] = result['error']
                    if (not stop.is_set() and result['error'] and result['error']['retryable']
                            and total['attempt_count'] - task['attempt_count'] < parameters['max_attempts']):
                        retry.append(task)
                    else:
                        inbox.put(('retrieval_result', (task['id'], accumulated.pop(task['id']))))
            finally:
                with ready:
                    queue.extend(retry)
                    in_flight -= len(batch)
                    ready.notify_all()

    try:
        mode = snapshot['proxy']['mode']
        if mode == 'mihomo':
            linkedin = deque(t for t in tasks if t['spec']['site'] == 'linkedin')
            indeed = deque(t for t in tasks if t['spec']['site'] == 'indeed')
            concurrency = parameters['retrieval_concurrency']
            indeed_count = concurrency['indeed'] if isinstance(concurrency, dict) else concurrency
            with ThreadPoolExecutor(max_workers=snapshot['mihomo']['port_count'] + indeed_count) as workers:
                futures = [workers.submit(lane, indeed, None) for _ in range(min(indeed_count, len(indeed)))]
                if linkedin and not stop.is_set():
                    # Indeed has already started; even validation/startup failure
                    # here waits for its independent lane before reporting done.
                    instance = instance_factory(snapshot['mihomo'], root, stop)
                    instance.start()
                    pool = pool_factory(snapshot['mihomo'], [n['name'] for n in instance.nodes], instance.controller, stop)
                    proxy_stats = pool.stats
                    futures += [workers.submit(port_lane, linkedin, port, pool) for port in
                                range(snapshot['mihomo']['start_port'], snapshot['mihomo']['start_port'] + snapshot['mihomo']['port_count'])]
                for future in as_completed(futures):
                    future.result()
            if linkedin and not stop.is_set():
                raise CommandError('All Mihomo ports are unavailable; remaining tasks were returned without direct fallback.', 'PROXY_ERROR')
        else:
            concurrency = parameters['retrieval_concurrency']
            if isinstance(concurrency, int):
                lanes = [(deque(tasks), concurrency)]
            else:
                lanes = [(deque(t for t in tasks if t['spec']['site'] == site), concurrency[site]) for site in ('linkedin', 'indeed')]
            with ThreadPoolExecutor(max_workers=sum(count for _, count in lanes)) as workers:
                futures = [workers.submit(lane, queue, proxy) for queue, count in lanes for _ in range(min(count, len(queue)))]
                for future in as_completed(futures):
                    future.result()
    except Exception as exc:
        error = {'code': exc.code if isinstance(exc, CommandError) else 'PROXY_ERROR',
                 'message': str(exc) if isinstance(exc, CommandError) else 'Retrieval coordinator failed; completed results were retained.', 'retryable': False}
    finally:
        # A retry may be stranded when all ports disable. Commit its accumulated
        # partial results once, with its real attempts, before the run error.
        for task_id, result in accumulated.items():
            result['error'] = error or {'code': 'CANCELLED', 'message': 'Scrape stopped.', 'retryable': False}
            inbox.put(('retrieval_result', (task_id, result)))
        if instance:
            try:
                instance.close()
            except Exception:
                error = {'code': 'PROXY_ERROR', 'message': 'Mihomo resource cleanup failed.', 'retryable': False}
        inbox.put(('retrieval_done', (error, proxy_stats)))
