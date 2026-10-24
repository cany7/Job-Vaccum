# Backend service

Python 3.13 service, UTF-8 JSON Lines on stdin/stdout. Only Python owns
`app.sqlite3`. Migration 001 creates settings; migration 002 adds jobs,
identities, directions/queries, job directions and applications. Existing M0
settings survive migration. M2 adds retrieval and runs; M3 adds Custom HTTP
models and scoring (see below). Scheduling remains a later milestone.

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
Startup clears App-owned tmp resources and checks retention; automatic cleanup checks every 60 seconds while the service is running. Unfinished runs become interrupted; resume preserves stable task IDs.

## Protocol v1

First output, only after the lock and migrations succeed:

```json
{"type":"event","name":"ready","seq":1,"data":{"protocol_version":1,"app_version":"0.1.0","schema_version":4}}
```

Requests contain `type: "request"`, a string `id` (1–128 characters), a
nonempty string `method`, and optional object `params` (defaults to `{}`).
Unknown envelope fields are rejected. The 1 MiB line limit excludes LF.
Use a UTF-8 streaming decoder and buffer until LF; chunks can split Unicode
characters or contain multiple complete messages.

| Method | Params | Result |
| --- | --- | --- |
| `app.status` | `{}` | `{active_run:null, operations:[], cleanup:{status:"idle"}, configuration_complete:false, storage:{schema_version:4,journal_mode:"wal"}}` |
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

EOF and SIGTERM request a graceful stop, then close SQLite and release the lock. No shutdown command is added.
Electron should keep stdin open while its backend is needed; closing the window
must retain main/service. Explicit Quit closes stdin, waits up to 10 seconds,
then terminates only its owned process if necessary. CSV exports use a reader thread
and finish on EOF. EOF stops retrieval/model dispatch and cancels unsent model work;
in-flight model scores can finish and commit. The CLI also starts a 10-second
shutdown deadline for EOF, SIGTERM or receiver exit, so an unexpectedly lost
Electron owner cannot leave it waiting forever on a model thread. At the deadline
it kills/reaps its own multiprocessing children and exits without waiting for the
thread pool's interpreter-exit join. Unfinished runs become interrupted on the
next launch. Electron retains its process-group termination deadline as well.
Normal Stop does not use the quit deadline: already-sent scores may complete and
commit until the request succeeds or fails. App-owned tmp cleanup follows child
shutdown; a forced exit leaves remaining tmp cleanup to the next startup.

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
  overlapping known intervals. run_ids matches first-discovery pipeline batches.
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
  file cleanup failures after the database commit. Run retention is included;
  schedule retention remains M7.
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

## M2 retrieval and run API

Migration 003 adds runs, run_tasks and run_jobs without rebuilding jobs. The
service serializes settings patches, draft apply, run changes and each result
transaction. JobSpy runs in one owned spawn process at a time; only the service
writes business data. DataFrames stay in memory. No raw result files, pagination
checkpoints, manifest or content hashes are produced.

Settings now include stable cities, country_indeed, platforms, rules, rubric,
model metadata, proxy mode/address and auto_score_enabled (default true).
`drafts.get/save/apply` keep edited search/rubric drafts separate from settings.
Disable automatic scoring to run the complete M2 pipeline without a model.
When enabled, each new job and its score task are committed together. Score
tasks contain only job_id; they do not duplicate JD. M3 executes those tasks
alongside subsequent retrieval, and the run waits for scoring before finishing.

Named methods are `runs.preview/start/list/detail/stop/resume`. Start and resume
return `{run_id}` before retrieval. `run.updated`, `run.stats` and `jobs.changed`
notify clients to re-query; logs are never progress data. List defaults to
pipeline runs and returns started_at and surviving new_job_count. `run_ids`
filters only is_new=1 associations; empty means All, deleted IDs match no jobs,
and rescore IDs are rejected. Export shares those filters. Detail paginates
tasks using task_page/task_page_size and includes up to 200 surviving job links.
The full result list uses jobs.list, not the detail link sample.

Migration 004 adds a nullable `runs.trigger_json`. `runs.preview/start` accept
`direction_ids` (omitted or null = all enabled searches; unknown IDs are ignored,
an empty selection is a VALIDATION_ERROR). The snapshot keeps the chosen IDs and
summaries return `searches` (null or `[{id,name}]` from the snapshot) and
`trigger` (`{source:"manual"}` until schedules arrive in M7; null for older runs).

