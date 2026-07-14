import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllIpcHandlers } from './ipc.js';
import { AgentScriptToolService } from './agent-script-tool.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../frontend-dist/index.html'));
  }
}

app.whenReady().then(() => {
  const mediaRoot = path.join(app.getPath('userData'), 'media');
  const scriptService = new AgentScriptToolService(
    path.join(mediaRoot, 'agent-outputs'),
  );

  registerAllIpcHandlers({ mediaRoot, scriptService });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
