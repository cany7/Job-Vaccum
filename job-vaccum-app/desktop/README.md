# Desktop

The English App shell connects to the real Python service: a hidden-inset title
bar with a 48px top bar (native traffic lights, sidebar toggle ⌃⌘S, page name,
current search, match count and the page's actions), a sidebar that collapses to
a 52px rail (automatically below 1100px wide; a manual collapse is remembered),
and a rounded content card.

Jobs and Shortlist share one table: one line per job, click a header to sort,
drag header edges to resize, Columns ▾ (or right-click a header) to show or hide
columns, sideways scrolling when columns are wider than the card. The filter row
holds the selection box (select page / clear, ▾ select by condition), "N
selected", removable filter chips, + Filter, Clear all, the page range (50/100/200
rows, first/last page) and Columns. Details open beside the list, or float over
it below 1100px; the JD is rendered from Markdown with raw HTML disabled, and
links open in the default browser. Jobs adds selected jobs to the Shortlist;
Shortlist edits status (row, details or Set status ▾ for the selection) and notes
(double-click/Return in the table, a text area in details) and removes without a
confirmation. Batch status and removal toasts offer Undo (⌘Z). Export opens a
dialog (range: current filter across all pages or all jobs; optional full JD).
The sidebar search (⌘F, a pop-out field in the rail) and the Searches list (a
hover list in the rail) filter the current page. Keyboard: ↑↓/J K move, Return
opens details (Shortlist: edits notes), Esc closes, X selects, S adds, O opens the
posting, ? lists shortcuts. Loading shows skeleton rows after 0.5 s; a failed
request shows a banner with Try again; "No jobs yet" and "No jobs match these
filters" (with Clear filters) are separate empty states.

Settings has Searches (rename with Save, drag or ⌥↑/⌥↓ to reorder, delete with a
confirmation), Data (retention days with a preview of the next automatic cleanup,
Clear job data with a confirmation), Appearance (System/Light/Dark mode, separate
light and dark themes from Graphite/Pine/Ink) and About (version, backend, data
folder with Show in Finder, database, offline diagnostics; Ping only in
development builds). Startup failure is a whole-window page with the data folder
and Quit; a backend that exits later blocks the shell and offers only Quit.
Appearance, sidebar state and each page's filters, sort, rows per page and
columns are local UI preferences in renderer storage, not service data; the page
number and selection last only for the session.
Closing the window keeps main/service running; use the Dock or
**Job Vaccum → Show Job Vaccum** to reopen. **Quit / Cmd+Q** closes backend stdin,
waits 10 seconds, then terminates only its owned backend if necessary.

## Develop

Prepare the declared Python 3.13.12 environment using `backend/README.md`, then
from this directory:

```sh
npm ci
npm run dev
```

`dev` typechecks, builds and opens Electron. Re-run after editing; there is no
hot-reload server. `npm start` opens the existing build. Development data lives
in the repository's ignored `tmp/job-vaccum-app/desktop`; packaged builds use
Electron userData (`~/Library/Application Support/Job Vaccum` on this Mac).
The optional main-process `--data-dir=/absolute/path` argument isolates local
integration tests; the renderer cannot choose paths or executables.

The sandboxed renderer gets the named `JobVaccumApi` methods declared in
`src/shared/api.ts` and `src/shared/business.ts` through `window.jobVaccum`.
Desktop methods include getAppInfo (version, arch, packaged and display data
path), quit (bounded shutdown), showDataFolder (no path parameter) and openLink
(http/https only, opened by main in the default browser). It has no
Node, shell, database or generic IPC/request API. Main starts one backend by
absolute path, buffers UTF-8 JSON Lines, checks protocol v1 before dispatch,
matches request ids and settles timed-out/exited requests without replay or
automatic restart. Python validates command arguments. Startup errors require
fixing the problem, then quitting/reopening; crash errors retain the last status.

## Tests

```sh
npm test
npm run test:e2e
```

`npm run test:e2e:smoke` runs the five existing core integration tests tagged
`@smoke`, including real backend startup, Jobs-to-Shortlist interaction,
persistence/export, M2 queries and backend-crash handling. The full suite above
still includes these tests. GitHub PR checks use this smaller set; see
[CI setup and automatic merging](../../.github/CI.md).

The 9 Node tests use a synthetic process for fragmented Unicode/multiple
responses, request correlation, incompatible/missing ready, malformed/oversized
output, startup/exit failures, late responses, and shutdown.

The 17 Playwright Electron scenarios run real windows and the backend.
`desktop.spec.cjs` (10) covers the shell and window options, About
status/diagnostics/ping, single instance, close/reopen, Quit; sidebar collapse
across restarts and narrow-window auto-collapse; mode/theme switching,
independence and persistence, increased contrast; 640px width, keyboard focus
and reduced motion; corrupt database startup page; backend crash blocking with
Quit; controlled connection/loading/error states; and the M1 named bridge (CSV
destination tokens, symlinked destinations, oversized responses).
`lists.spec.cjs` (7) covers the list UI: paging, sorting (empty scores last),
selection by box/condition/Shift range and clearing on page changes, adding with
per-item feedback, keyboard review; per-page filters, chips, Clear all, search,
Searches, persistence, the rail search and Searches pop-outs, dropping a deleted
search's filter; Shortlist status/notes, batch status with ⌘Z Undo, removal with
Undo and Undo after cleanup; export dialog and file, Settings Searches/Data and
their confirmations; columns, resizing, sideways scrolling, narrow details, 640px,
toast timing; request failure banner, skeleton rows, Markdown safety and
external links; and all six theme/scheme combinations with a 4.5:1 contrast check
of text, status and score colors.