Default parameters are one retrieval worker, LinkedIn 10 / Indeed 100 results,
72 hours, a 600-second attempt timeout, three attempts with interruptible 5/10s
backoff. LinkedIn explicitly fetches descriptions; Indeed uses search-result JD.
The adapter reads attrs diagnostics before conversion, maps fields by name,
normalizes missing values without losing zero, and observes actual HTTP/429 in
its process only. Partial responses remain in memory across finite retries and
are committed as usable results even when the task ends failed. Zero results,
missing JD, warnings and failures have different counters/states.

A run snapshots full non-secret business settings and locked JobSpy SHA.
Tasks have stable UUIDs and query/city/platform order independent of display
order. Results immediately merge with both history and this run's previously
committed jobs. Earlier representatives and scores remain fixed; sources,
identities and surviving directions are added. Restart marks unfinished runs
interrupted; resume skips succeeded tasks and uses the original snapshot.
Cleanup defers during active runs and applies the same retention to runs/jobs/
logs. Deleting a run cannot remove retained job details or labels.

Ordinary proxy authentication is encrypted by Electron safeStorage and injected
through the private main/service `internal.credentials` message. Public settings
and snapshots accept only non-authenticated origins. off clears inherited proxy
environment in the worker; ordinary uses the same configured proxy on both
platforms. No Mihomo or real website tests are part of this step.

The old private reference path is unavailable on this machine. Configurable
filters and exact dedup regression cases follow the engineering documents; old
implementation parity remains unverified. Tests use public synthetic inputs and
FakeScraper success/zero/partial/failure/delay modes, with no private config or
network. Exact command/result/environment records live in DEVELOPMENT-STATUS.

## M3 Custom models and scoring

Four non-streaming `requests` adapters implement Chat Completions, Responses,
Anthropic Messages and Gemini generateContent. One shared pool applies concurrency
1 / RPM 10 to connection tests, scores and retries. Optional nulls are omitted;
zero temperature is sent. Provider bodies and exception text are never exposed
as errors. Tests use a loopback HTTP server and injected FakeLlm, without keys
or requests to real providers.

