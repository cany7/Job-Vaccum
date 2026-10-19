# Backend service

Python 3.13 service, UTF-8 JSON Lines on stdin/stdout. Only Python owns
`app.sqlite3`. Migration 001 creates settings; migration 002 adds jobs,
identities, directions/queries, job directions and applications. Existing M0
settings survive migration. Scraping, scoring, runs and scheduling belong to
later milestones; this step has no renderer business interface.

From the repository root:

```sh
cd job-vaccum-app/backend
uv sync --locked
uv run --locked python -m job_vaccum --data-dir "$(git rev-parse --show-toplevel)/tmp/job-vaccum-app"
```

`--data-dir` must be absolute. Electron main supplies its userData directory in
the packaged application. The service creates `logs/`, `tmp/`, `app.sqlite3`,
and a persistent `service.lock` file. The OS releases the advisory lock on exit
or crash; do not unlink the lock file or kill processes based on its existence.
Startup clears App-owned tmp resources and checks retention; automatic cleanup checks every 60 seconds while the service is running. No run recovery is implemented yet.

## Protocol v1

First output, only after the lock and migrations succeed:

```json
{"type":"event","name":"ready","seq":1,"data":{"protocol_version":1,"app_version":"0.1.0","schema_version":2}}
```

Requests contain `type: "request"`, a string `id` (1–128 characters), a
nonempty string `method`, and optional object `params` (defaults to `{}`).
Unknown envelope fields are rejected. The 1 MiB line limit excludes LF.
Use a UTF-8 streaming decoder and buffer until LF; chunks can split Unicode
characters or contain multiple complete messages.

| Method | Params | Result |
| --- | --- | --- |
| `app.status` | `{}` | `{active_run:null, operations:[], cleanup:{status:"idle"}, configuration_complete:false, storage:{schema_version:1,journal_mode:"wal"}}` |
| `app.ping` | `{message:string}` (≤256 characters) | `{message:string}` |
| `app.diagnostics` | `{}` | Offline Python/architecture/dependency versions, declared locked JobSpy commit, native curl version, SQLite transactional read/write result |

`app.ping` and `app.diagnostics` are small M0 verification commands. Diagnostics
imports JobSpy/pandas/curl_cffi and allocates a native curl handle without making
network requests. Its synthetic SQLite write is rolled back, retaining no probe
state. It does not verify real website access or scraping behavior.

```json
{"type":"request","id":"sample","method":"app.ping","params":{"message":"hello"}}
{"type":"response","id":"sample","ok":true,"result":{"message":"hello"}}
{"type":"request","id":"bad","method":"unsupported"}
{"type":"response","id":"bad","ok":false,"error":{"code":"NOT_FOUND","message":"Unknown method for this backend milestone.","retryable":false}}
```

Malformed UTF-8/JSON, an invalid id, or an oversized line returns an error with
`id:null`. Other request validation failures preserve a valid id. Errors do not
echo incoming values or exception text. Each incoming line produces at most one
response; ids correlate responses and are not replay tokens. Diagnostics errors
return `INTERNAL_ERROR`; request validation returns `VALIDATION_ERROR`.
Output responses are serialized and checked before any bytes are written. An
oversized valid result returns `RESPONSE_TOO_LARGE` with the original request ID;
the connection stays usable. Reduce the page size or selection rather than
retrying the same large query. No fields are silently truncated. Application
update responses and remove Undo snapshots are checked before commit; if they
exceed the limit, that transaction rolls back. The limit counts serialized bytes
(including JSON escaping), not characters. Electron still rejects genuinely
malformed/oversized protocol lines.

Logs use stderr. Startup failures produce no ready event, an explanatory stderr
message, and exit code 2. The data directory being owned returns stderr `BUSY`.

EOF and SIGTERM close SQLite and release the lock. No shutdown command is added.
Electron should keep stdin open while its backend is needed; closing the window
must retain main/service. Explicit Quit closes stdin, waits up to 10 seconds,
then terminates only its owned process if necessary. CSV exports use a reader thread and finish on EOF; Electron still bounds process shutdown. Future scraping workers and LLM shutdown behavior are not implemented yet.

## M1 data commands

All parameters use snake_case. Validation rejects unexpected fields, invalid
states, invalid ranges, and unknown sorts. IDs created by the service are UUIDs.
Timestamps are UTC milliseconds; source publication dates remain YYYY-MM-DD.

- `jobs.list`: FilterSpec fields directly in params, plus `scope` (discover or
  applications), `sort`, `page` (1-based), `page_size` (1..200, default 50).
  Returns `{items,total}`; summaries omit JD. `jobs.detail {job_id}` returns full JD.
  Multi-select dimensions are OR within each dimension, AND between dimensions.
  Empty arrays mean unrestricted. NULL sort values always appear last, with ID
  as a stable tiebreaker. Salary ranges require currency and interval and match
  overlapping known intervals. Nonempty run_ids requires M2 and returns validation
  error; no run tables are created early.
