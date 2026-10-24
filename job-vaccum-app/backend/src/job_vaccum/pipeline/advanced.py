"""M6 public, non-secret configuration. Nested patches preserve omitted fields."""
from copy import deepcopy
import math
from pathlib import Path

from job_vaccum.service.protocol import CommandError
from job_vaccum.storage.filters import fields, integer, string

ADVANCED = {
    'results_wanted': {'linkedin': 100, 'indeed': 200}, 'hours_old': 72,
    'retrieval_concurrency': {'linkedin': 1, 'indeed': 1},
    'timeout_seconds': 600, 'max_attempts': 3, 'retry_base_seconds': 5,
    'llm_concurrency': 4, 'llm_rpm': 30,
    'llm_connect_timeout_seconds': 10, 'llm_read_timeout_seconds': 120,
}
MIHOMO = {
    'executable_path': None, 'config_path': None,
    'port_count': 8, 'concurrency_per_port': 2, 'batch_size': 2,
    'start_port': 7901, 'controller_port': 9099, 'cooldown_seconds': 300,
    'failed_node_cooldown_seconds': 60,
    'max_candidates': 30, 'delay_threshold_ms': 1000,
    'pressure_backoff_seconds': 30, 'retain_wait_seconds': 5,
    'http_429_ratio': 0.15,
}


def positive(value, key):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise CommandError(f'{key} must be a finite positive number.')
    return value


def patch_config(current, patch, *, mihomo=False):
    defaults = MIHOMO if mihomo else ADVANCED
    fields(patch, defaults)
    result = deepcopy(current)
    for key, value in patch.items():
        if key in ('results_wanted', 'retrieval_concurrency'):
            fields(value, {'linkedin', 'indeed'})
            for site, number in value.items():
                integer(number, key + '.' + site, 1)
            result[key].update(value)
        else:
            result[key] = value
    for key, value in result.items():
        if key in ('results_wanted', 'retrieval_concurrency'):
            continue
        if key.endswith('_path'):
            if value is not None:
                string(value, key)
                if not Path(value).is_absolute():
                    raise CommandError(f'{key} must be an absolute local path.')
        elif key in ('hours_old', 'max_attempts', 'llm_concurrency', 'port_count',
                     'concurrency_per_port', 'batch_size', 'start_port', 'controller_port', 'max_candidates'):
            integer(value, key, 0 if key == 'hours_old' else 1,
                    65535 if key in ('start_port', 'controller_port', 'port_count') else 2**31-1)
        else:
            positive(value, key)
    if mihomo:
        if result['http_429_ratio'] > 1:
            raise CommandError('http_429_ratio must be in (0, 1].')
        end = result['start_port'] + result['port_count'] - 1
        if end > 65535 or result['start_port'] <= result['controller_port'] <= end:
            raise CommandError('Mihomo listener range must fit valid ports and exclude the controller port.')
    return result


def effective(settings, defaults):
    return deepcopy(settings['advanced_parameters'] if settings.get('run_mode') == 'advanced' else defaults)
