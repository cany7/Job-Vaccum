import { app, BrowserWindow, dialog, powerMonitor, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent } from "electron";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Backend } from "./backend";
import { registerBusinessIpc } from "./business-ipc";
import { ScheduleClock } from './schedule-clock';
import { desktopPresence } from './desktop-presence';
import type { AppStatus, ServiceEvent } from '../shared/api';
import { channels } from "../shared/protocol";

app.setName("Job Vaccum");
const desktopRoot = path.resolve(__dirname, "../../..");
// The override is a local integration-test argument, never a renderer capability.
const dataArgument = process.argv.find((arg) => arg.startsWith("--data-dir="))?.slice(11);
const dataDir = dataArgument ? path.resolve(dataArgument)
  : app.isPackaged ? app.getPath("userData") : path.resolve(desktopRoot, "../../tmp/job-vaccum-app/desktop");
app.setPath("userData", dataDir);

let window: BrowserWindow | null = null;
let backend: Backend | undefined;
let quitting = false;
let canQuit = false;
let confirmingQuit = false;
let forceQuit = false;
let clock: ScheduleClock | undefined;
let presence: ReturnType<typeof desktopPresence> | undefined;
let activeRun: string | null = null;
let stoppingRun = false;

const rendererPath = path.join(desktopRoot, "dist/renderer/index.html");

function finishQuit() {
  if (quitting) return;
  quitting = true;
  clock?.stop();
  void (backend?.stop() ?? Promise.resolve()).finally(() => {
    presence?.destroy();
    canQuit = true;
    app.quit();
  });
}

function assertSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || fileURLToPath(event.senderFrame.url) !== rendererPath) throw new Error("Untrusted IPC sender.");
}

function createWindow() {
  if (quitting) return;
  presence?.windowOpened();
  if (window) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    title: "Job Vaccum", width: 1280, height: 800, minWidth: 640, minHeight: 480,
    // The renderer draws a 48px top bar; the native traffic lights sit centered in it.
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 17 },
    show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1d" : "#ececea",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => { window = null; presence?.windowClosed(); });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  void window.loadFile(rendererPath).catch(() => {
    console.error("Could not load the application interface.");
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createWindow());
  app.on("activate", () => { if (app.isReady()) createWindow(); });
  // Closing the renderer keeps the main process and its service alive on macOS.
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (canQuit) return;
    event.preventDefault();
    if (forceQuit) { finishQuit(); return; }
    if (quitting || confirmingQuit) return;
    confirmingQuit = true;
    void (async () => {
      clock?.suspend();
      const status = await backend?.request<AppStatus>('app.status');
      if (quitting) return;
      if (!forceQuit && status?.ok && status.result.active_run) {
        void clock?.resume(false);
        const result = await dialog.showMessageBox({
          type: 'warning', title: 'Quit Job Vaccum?',
          message: 'A run is in progress. Quitting stops it; finished tasks are kept and you can resume later.',
          buttons: ['Cancel', 'Quit Job Vaccum'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (result.response !== 1 && !forceQuit) return;
      }
      finishQuit();
    })().finally(() => { confirmingQuit = false; });
  });
  void app.whenReady().then(() => {
    // Register after Chromium startup, which otherwise replaces native signal handlers.
    process.on("SIGTERM", () => { forceQuit = true; finishQuit(); });
    process.on("SIGINT", () => { forceQuit = true; finishQuit(); });
    mkdirSync(dataDir, { recursive: true });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const executable = app.isPackaged
      ? path.join(process.resourcesPath, "backend/job-vaccum-service/job-vaccum-service")
      : path.resolve(desktopRoot, "../backend/.venv/bin/python");
    backend = new Backend({ executable, args: app.isPackaged ? [] : ["-m", "job_vaccum", "--enable-dev-commands"], dataDir });
    backend.on("state", (state) => window?.webContents.send(channels.connectionChanged, state));
    for (const [channel, method] of [
      [channels.connection, null], [channels.status, "app.status"],
      [channels.ping, "app.ping"], [channels.diagnostics, "app.diagnostics"],
    ] as const) {
      ipcMain.handle(channel, (event, message?: unknown) => {
        assertSender(event);
        return method === null ? backend!.state : backend!.request(method, method === "app.ping" ? { message } : {});
      });
    }
    const prepareBackground = registerBusinessIpc(backend, () => window, assertSender, dataDir);
    presence = desktopPresence(dataDir, createWindow, () => app.quit());
    ipcMain.handle('desktop:get-preferences', (event) => { assertSender(event); return presence!.get(); });
    ipcMain.handle('desktop:set-preferences', (event, params) => { assertSender(event); return presence!.set(params); });
    const scheduleError = (message: string) => {
      clock?.stop();
      presence?.update('Schedules unavailable', false);
      void dialog.showMessageBox({ type: 'error', message: 'Scheduled runs stopped. Quit and reopen after fixing the problem.', detail: message });
    };
    clock = new ScheduleClock(
      reason => backend!.request('internal.schedules_check', reason ? { reason } : {}), scheduleError);
    backend.on('state', (state) => {
      if (state.phase === 'ready') void prepareBackground().then(() => clock!.start()).catch((error: Error) => scheduleError(error.message));
      else if (state.phase === 'failed' || state.phase === 'exited') {
        clock?.stop(); presence?.update('Backend unavailable', false);
      }
    });
    powerMonitor.on('suspend', () => clock?.suspend());
    powerMonitor.on('resume', () => { void clock?.resume(); });
    backend.on('service-event', (event: ServiceEvent) => {
      if (event.name === 'run.updated') {
        const running = ['running', 'stopping'].includes(event.data.status);
        activeRun = running ? event.data.run_id : null;
        stoppingRun = event.data.status === 'stopping';
        presence?.update(running ? (event.data.status === 'stopping' ? 'Stopping…' : 'Running') : 'Idle', running);
      } else if (event.name === 'run.stats' && activeRun === event.data.run_id) {
        const stats = event.data;
        const completed = stats.retrieval.succeeded + stats.retrieval.failed + stats.scoring.succeeded + stats.scoring.failed;
        presence?.update(`${stoppingRun ? 'Stopping…' : 'Running'} · ${completed}/${stats.retrieval.total + stats.scoring.total} tasks`, true);
      }
    });
    const home = homedir();
    const shownDataDir = dataDir === home || dataDir.startsWith(home + path.sep) ? "~" + dataDir.slice(home.length) : dataDir;
    ipcMain.handle(channels.appInfo, (event) => {
      assertSender(event);
      return { version: app.getVersion(), arch: process.arch, packaged: app.isPackaged, data_dir: shownDataDir };
    });
    ipcMain.handle(channels.quit, (event) => { assertSender(event); app.quit(); });
    ipcMain.handle(channels.showDataFolder, (event) => { assertSender(event); shell.showItemInFolder(dataDir); });
    // Job postings and JD links open in the default browser; only web links are allowed.
    ipcMain.handle(channels.openLink, (event, url: unknown) => {
      assertSender(event);
      const parsed = typeof url === "string" && URL.canParse(url) ? new URL(url) : null;
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) throw new Error("Only web links can be opened.");
      return shell.openExternal(parsed.href);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Job Vaccum", submenu: [{ role: "about" }, { type: "separator" },
        { label: "Show Job Vaccum", click: createWindow }, { role: "hide" }, { role: "hideOthers" },
        { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" }, { role: "windowMenu" },
    ]));
    createWindow();
  }).catch(() => {
    console.error("Could not initialize the application data directory or desktop process.");
    app.quit();
  });
}
