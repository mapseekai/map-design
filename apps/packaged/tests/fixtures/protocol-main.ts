import { app, BrowserWindow } from 'electron';
import { registerMapDesignProtocol } from '../../src/protocol.js';

void app.whenReady().then(async () => {
  registerMapDesignProtocol(() => process.env.MAP_DESIGN_PROTOCOL_TEST_URL ?? null);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('map-design://app/');
});
