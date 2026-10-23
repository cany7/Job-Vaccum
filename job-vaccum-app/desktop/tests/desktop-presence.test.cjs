const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const original = Module._load;
const trays = [];
let shown = 0, hidden = 0;
const electron = {
  app: { setActivationPolicy: policy => { if (policy === 'regular') shown++; else hidden++; } },
  Menu: { buildFromTemplate: items => items },
  nativeImage: { createFromBitmap: data => ({ data, setTemplateImage() {} }) },
  Tray: class {
    constructor(image) { this.image = image; trays.push(this); }
    setImage(image) { this.image = image; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  },
};
Module._load = function(name, ...args) { return name === 'electron' ? electron : original.call(this, name, ...args); };
const { desktopPresence } = require('../dist/electron/main/desktop-presence.js');
Module._load = original;

test('tray defaults, state/progress, menu actions, hidden persistence and Dock lifecycle', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jv-presence-'));
  let opened = 0, quit = 0;
  try {
    const presence = desktopPresence(dir, () => opened++, () => quit++);
    const tray = trays.at(-1), idle = tray.image.data;
    assert.equal(presence.get().show_menu_bar_icon, true);
    presence.update('Running · 3/8 tasks', true);
    assert.notDeepEqual(tray.image.data, idle);
    assert.equal(tray.menu[1].label, 'Running · 3/8 tasks');
    tray.menu[0].click(); tray.menu[3].click();
    assert.equal(opened, 1); assert.equal(quit, 1);
    presence.windowClosed(); presence.windowOpened();
    if (process.platform === 'darwin') { assert.equal(hidden, 1); assert.equal(shown, 1); }
    presence.set({ show_menu_bar_icon: false });
    assert.equal(tray.destroyed, true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'desktop-preferences.json'))), { show_menu_bar_icon: false });
    const length = trays.length;
    const next = desktopPresence(dir, () => {}, () => {});
    assert.equal(trays.length, length);
    assert.equal(next.get().show_menu_bar_icon, false);
    assert.throws(() => next.set({ show_menu_bar_icon: 'yes' }));
    next.set({ show_menu_bar_icon: true });
    assert.equal(trays.length, length + 1);
    next.destroy();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
