from pathlib import Path
import sqlite3

SCHEMA_VERSION = 5
MIGRATIONS = Path(__file__).with_name("migrations")


class DatabaseError(Exception):
    pass


def migrate(connection: sqlite3.Connection, migrations: Path = MIGRATIONS) -> None:
    """Apply pending SQL and version changes together, without executescript's commit."""
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)")
        rows = connection.execute("SELECT version FROM schema_version").fetchall()
        current = rows[0][0] if len(rows) == 1 else 0
        if len(rows) > 1 or not 0 <= current <= SCHEMA_VERSION:
            raise DatabaseError("Unsupported database schema")
        for version in range(current + 1, SCHEMA_VERSION + 1):
            statement = ""
            for line in (migrations / f"{version:03d}.sql").read_text(encoding="utf-8").splitlines(True):
                statement += line
                if sqlite3.complete_statement(statement):
                    connection.execute(statement)
                    statement = ""
            if statement.strip():
                raise DatabaseError("Incomplete migration statement")
            connection.execute("DELETE FROM schema_version")
            connection.execute("INSERT INTO schema_version VALUES (?)", (version,))
        connection.commit()
    except (sqlite3.Error, OSError, DatabaseError) as exc:
        connection.rollback()
        raise DatabaseError("Database migration failed") from exc


def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=5)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        mode = connection.execute("PRAGMA journal_mode = WAL").fetchone()[0]
        if mode != "wal":
            raise DatabaseError("WAL unavailable")
        migrate(connection)
        return connection
    except BaseException:
        connection.close()
        raise


def storage_check(connection: sqlite3.Connection) -> dict:
    """Exercise a real write/read transaction without retaining diagnostic state."""
    connection.execute("SAVEPOINT m0_storage_check")
    try:
        connection.execute("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                           ("__m0_storage_probe", '"synthetic storage probe"'))
        value = connection.execute("SELECT value_json FROM settings WHERE key = ?",
                                   ("__m0_storage_probe",)).fetchone()[0]
        if value != '"synthetic storage probe"':
            raise DatabaseError("SQLite roundtrip failed")
    finally:
        connection.execute("ROLLBACK TO m0_storage_check")
        connection.execute("RELEASE m0_storage_check")
    return {"read_write": True, "schema_version": SCHEMA_VERSION,
            "journal_mode": connection.execute("PRAGMA journal_mode").fetchone()[0]}