- `applications.add {job_id}` and `add_many {job_ids}` return added,
  already_present or not_found without overwriting existing user fields.
  `update {job_id,status?,notes?}`, `set_status {job_ids,status}`,
  `remove {job_ids}`, `restore {items}` support management and transient UI Undo.
  Bulk IDs are deduplicated, at most 200 per command. remove returns full original
  records; set_status returns previous status and updated_at. Strip the `outcome`
  field from successful set_status items before sending them to restore. Status
  snapshots restore only status/updated_at and never replace notes. A full remove
  snapshot can reinsert an application; a status-only snapshot cannot recreate
  an application subsequently removed by the user. Oversized update/remove
  responses return RESPONSE_TOO_LARGE before commit; a rejected remove does not
  lose applications or Undo data. Undo is not persisted.
- `settings.get` returns retention_days and directions with their queries.
  `settings.save {retention_days}` accepts nonnegative integers (default 14,
  zero disables automatic expiration); saving never performs cleanup.
- `directions.save {id?,name?,enabled?}`, `delete {id}`, `reorder {ids}` and
  `queries.save {id?,direction_id?,expression?,enabled?}`, `delete {id}`.
  Reorder must list every current direction once. Direction deletion also removes
  that direction's query labels and associations, preserving jobs and sources.
- `cleanup.preview {mode:"manual"|"automatic"}` returns counts, retained
  application count, and disabled flag. `cleanup.execute {mode:"manual"}` checks
  current application protection again inside its transaction. Only App-owned
  logs/tmp are cleaned; symlinks are not traversed. `failed_files` reports partial
  file cleanup failures after the database commit. runs counts are zero in M1;
  M2/M7 will connect run/schedule retention when those tables are introduced.
- `export.csv {scope,filter?,range:"filtered"|"all",include_jd,destination_path}`
  is private main-to-service input. Renderer uses a main-owned save-panel token,
  never a path. Main resolves existing targets or a new filename's parent, checks
  the actual data root at selection and export, and stores the resolved path in
  the token. Python resolves again before opening and rejects targets inside the
  actual App data directory, including file/parent symlinks. Returns operation_id, then operation.completed with row_count or
  operation.failed with a controlled error. Streaming CSV uses a read-only WAL
  snapshot, UTF-8 BOM, and all matching pages; queries and application edits
  remain responsive. Cleanup and a second export return BUSY during export.
  Failure may leave a partial CSV; no retry, replay, or recovery file is created.
- Committed changes emit jobs.changed, cleanup emits cleanup.completed. Event seq
  increases within the current session. Events are notifications, not persistent
  history; consumers re-query current data.

For public synthetic development fixtures, explicitly start the service with
`--enable-dev-commands`, then send:

```json
{"type":"request","id":"seed","method":"dev.import_synthetic","params":{"count":125}}
{"type":"request","id":"browse","method":"jobs.list","params":{"page":1,"page_size":50}}
```

The fixture contains two directions, multiple sources, no score, zero score and
long JD. Reimport merges collection relationships and preserves existing body,
first_seen, scores and application data. This is not M2 scraper normalization or
deduplication. Frozen builds refuse the import even if the flag is supplied.

## Verification and packaging

From `job-vaccum-app/backend`:

```sh
uv run --locked pytest -q
uv run --locked pyinstaller ../packaging/backend.spec --noconfirm --distpath ../dist/backend --workpath ../build/backend
```

The arm64 onedir payload is `job-vaccum-app/dist/backend/job-vaccum-service/`.
Copy the entire directory, including `_internal`, into Electron resources;
spawn the contained `job-vaccum-service` executable by absolute path with no
shell. It needs neither Python, uv, the source tree, nor a project venv at runtime.
Keep runtime data outside the read-only bundle. The spec collects only its
entrypoint, backend code, migration SQL and resolved dependencies, not the repo.

From the repository root, actual Electron main process smoke checks:

```sh
APP_ROOT="$PWD/job-vaccum-app"
"$APP_ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$APP_ROOT/tests/electron-backend-smoke.cjs" --python "$APP_ROOT/backend/.venv/bin/python" --data-dir "$PWD/tmp/job-vaccum-app/electron dev smoke"
"$APP_ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$APP_ROOT/tests/electron-backend-smoke.cjs" --backend "$APP_ROOT/dist/backend/job-vaccum-service/job-vaccum-service" --data-dir "$PWD/tmp/job-vaccum-app/electron frozen smoke"
```

These checks run with cwd `/` and a restricted child PATH, and exercise handshake,
fragmented UTF-8, multiple messages, a controlled error, offline native imports,
SQLite read/write, and EOF exit. No renderer or desktop layout is created.

Validated on macOS 27.0.1 arm64: Python 3.13.12, Electron 44.9.0, JobSpy
1.3.0 at commit `1988484ac76ff9ae57784750346842e967e8ba10`, pandas 3.0.6,
curl_cffi 0.16.3, SQLite 3.54.0, PyInstaller 6.22.3. A copied frozen payload
also passed with the project's `.venv` and backend source temporarily unavailable,
from a path containing spaces. Payload size is approximately 68 MiB.
The bundled Python dylib declares macOS minimum 15.6; older macOS releases have
not been tested. PyInstaller reports optional jinja2 and Windows DLL warnings;
the required native imports pass without adding those optional dependencies.

This is a local backend payload with PyInstaller ad hoc signing. M0 desktop
integration and the complete arm64 `.app`/DMG are now implemented; see
`../desktop/README.md` for build/start/installed-window tests. The DMG-installed
App passed an isolated run on the development Mac without the project venv or
source. A second physical Mac, Developer ID signing and notarization remain
untested/unavailable; this is not a publicly signed release.
