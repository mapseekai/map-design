import { app, BrowserWindow } from 'electron';
import { registerMapDesignProtocol } from '../../../apps/packaged/src/protocol.ts';

void app.whenReady().then(async () => {
  registerMapDesignProtocol(() => process.env.MAP_DESIGN_PROTOCOL_TEST_URL);
  const window = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('map-design://app/');
});
