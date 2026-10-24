"""Explicit opt-in live probe. Never collected by pytest; no credentials in output.

Provide --kernel and --nodes. Add --query, --location and --results only with
authorization for one real LinkedIn attempt; scoring is never invoked.
"""
import argparse
import json
from pathlib import Path
import tempfile
import threading

from job_vaccum.pipeline.advanced import ADVANCED, MIHOMO
from job_vaccum.pipeline.scraper import process_attempt
from job_vaccum.proxy.mihomo import Instance, check_ports
from job_vaccum.proxy.pool import PortPool
from job_vaccum.service.protocol import CommandError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kernel', required=True)
    parser.add_argument('--nodes', required=True)
    parser.add_argument('--start-port', type=int, default=17901)
    parser.add_argument('--controller-port', type=int, default=19099)
    parser.add_argument('--delay-threshold-ms', type=float, default=1000)
    parser.add_argument('--max-candidates', type=int, default=5)
    parser.add_argument('--query')
    parser.add_argument('--location')
    parser.add_argument('--results', type=int)
    args = parser.parse_args()
    if args.query and (not args.location or not args.results or args.results < 1):
        parser.error('A query requires a location and positive results count.')
    config = {**MIHOMO, 'executable_path': str(Path(args.kernel).resolve()),
              'config_path': str(Path(args.nodes).resolve()), 'port_count': 2,
              'start_port': args.start_port, 'controller_port': args.controller_port,
              'max_candidates': args.max_candidates, 'delay_threshold_ms': args.delay_threshold_ms,
              'concurrency_per_port': 1, 'batch_size': 1}
    source = Path(config['config_path']).read_bytes()
    stop = threading.Event()
    report = {}
    with tempfile.TemporaryDirectory(prefix='job-vaccum-live-') as directory:
        root = Path(directory)
        (root / 'tmp').mkdir()
        instance = Instance(config, root, stop)
        try:
            instance.start()
            report['kernel_started'] = True
            print(json.dumps(report), flush=True)
            pool = PortPool(config, [n['name'] for n in instance.nodes], instance.controller, stop)
            ports = range(args.start_port, args.start_port + 2)
            report['ports_ready'] = [pool.prepare(port) for port in ports]
            report['distinct_exits'] = len({ip for _, ip in pool.active.values()})
            if all(report['ports_ready']):
                old = pool.active[args.start_port][1]
                report['rotation_ready'] = pool.prepare(args.start_port)
                report['exit_changed'] = args.start_port in pool.active and old != pool.active[args.start_port][1]
            print(json.dumps(report), flush=True)
            if args.query and pool.active:
                port = next(iter(pool.active))
                spec = {'site': 'linkedin', 'expression': args.query, 'location': args.location,
                        'distance_miles': 25, 'country_indeed': 'usa'}
                params = {**ADVANCED, 'results_wanted': {'linkedin': args.results, 'indeed': args.results},
                          'max_attempts': 1, 'timeout_seconds': 90}
                result = process_attempt(spec, params, f'http://127.0.0.1:{port}', stop)
                report['scrape'] = {'site': 'linkedin', 'query': args.query, 'location': args.location,
                    'results_wanted': args.results, 'returned': len(result['records']),
                    'http_requests': result.get('http_requests', 0), 'http_429': result.get('http_429', 0),
                    'error_code': result['error']['code'] if result['error'] else None}
            report['proxy_stats'] = pool.stats
        except CommandError as exc:
            report['error_code'] = exc.code
        finally:
            instance.close()
            report['temporary_resources_removed'] = not list((root / 'tmp').iterdir())
            report['source_unchanged'] = Path(config['config_path']).read_bytes() == source
            check_ports(config)
            report['ports_released'] = True
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
