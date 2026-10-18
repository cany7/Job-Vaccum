# M0 backend

Python 3.13 service, UTF-8 JSON Lines on stdin/stdout. No HTTP server,
scraping, LLM calls, scheduler, or job/application repositories yet.
Only Python owns `app.sqlite3`. Migration 001 creates `schema_version`
and `settings`; business tables belong to later migrations.

From the repository root:

```sh
cd job-vaccum-app/backend
uv sync --locked --python "$(pyenv root)/versions/3.13.12/bin/python"
uv run --locked python -m job_vaccum --data-dir "$(git rev-parse --show-toplevel)/tmp/job-vaccum-app"
```

`--data-dir` must be absolute. Electron main supplies its userData directory in
the packaged application. The service creates `logs/`, `tmp/`, `app.sqlite3`,
and a persistent `service.lock` file. The OS releases the advisory lock on exit
or crash; do not unlink the lock file or kill processes based on its existence.
There is no startup cleanup or run recovery in this milestone.

## Protocol v1

First output, only after the lock and migrations succeed:

```json
{"type":"event","name":"ready","seq":1,"data":{"protocol_version":1,"app_version":"0.1.0","schema_version":1}}
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
Logs use stderr. Startup failures produce no ready event, an explanatory stderr
message, and exit code 2. The data directory being owned returns stderr `BUSY`.

EOF and SIGTERM close SQLite and release the lock. No shutdown command is added.
Electron should keep stdin open while its backend is needed; closing the window
must retain main/service. Explicit Quit closes stdin, waits up to 10 seconds,
then terminates only its owned process if necessary. Future workers and LLM
shutdown behavior are not implemented yet.

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

This is a local backend payload with PyInstaller ad hoc signing. Full `.app`/DMG
integration, GUI checks, a clean-machine installation, Developer ID signing, and
notarization remain outstanding; M0 as a whole is not complete.
