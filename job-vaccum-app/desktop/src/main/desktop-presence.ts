import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function statusIcon(running: boolean): NativeImage {
  const size = 18, bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.hypot(x - 8.5, y - 8.5);
    if (distance < 6 && (running || distance > 4)) bitmap[(y * size + x) * 4 + 3] = 255;
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
  icon.setTemplateImage(true);
  return icon;
}

export function desktopPresence(dataDir: string, open: () => void, quit: () => void) {
  const file = path.join(dataDir, 'desktop-preferences.json');
  let enabled = true;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof saved.show_menu_bar_icon !== 'boolean') throw new Error('Invalid desktop preferences.');
    enabled = saved.show_menu_bar_icon;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let tray: Tray | undefined;
  let status = 'Idle', running = false;
  function render() {
    if (!enabled) { tray?.destroy(); tray = undefined; return; }
    if (!tray) tray = new Tray(statusIcon(running));
    else tray.setImage(statusIcon(running));
    tray.setToolTip(`Job Vaccum — ${status}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Job Vaccum', click: open }, { label: status, enabled: false },
      { type: 'separator' }, { label: 'Quit Job Vaccum', click: quit },
    ]));
  }
  render();
  return {
    get: () => ({ show_menu_bar_icon: enabled }),
    set(params: { show_menu_bar_icon: boolean }) {
      if (!params || Object.keys(params).length !== 1 || typeof params.show_menu_bar_icon !== 'boolean') {
        throw new Error('show_menu_bar_icon must be a boolean.');
      }
      writeFileSync(file, JSON.stringify(params) + '\n', { mode: 0o600 });
      enabled = params.show_menu_bar_icon;
      render();
      return this.get();
    },
    update(text: string, active: boolean) { status = text; running = active; render(); },
    windowOpened() { if (process.platform === 'darwin') app.setActivationPolicy('regular'); },
    windowClosed() { if (process.platform === 'darwin') app.setActivationPolicy('accessory'); },
    destroy() { tray?.destroy(); },
  };
}
