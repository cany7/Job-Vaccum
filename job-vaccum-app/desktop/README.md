# Desktop

The minimal English window connects to the real Python service. It displays the
connection/handshake, idle status, a Unicode ping and offline dependency/SQLite
diagnostics. The M1 data service and named bridge are available, but the renderer still shows the M0 interface; business pages are a separate step. Scraping, scoring and scheduling remain later milestones. Closing the window keeps main/service running; use the Dock or
**Job Vaccum → Show Job Vaccum** to reopen. **Quit / Cmd+Q** closes backend stdin,
waits 10 seconds, then terminates only its owned backend if necessary.

## Develop

Prepare the declared Python 3.13.12 environment using `backend/README.md`, then
from this directory:

```sh
npm ci
npm run dev
```

`dev` typechecks, builds and opens Electron. Re-run after editing; M0 does not run
a hot-reload server. `npm start` opens the existing build. Development data lives
in the repository's ignored `tmp/job-vaccum-app/desktop`; packaged builds use
Electron userData (`~/Library/Application Support/Job Vaccum` on this Mac).
The optional main-process `--data-dir=/absolute/path` argument isolates local
integration tests; the renderer cannot choose paths or executables.

The sandboxed renderer gets the named `JobVaccumApi` methods declared in
`src/shared/api.ts` and `src/shared/business.ts` through `window.jobVaccum`. It has no
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

The 9 Node tests use a synthetic process for fragmented Unicode/multiple
responses, request correlation, incompatible/missing ready, malformed/oversized
output, startup/exit failures, late responses, and shutdown. The 7 Playwright
Electron scenarios run real windows and the backend: ping/diagnostics, minimum
window width/long text/focus/reduced-motion, single instance, close/reopen, Quit,
corrupt database startup, and backend crash. One scenario injects controlled
connection/loading/error responses at the Electron boundary for UI verification;
the other service interactions are real and offline. The M1 scenario calls the named bridge to import public fixtures, edit/undo applications, export all 125 jobs, validate destination tokens and verify persistence after restart. Only the native save panel/Finder boundaries are mocked. Two regression scenarios
also cover resolved CSV paths (including symlinks and retargeted tokens) and
200 applications with 6 KB notes, controlled oversized responses, connection
continuity and preserved Undo data. No browser download needed.
Screenshots and data go to ignored `tmp/job-vaccum-app/`.

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
return their full result are rolled back before commit. No renderer business
call or UI control has been added in M1 step 2.

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