The list scenarios seed public synthetic fixtures by running the development
backend (`--enable-dev-commands`) on the test data folder before the App starts,
so they also run against an installed copy. Only the native save panel, Finder
and default browser are stand-ins, plus injected list/detail responses for the
failure and Markdown scenarios. No browser download needed. Validation results
and remaining checks are maintained in the local
`dev-docs/DEVELOPMENT-STATUS.md`. Screenshots and data go to ignored
`tmp/job-vaccum-app/`.

## M1 bridge integration

Each data command has an explicit preload method (listJobs/getJobDetail,
application, direction/query, retention and cleanup methods). There is no generic
method or SQL IPC. Main checks every sender against the current main frame.
Development main enables synthetic import; packaged main and frozen Python reject
it. See the backend README for command semantics and limits.

CSV flow: chooseCsvDestination opens the native save panel and returns an opaque
in-memory token (or null on cancellation). exportCsv consumes that token once;
main alone resolves it to a service destination_path. Both the userData root
and destination are checked using their actual resolved paths (new filenames use
the resolved parent directory). Main rechecks before export, and Python checks
again before opening. File/parent symlinks into App data are rejected to avoid
database overwrite and cleanup conflicts. onServiceEvent reports
operation completion/failure. showCsvInFinder accepts only a token for a completed
export from this session. Closing/reopening a window retains main/service state.
Oversized business responses return RESPONSE_TOO_LARGE without dropping the
connection. Reduce page size/selection; update/remove transactions that cannot
return their full result are rolled back before commit. The renderer counts its own
successful changes so their jobs.changed events refresh both pages quietly;
other changes (automatic cleanup) show "Results updated · Refresh".

## Local arm64 package

On the configured Apple Silicon Mac:

```sh
npm run package:mac
```

This builds renderer/main/preload, the full PyInstaller onedir backend, then
electron-builder's `.app` and DMG. No system Python or uv is used at runtime.
The build needs the locked backend development environment and network access
for tool downloads on first use. `npm run package:dir` builds just the `.app`.
Outputs:

- `../release/mac-arm64/Job Vaccum.app`
- `../release/Job-Vaccum-0.1.0-arm64.dmg`

Mount the DMG and copy the App to a local folder. The installed copy can run the
same tests without rebuilding (substitute its absolute executable path):

```sh
JV_EXECUTABLE="/absolute/install/Job Vaccum.app/Contents/MacOS/Job Vaccum" npx --no-install playwright test
```

M0 validated macOS 27.0.1 arm64, including a DMG-installed copy in a path with
spaces, cwd `/`, PATH `/usr/bin:/bin`, with backend `.venv`, backend/desktop
source and desktop build directories temporarily unavailable. The App declares
minimum macOS 15.6 because the bundled Python requires it; other releases and a
second physical Mac are untested. This is a local unsigned test build with the
default Electron icon, no Developer ID signing or notarization. Public release,
license inventory and final distribution checks belong to M7.

## M2 backend bridge (renderer unchanged)

The named preload API adds getDraft/saveDraft/applyDraft, previewRun/startRun,
listRuns/getRunDetail/stopRun/resumeRun, setProxyCredential/deleteProxyCredential.
Shared runs.ts defines settings patches, snapshots, task diagnostics and run
progress. The Python schema is now 3. run.updated/run.stats pass through
onServiceEvent; the next renderer step should refresh run data from those events
and jobs.changed, without reading stderr. run_ids now filters first-discovery
pipeline batches; runs.list defaults to pipeline and includes started_at and
new_job_count for batch choices. Use runs.detail for paged tasks and directions.

Proxy credentials pass only through main's named local credential methods,
are stored using safeStorage in proxy-credentials.enc, and are privately injected
before preview/start/resume and settings reads. The renderer receives availability,
not the saved URL. Settings/snapshots store only an unauthenticated proxy origin.
Unavailable encryption returns AUTH_ERROR; there is no plaintext fallback.
The backend has its own process group; bounded shutdown or a service crash also
terminates that group's owned scrape children. There is no service auto-restart.

This step does not add Runs, batch filter controls, manual search settings or
scoring UI to the renderer. Scoring execution remains M3; auto_score_enabled=false
allows retrieval to finish without a model. Tests use synthetic data only.

## M8 local MCP

Electron main starts an authenticated, stateless Streamable HTTP endpoint at
`http://127.0.0.1:<port>/mcp`. It uses the official TypeScript MCP SDK and the
same credential-aware business caller as IPC, then the existing Python service
and SQLite. Closing the window leaves MCP available; explicit Quit closes the
HTTP listener/connections and stops the owned backend. No separate daemon runs.

