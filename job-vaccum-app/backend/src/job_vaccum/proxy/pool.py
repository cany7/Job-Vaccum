"""Port-local rotations with shared node reservations and IPv4 cooldown."""
import ipaddress
import random
import threading
import time

from job_vaccum.proxy.mihomo import exit_ipv4
from job_vaccum.service.protocol import CommandError


class PortPool:
    def __init__(self, config, nodes, controller, stop, *, probe=exit_ipv4,
                 clock=time.monotonic, wait=None, shuffle=random.shuffle):
        self.config, self.nodes, self.controller, self.stop = config, list(nodes), controller, stop
        self.probe, self.clock, self.wait, self.shuffle = probe, clock, wait or stop.wait, shuffle
        self.lock = threading.Lock()
        self.active, self.testing, self.cooling = {}, set(), {}
        self.stats = dict(rotations=0, candidate_failures=0, retained=0, pressure_events=0, disabled_ports=0)

    def _exit(self, port):
        ip = ipaddress.IPv4Address(self.probe(port))
        if not ip.is_global:
            raise ValueError
        return str(ip)

    def _available_ip(self, ip, port, old=None):
        return (ip != old and self.cooling.get(ip, 0) <= self.clock()
                and all(other_ip != ip for p, (_, other_ip) in self.active.items() if p != port))

    def rotate(self, port):
        old = self.active.get(port)
        candidates = list(self.nodes)
        self.shuffle(candidates)
        tested = 0
        for node in candidates:
            if self.stop.is_set() or tested >= self.config['max_candidates']:
                break
            with self.lock:
                if node in self.testing or any(n == node for n, _ in self.active.values()):
                    continue
                self.testing.add(node)
            tested += 1
            accepted = False
            try:
                checks = []
                for _ in range(2):
                    if self.stop.is_set():
                        raise ValueError
                    try:
                        checks.append(self.controller.delay(node, self.config['delay_threshold_ms']))
                    except (CommandError, OSError):
                        checks.append(False)
                if not all(checks):
                    raise ValueError
                self.controller.select(port, node)
                ip = self._exit(port)
                with self.lock:
                    if not self._available_ip(ip, port, old[1] if old else None):
                        raise ValueError
                    if old:
                        self.cooling[old[1]] = self.clock() + self.config['cooldown_seconds']
                    self.active[port] = (node, ip)
                    self.stats['rotations'] += 1
                    accepted = True
                return True
            except (CommandError, ValueError, OSError):
                with self.lock:
                    self.stats['candidate_failures'] += 1
            finally:
                try:
                    if not accepted and old:
                        # A failed switch must not leave the controller on the
                        # failed candidate. Failure to restore disables the port.
                        self.controller.select(port, old[0])
                finally:
                    with self.lock:
                        self.testing.discard(node)
        return False

    def prepare(self, port, *, pressure=False):
        """Called only with zero tasks in flight on this port."""
        try:
            if pressure:
                with self.lock:
                    self.stats['pressure_events'] += 1
                for _ in range(2):
                    if self.wait(self.config['pressure_backoff_seconds']):
                        return False
                    if self.rotate(port):
                        return True
                # Never retain an exit under pressure, even if its probe works.
            elif self.rotate(port):
                return True
            elif port in self.active and not self.stop.is_set():
                ip = self._exit(port)
                with self.lock:
                    old_node, old_ip = self.active[port]
                    if not self._available_ip(ip, port):
                        raise ValueError
                    if ip != old_ip:
                        self.cooling[old_ip] = self.clock() + self.config['cooldown_seconds']
                    self.active[port] = (old_node, ip)
                    self.stats['retained'] += 1
                if not self.wait(self.config['retain_wait_seconds']):
                    return True
        except (CommandError, ValueError, OSError):
            pass
        self.disable(port)
        return False

    def disable(self, port):
        with self.lock:
            old = self.active.pop(port, None)
            if old:
                self.cooling[old[1]] = self.clock() + self.config['cooldown_seconds']
            self.stats['disabled_ports'] += 1

    def pressured(self, results):
        requests = sum(r.get('http_requests', 0) for r in results)
        rate_limited = sum(r.get('http_429', 0) for r in results)
        return (any(r.get('access_failed', False) for r in results)
                or requests > 0 and rate_limited / requests >= self.config['http_429_ratio'])
