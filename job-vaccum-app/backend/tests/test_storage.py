from contextlib import closing
import sqlite3

import pytest

from job_vaccum.storage.database import DatabaseError, connect, migrate, storage_check


def test_empty_database_restart_and_transaction(tmp_path):
    path = tmp_path / "app.sqlite3"
    with closing(connect(path)) as db:
        assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert db.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        assert storage_check(db) == {"read_write": True, "schema_version": 3, "journal_mode": "wal"}
        assert db.execute("SELECT count(*) FROM settings").fetchone()[0] == 0
        with db:
            db.execute("INSERT INTO settings VALUES ('synthetic', '0')")
        with pytest.raises(sqlite3.IntegrityError), db:
            db.execute("INSERT INTO settings VALUES ('rolled_back', 'true')")
            db.execute("INSERT INTO settings VALUES ('synthetic', '1')")
    with closing(connect(path)) as db:
        assert db.execute("SELECT * FROM schema_version").fetchall() == [(3,)]
        assert db.execute("SELECT * FROM settings").fetchall() == [("synthetic", "0")]


def test_migration_failure_rolls_back_schema_and_version(tmp_path):
    (tmp_path / "001.sql").write_text("CREATE TABLE partial (id INTEGER);\nINVALID SQL;\n")
    with closing(sqlite3.connect(":memory:")) as db:
        with pytest.raises(DatabaseError):
            migrate(db, tmp_path)
        assert db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == []
        (tmp_path / "001.sql").write_text("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT);\n")
        (tmp_path / "002.sql").write_text("CREATE TABLE extra (id TEXT);\n")
        (tmp_path / "003.sql").write_text("CREATE TABLE runs (id TEXT);\n")
        migrate(db, tmp_path)
        assert db.execute("SELECT version FROM schema_version").fetchone() == (3,)


def test_future_schema_is_rejected_without_modifying_data(tmp_path):
    path = tmp_path / "app.sqlite3"
    with closing(connect(path)) as db, db:
        db.execute("UPDATE schema_version SET version=4")
        db.execute("INSERT INTO settings VALUES ('synthetic', 'true')")
    with pytest.raises(DatabaseError):
        connect(path)
    with closing(sqlite3.connect(path)) as db:
        assert db.execute("SELECT version FROM schema_version").fetchone() == (4,)
        assert db.execute("SELECT value_json FROM settings").fetchone() == ("true",)
