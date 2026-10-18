from contextlib import contextmanager
import fcntl
from pathlib import Path


class DataDirectoryBusy(Exception):
    pass


@contextmanager
def data_directory(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    # Keep this file in place: unlinking a locked inode would allow another owner.
    with (root / "service.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DataDirectoryBusy from exc
        try:
            for name in ("logs", "tmp"):
                (root / name).mkdir(exist_ok=True)
            yield root
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
