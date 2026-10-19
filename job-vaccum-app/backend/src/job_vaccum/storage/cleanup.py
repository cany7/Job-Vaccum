import logging
import os
from pathlib import Path
import shutil

from job_vaccum.storage.filters import choice

DAY = 86_400_000


class Cleanup:
    def __init__(self, repo, root: Path):
        self.repo, self.root = repo, root

    def candidates(self, mode):
        choice(mode, 'mode', ('manual', 'automatic'))
        days = self.repo.settings()['retention_days']
        disabled = mode == 'automatic' and days == 0
        predicate = 'NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id=jobs.id)'
        values = []
        cutoff = None
        if disabled:
            predicate = '0'
        elif mode == 'automatic':
            cutoff = self.repo.clock() - days * DAY
            predicate += ' AND first_seen_at < ?'
            values.append(cutoff)
        return predicate, values, cutoff, disabled

    def files(self, cutoff=None):
        result = []
        for name in ('logs', 'tmp'):
            directory = self.root / name
            # Never traverse an external directory even if the app subdirectory was replaced.
            if directory.is_symlink():
                raise OSError('App cleanup directory must not be a symlink')
            if not directory.exists():
                continue
            if cutoff is None:
                result.extend(directory.iterdir())
                continue
            for parent, dirs, files in os.walk(directory, followlinks=False):
                paths = [Path(parent) / name for name in files]
                paths += [Path(parent) / name for name in dirs if (Path(parent) / name).is_symlink()]
                for path in paths:
                    if path.lstat().st_mtime_ns // 1_000_000 < cutoff:
                        result.append(path)
        return result

    def preview(self, mode):
        predicate, values, cutoff, disabled = self.candidates(mode)
        db = self.repo.db
        return {'jobs': db.execute(f'SELECT count(*) FROM jobs WHERE {predicate}', values).fetchone()[0],
                'runs': 0, 'applications': db.execute('SELECT count(*) FROM applications').fetchone()[0],
                'files': 0 if disabled else len(self.files(cutoff)), 'disabled': disabled}

    def execute(self, mode):
        db = self.repo.db
        with db:
            db.execute('BEGIN IMMEDIATE')
            predicate, values, cutoff, disabled = self.candidates(mode)
            deleted = db.execute(f'DELETE FROM jobs WHERE {predicate}', values).rowcount
        # File cleanup is separate: keep successfully committed database deletion.
        removed, failed = 0, []
        if not disabled:
            try:
                paths = self.files(cutoff)
            except OSError:
                paths = []
                failed.append('logs/tmp')
            for path in paths:
                try:
                    if path.is_symlink() or not path.is_dir():
                        path.unlink()
                    else:
                        # rmtree does not follow directory symlinks inside this tree.
                        shutil.rmtree(path)
                    removed += 1
                except OSError:
                    failed.append(str(path.relative_to(self.root)))
        if failed:
            logging.error('CLEANUP_ERROR: Some application-owned files could not be removed.')
        return {'deleted_jobs': deleted, 'deleted_runs': 0, 'deleted_files': removed, 'failed_files': failed}

    def clear_tmp(self):
        directory = self.root / 'tmp'
        try:
            if directory.is_symlink():
                raise OSError
            for path in directory.iterdir() if directory.exists() else ():
                if path.is_symlink() or not path.is_dir():
                    path.unlink()
                else:
                    shutil.rmtree(path)
        except OSError:
            logging.error('CLEANUP_ERROR: Application temporary files could not be removed.')