On first launch, main creates `mcp.json` in the current App data directory with
`{port,token}` and mode 0600. It generates a random 256-bit token and saves the
OS-assigned port for subsequent launches. To change the port/token, Quit first,
edit this local file, then reopen. Port 0 requests a new assigned port; conflicts
or invalid configuration show an error without an automatic fallback. Never
commit the file or paste its token into logs. This credential is separate from
model/proxy credentials and is not included in tool results or snapshots.

Native clients send `Authorization: Bearer <token>`. Host must exactly match
`127.0.0.1:<port>` or `localhost:<port>`. Origin may be absent; if supplied it must
be exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`. Other Hosts or
Origins receive 403; missing/wrong tokens receive 401. The listener binds only
IPv4 loopback. Authenticated GET/DELETE return 405 (no SSE session is needed).

The 15 tools are:

- `list_jobs`, `list_shortlist`, `get_job`
- `add_to_shortlist`, `create_shortlist_job`, `update_shortlist_job`, `set_shortlist_status`
- `list_searches`, `list_schedules`, `get_schedule`, `update_schedule`, `preview_run`
- `list_runs`, `get_run`, `get_app_status`

Lists use flat FilterSpec parameters; scope is fixed by the tool. Summary pages
have 50 rows by default/maximum; `view:"ids"` defaults/maxes at 200. Returned
`page`, `page_size`, `total`, `has_more` describe one page. Reasons and notes are
complete; JD, links and other detail fields are available only through get_job.
Run summaries default/max at 50 and include both pipeline/rescore unless filtered.
Tools return one JSON text payload, without a duplicate structuredContent copy.
There is no server token budgeter, text truncation or automatic pagination.

For bulk work, first collect **every page of IDs**, then write batches of at most
200 IDs. In particular, do not interleave writes with pagination using
`in_applications:false`: writes shrink that result set. A failed later batch
leaves earlier committed batches intact. Writes are not automatically replayed.

### Connect a protocol client

Start the App, then run this from `job-vaccum-app/desktop` for development data:

```sh
node scripts/mcp-client.mjs "$(git rev-parse --show-toplevel)/tmp/job-vaccum-app/desktop"
```

For an installed App, pass its actual absolute userData path instead. The script
uses the official SDK client, initializes MCP, lists the tools and reads one ID
page. It reads the token locally and does not print it. It does not mutate data.

### Codex and Claude examples

These are opt-in connection commands, not actions performed by the application.
From the desktop directory, load the endpoint and token into the current shell:

```sh
export JV_MCP_CONFIG="$(git rev-parse --show-toplevel)/tmp/job-vaccum-app/desktop/mcp.json"
export JV_MCP_URL="$(node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.env.JV_MCP_CONFIG,"utf8"));process.stdout.write(`http://127.0.0.1:${c.port}/mcp`)')"
export JV_MCP_TOKEN="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.env.JV_MCP_CONFIG,"utf8")).token)')"
```

Change JV_MCP_CONFIG to the installed App's config when appropriate. Start the
client from an environment that contains JV_MCP_TOKEN; a desktop application
already running from Finder does not inherit a later terminal export.

Codex supports Streamable HTTP URLs and a bearer-token environment variable:

```sh
codex mcp add job-vaccum --url "$JV_MCP_URL" --bearer-token-env-var JV_MCP_TOKEN
codex
```

The equivalent config is `[mcp_servers.job-vaccum]`, `url` set to the printed
endpoint (not the token), and `bearer_token_env_var = "JV_MCP_TOKEN"`.
See [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Claude Code supports an HTTP transport and environment references in headers:

```sh
claude mcp add --scope user --transport http job-vaccum "$JV_MCP_URL" \
  --header 'Authorization: Bearer ${JV_MCP_TOKEN}'
claude
```

The single quotes intentionally preserve the environment reference rather than
writing the token into configuration. See [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).
The endpoint is local to the computer running the App; these examples require a
local client, not a cloud-hosted connector. No user Skills need to change.

### Integration checks

```sh
npm run build
npx --no-install playwright test tests/e2e/mcp.spec.cjs
```

This uses the real SDK Client → production Electron main MCP/IPC → real Python
CLI/service → SQLite. Test-only `tests/fixtures/mcp-main.cjs` injects
`backend/tests/mcp_peer.py`, which substitutes existing FakeScraper/FakeLlm for
network I/O; tool responses are not mocked. It covers all 15 tools, cross-page
405-ID batching, filter/sort totals, full long text, manual jobs, partial schedule
updates, live/completed runs, rescore, event forwarding, no-window writes,
restart, cleanup, Quit, token/Host/Origin rejection and backend loss. The test
fixture cannot be selected by renderer or MCP and is outside packaged files.
Actual commands/results and outstanding package/M6 validation live in
[DEVELOPMENT-STATUS](../../dev-docs/DEVELOPMENT-STATUS.md).
