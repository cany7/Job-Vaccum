import argparse
import logging
from pathlib import Path
import signal
import sqlite3
import sys

from job_vaccum.service.server import serve
from job_vaccum.storage.database import DatabaseError
from job_vaccum.storage.paths import DataDirectoryBusy, data_directory


def main() -> int:
    parser = argparse.ArgumentParser(description="Job Vaccum JSON Lines service")
    parser.add_argument("--data-dir", required=True, type=Path,
                        help="Absolute writable directory supplied by Electron main")
    args = parser.parse_args()
    if not args.data_dir.is_absolute():
        parser.error("--data-dir must be absolute")
    logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                        format="%(levelname)s %(message)s")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        with data_directory(args.data_dir) as root:
            serve(root, sys.stdin.buffer, sys.stdout.buffer)
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
