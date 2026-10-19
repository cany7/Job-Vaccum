# Desktop

The English App shell connects to the real Python service: a hidden-inset title
bar with a 48px top bar (native traffic lights, sidebar toggle ⌃⌘S, page name),
a sidebar that collapses to a 52px rail (automatically below 1100px wide; a manual
collapse is remembered), and a rounded content card. Jobs and Shortlist show their
empty states until the M1 list step; the sidebar search is a disabled placeholder
until then. Settings has Appearance (System/Light/Dark mode, separate light and
dark themes from Graphite/Pine/Ink) and About (version, backend, data folder with
Show in Finder, database, offline diagnostics; Ping only in development builds).
Startup failure is a whole-window page with the data folder and Quit; a backend
that exits later blocks the shell and offers only Quit. Appearance and sidebar
state are local UI preferences in renderer storage, not service data.
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
a hot-reload server. `npm start` opens the existing build. Development data lives
in the repository's ignored `tmp/job-vaccum-app/desktop`; packaged builds use
Electron userData (`~/Library/Application Support/Job Vaccum` on this Mac).
The optional main-process `--data-dir=/absolute/path` argument isolates local
integration tests; the renderer cannot choose paths or executables.

The sandboxed renderer gets only `getConnection`, `onConnectionChange`,
`getStatus`, `ping`, `getDiagnostics`, `getAppInfo` (version, arch, packaged,
display data path), `quit` (normal bounded shutdown) and `showDataFolder`
(reveals this App's data directory; takes no path) through `window.jobVaccum`. It has no
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
Electron scenarios run real windows and the backend: shell and window options,
About status/diagnostics/ping, single instance, close/reopen, Quit; sidebar
collapse across restarts and narrow-window auto-collapse; mode/theme switching,
independence and persistence, increased contrast; 640px width without page
overflow, keyboard focus and reduced motion; corrupt database startup page and its
Quit; backend crash blocking with Quit. One scenario injects controlled
connection/loading/error responses at the Electron boundary for UI verification;
the other service interactions are real and offline. No browser download needed.
Screenshots and data go to ignored `tmp/job-vaccum-app/`.

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
