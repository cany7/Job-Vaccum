import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent } from "electron";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Backend } from "./backend";
import { registerBusinessIpc } from "./business-ipc";
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
const rendererPath = path.join(desktopRoot, "dist/renderer/index.html");

function assertSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || fileURLToPath(event.senderFrame.url) !== rendererPath) throw new Error("Untrusted IPC sender.");
}

function createWindow() {
  if (quitting) return;
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
  window.on("closed", () => { window = null; });
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
    if (quitting) return;
    quitting = true;
    void (backend?.stop() ?? Promise.resolve()).finally(() => { canQuit = true; app.quit(); });
  });
  // Terminal/development shutdown follows the same bounded owned-process path.
  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());
  void app.whenReady().then(() => {
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
    registerBusinessIpc(backend, () => window, assertSender, dataDir);
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
