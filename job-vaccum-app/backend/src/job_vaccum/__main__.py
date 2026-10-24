import argparse
import logging
import multiprocessing
import os
from pathlib import Path
import signal
import sqlite3
import sys
import threading

from job_vaccum.service.server import serve
from job_vaccum.storage.database import DatabaseError
from job_vaccum.storage.paths import DataDirectoryBusy, data_directory


def bound_shutdown(shutdown):
    """EOF also occurs when Electron dies, so do not rely on its quit timer.

    This daemon only ends this service and children it created; it never reads
    persisted PIDs. SQLite commits already completed remain recoverable.
    """
    shutdown.wait()
    threading.Event().wait(10)
    logging.error('SHUTDOWN_TIMEOUT: Ending unfinished backend work.')
    for child in multiprocessing.active_children():
        if child.name == 'mihomo-owner':
            continue  # Pipe EOF on our exit makes the owner reap its kernel.
        try:
            child.kill()
            child.join(0.5)
        except (OSError, ValueError):
            pass  # The scrape supervisor may have just reaped this child.
    os._exit(0)  # ThreadPoolExecutor's atexit join must not extend the deadline.


def main() -> int:
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser(description="Job Vaccum JSON Lines service")
    parser.add_argument("--data-dir", required=True, type=Path,
                        help="Absolute writable directory supplied by Electron main")
    parser.add_argument("--enable-dev-commands", action="store_true", help="Enable public synthetic development fixtures (not in frozen builds)")
    args = parser.parse_args()
    if not args.data_dir.is_absolute():
        parser.error("--data-dir must be absolute")
    logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                        format="%(levelname)s %(message)s")
    shutdown = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: shutdown.set())
    try:
        with data_directory(args.data_dir) as root:
            threading.Thread(target=bound_shutdown, args=(shutdown,), name='shutdown-deadline', daemon=True).start()
            serve(root, sys.stdin.buffer, sys.stdout.buffer, enable_dev=args.enable_dev_commands, shutdown=shutdown)
    except DataDirectoryBusy:
        logging.error("BUSY: Another backend owns this data directory.")
        return 2
    except (BrokenPipeError, KeyboardInterrupt):
        return 0
    except (DatabaseError, sqlite3.Error, OSError):
        # Do not echo exception strings, SQL, paths, or incoming messages.
        logging.error("STARTUP_ERROR: Cannot initialize backend storage; check directory access and database version.")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