`jobs.score` fixes selected IDs or all FilterSpec matches in a rescore run.
Successful scores commit immediately; failed re-evaluations keep previous scores
and timestamps. Automatic scoring only queues new jobs. Stop cancels unsent work
and saves successful in-flight scores; resume skips committed successes.
`model.test` tests current or unsaved non-secret model settings; `operations.cancel`
cancels a test without applying late output. Electron owns safeStorage keys and
injects them privately, never through ordinary settings. See
[CONTRACTS](../../dev-docs/CONTRACTS.md#m3-后端协议与桌面桥接2026-10-19)
for named preload methods, events and frontend integration. This step does not
implement renderer controls or AI draft generation.

## M4 recovery verification

`tests/test_recovery.py` and its subprocess-only `recovery_peer.py` exercise hard
process exits before/after score registration, batch commits, score dispatch and
score commits. Fault injection uses test-side SQLite subclasses and synthetic
transports; it adds no production command, environment switch or recovery file.
Committed successful tasks retain their IDs and attempts. Every explicit resume
gives unfinished tasks another finite budget while preserving cumulative attempts
and the original business snapshot; only runtime credentials can be corrected.

The tests also cover simultaneous retrieval/scoring stop, new-run exclusion,
responsive reads/notes, exhausted budgets, hung workers/models, owner loss and tmp
deletion failure. Existing pipeline/scoring/LLM tests cover the remaining R-series
backend assertions. The actual Electron owner-crash check is
`../tests/electron-recovery-smoke.cjs`; exact invocation and verified results live
in DEVELOPMENT-STATUS. Scheduled-trigger assertions in R01/R16 remain M7, and M4
renderer controls are outside this backend delivery.

## M5 draft generation

`drafts.generate {kind:"search"|"rubric",input:{text,conditions?,clarification_answer?}}`
saves input before checking model prerequisites, then returns an operation ID.
Generation uses the same pool, rate gate and finite retry policy as scoring and
connection tests. On success, `drafts.generated {operation_id,draft_kind}` means
the validated draft is committed; read it with `drafts.get`. Errors use
`operation.failed`. Cancelling retains in-flight capacity until the HTTP request
ends and discards its output. User edits, Apply or a new generation cancel older
generation of the same kind so late results cannot overwrite the newer work.

`drafts.get/save/apply` also return `input`. Save accepts content and/or input,
allowing incomplete text to be saved independently. Inputs and editable content
use separate keys in the existing settings table, without a migration. Failure
and cancellation preserve both the input and previous content. Formal settings
only change on Apply; applying a rubric never enables automatic scoring.

The two built-in prompts live together in `src/job_vaccum/llm/drafts.py`. Search
output is validated structured JSON (one direction, two or three queries, cities,
or one short clarification); clarification drafts cannot be applied. Rubric
output is nonempty Markdown, without JSON wrapping or an enclosing code fence.
Explicit conditions reuse the existing qualification schema and default to saved
qualifications when omitted. No resume file parser or autonomous agent is added.

`tests/test_drafts.py` uses FakeLlm responses, temporary databases and the real
service loop. See the M5 section of [CONTRACTS](../../dev-docs/CONTRACTS.md) for
the complete API and [DEVELOPMENT-STATUS](../../dev-docs/DEVELOPMENT-STATUS.md) for
executed checks. Electron generate bindings/event types and the onboarding UI
are outside this Python-only delivery.

## M6 advanced parameters and Mihomo

Use `settings.save` with `run_mode: "advanced"` and an `advanced_parameters`
patch; omitted nested fields (including per-platform values) remain unchanged.
`proxy.mode` independently selects `off`, `ordinary`, or `mihomo`. Advanced
parameters work with proxy off. Default mode retains its fixed conservative
values. `runs.preview.parameters` reports effective values; every run and manual
rescore freezes those values, and Resume uses the original snapshot. See the
[M6 contract](../../dev-docs/CONTRACTS.md#m6-后端配置与执行2026-10-24)
for field names, defaults, validation, patch examples and M9 integration.

`pipeline/advanced.py` owns public configuration validation. `pipeline/retrieval.py`
coordinates platform/port concurrency outside SQLite, with service inbox events
for task state and atomic commits. `proxy/mihomo.py` reads explicit YAML nodes,
checks free loopback ports, creates private temporary groups/listeners, validates
with the supplied kernel, and starts only an App-owned instance. PyYAML is locked
in uv.lock; the JobSpy SHA and all pre-existing dependency versions are unchanged.
`proxy/pool.py` manages node reservations, actual IPv4 uniqueness, cooldown,
batch drain, bounded pressure rotation and port disable. Mihomo proxies LinkedIn
only; Indeed runs directly. Ordinary proxy applies to both platforms. There is
no implicit direct fallback after a pool error.

Supply an executable kernel and a local YAML file containing standalone concrete
`proxies` via `mihomo.executable_path/config_path`. The application does not read
subscriptions, import provider-only configurations, alter user files, connect to
an existing proxy client or change system proxy settings. Nodes depending on
user groups (`dialer-proxy`) and direct pseudo-nodes are rejected. Other original
configuration sections are not copied. Secret node fields exist only in memory
and the run's 0600 temporary config inside a 0700 directory. The random controller
secret never enters SQLite, snapshots or protocol output.

A dedicated owned process holds the kernel and watches its pipe to the service.
Normal close or service death closes the pipe, which terminates/reaps that kernel
and deletes its directory. No persisted PID scan is used. Electron's existing
process-group deadline covers forced Quit; App tmp left by a group hard kill is
cleared on the next locked startup. Stop waits for retrieval cleanup and already
sent score results. Closing the window retains the existing background schedule.

Mihomo's documented [HTTP listener fields](https://wiki.metacubex.one/en/config/inbound/listeners/)
and [controller API](https://wiki.metacubex.one/en/api/) define the generated
listener routes, Bearer authentication, proxy selection and delay probes.
`tests/test_mihomo.py` verifies the coordinator using fake controls/exits/clocks,
loopback HTTP, fake scraper/LLM and a spawned synthetic kernel. It does not verify
real Mihomo or public exit connectivity. Exact executed checks and outstanding
validation remain in DEVELOPMENT-STATUS. No React settings page or MCP tool is
included in this delivery.

After building the onedir backend, the optional frozen-process smoke check is:

```sh
uv run --locked python tests/mihomo_service_smoke.py ../dist/backend/job-vaccum-service/job-vaccum-service
```

It generates a temporary synthetic kernel/controller whose proxy always rejects
CONNECT locally. No public requests or real node credentials are used; success
requires the frozen service to start its owner/controller, report exit verification
failure without starting JobSpy, remove tmp resources and exit on EOF.
