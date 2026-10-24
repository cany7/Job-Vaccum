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

    def take(queue, count):
        with queues_lock:
            if stop.is_set():
                return []
            return [queue.popleft() for _ in range(min(count, len(queue)))]

    def run_task(task, address):
        if stop.is_set():
            return {'error': None}
        inbox.put(('retrieval_started', task['id']))
        try:
            result = retrieve(task['spec'], parameters, address, stop, attempt,
                              lambda: inbox.put(('retrieval_attempt', task['id'])))
            result['attempt_count'] = task['attempt_count'] + result.pop('attempts')
        except Exception:
            result = {'records': [], 'warnings': [], 'error': {'code': 'WORKER_EXITED', 'message': 'Scrape worker failed.', 'retryable': False}, 'access_failed': True}
        inbox.put(('retrieval_result', (task['id'], result)))
        return result

    def lane(queue, address):
        while batch := take(queue, 1):
            run_task(batch[0], address)

    def port_lane(queue, port, pool):
        pressure = False
        while queue and not stop.is_set():
            if not pool.prepare(port, pressure=pressure):
                return  # Unassigned tasks stay in the shared queue for other ports.
            batch = take(queue, snapshot['mihomo']['batch_size'])
            if not batch:
                return
            # A batch is a count of whole JobSpy tasks, including their finite
            # retries. Draining this executor precedes any next node switch.
            with ThreadPoolExecutor(max_workers=min(len(batch), snapshot['mihomo']['concurrency_per_port'])) as workers:
                futures = [workers.submit(run_task, task, f'http://127.0.0.1:{port}') for task in batch]
                results = [future.result() for future in as_completed(futures)]
            pressure = pool.pressured(results)

    try:
        mode = snapshot['proxy']['mode']
        if mode == 'mihomo':
            instance = instance_factory(snapshot['mihomo'], root, stop)
            instance.start()
            pool = pool_factory(snapshot['mihomo'], [n['name'] for n in instance.nodes], instance.controller, stop)
            linkedin = deque(t for t in tasks if t['spec']['site'] == 'linkedin')
            indeed = deque(t for t in tasks if t['spec']['site'] == 'indeed')
            concurrency = parameters['retrieval_concurrency']
            indeed_count = concurrency['indeed'] if isinstance(concurrency, dict) else concurrency
            with ThreadPoolExecutor(max_workers=snapshot['mihomo']['port_count'] + indeed_count) as workers:
                futures = [workers.submit(lane, indeed, None) for _ in range(min(indeed_count, len(indeed)))]
                futures += [workers.submit(port_lane, linkedin, port, pool) for port in
                            range(snapshot['mihomo']['start_port'], snapshot['mihomo']['start_port'] + snapshot['mihomo']['port_count'])]
                for future in as_completed(futures):
                    future.result()
            proxy_stats = pool.stats
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
        if instance:
            try:
                instance.close()
            except Exception:
                error = {'code': 'PROXY_ERROR', 'message': 'Mihomo resource cleanup failed.', 'retryable': False}
        inbox.put(('retrieval_done', (error, proxy_stats)))
