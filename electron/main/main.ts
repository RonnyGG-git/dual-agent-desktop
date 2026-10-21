import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../shared/types';
import { dataDir, subDir } from '../services/paths';
import { AppController } from './controller';

// Una sola instancia: dos ventanas orquestando el mismo workspace provocarían escrituras simultáneas.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | null = null;
  let controller: AppController;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    controller = new AppController(app.getAppPath(), process.execPath);
    controller.startup();
    registerIpc(controller, () => win);

    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 640,
      backgroundColor: '#16171a',
      title: 'Dual Agent Desktop',
      icon: path.join(app.getAppPath(), 'resources', 'icon.png'),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // En pantallas bajas (portátiles con escalado) la ventana se abre maximizada para que quepan los paneles.
    const area = screen.getPrimaryDisplay().workAreaSize;
    win.once('ready-to-show', () => {
      if (area.height < 900) win?.maximize();
      win?.show();
    });

    // La interfaz no navega a ningún sitio externo ni abre ventanas nuevas.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) win.loadURL(devUrl);
    else win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));

    controller.subscribe((snap) => win?.webContents.send('dad:snapshot', snap));
    const envCheck = controller.checkEnvironment();

    // Modo de verificación (prueba de humo): captura la ventana real tras las
    // comprobaciones de arranque, vuelca el estado y cierra.
    const shot = process.env.DAD_SCREENSHOT;
    if (shot) {
      void envCheck.then(async () => {
        await new Promise((r) => setTimeout(r, 1500));
        const img = await win!.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
        fs.writeFileSync(`${shot}.json`, JSON.stringify(controller.snapshot(), null, 2));
        app.quit();
      });
    }
  });

  app.on('before-quit', () => controller?.shutdown());
  app.on('window-all-closed', () => app.quit());
}

function registerIpc(c: AppController, getWin: () => BrowserWindow | null) {
  // Solo se aceptan mensajes del propio renderer de la ventana principal.
  const guard = (e: Electron.IpcMainInvokeEvent) => {
    if (e.sender !== getWin()?.webContents) throw new Error('Origen IPC no autorizado');
  };
  ipcMain.handle('dad:getSnapshot', (e) => (guard(e), c.snapshot()));
  ipcMain.handle('dad:submit', (e, instruction: unknown) => {
    guard(e);
    if (typeof instruction !== 'string') return { ok: false, error: 'Instrucción inválida' };
    return c.submit(instruction);
  });
  ipcMain.handle('dad:cancel', (e) => (guard(e), c.cancel()));
  ipcMain.handle('dad:refreshEnvironment', (e) => (guard(e), c.checkEnvironment()));
  ipcMain.handle('dad:listHistory', (e) => (guard(e), c.history.list()));
  ipcMain.handle('dad:getTask', (e, id: unknown) => (guard(e), typeof id === 'string' ? c.history.get(id) : null));
  ipcMain.handle('dad:updateSettings', (e, patch: unknown) => {
    guard(e);
    if (!patch || typeof patch !== 'object') throw new Error('Configuración inválida');
    const allowed: (keyof Settings)[] = ['maxAttempts', 'requireTests', 'claudeModel', 'opencodeModel', 'extraWritablePaths', 'timeouts'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k as keyof Settings)));
    return c.updateSettings(clean as Partial<Settings>);
  });
  ipcMain.handle('dad:openPath', (e, target: unknown) => {
    guard(e);
    const map: Record<string, string> = { workspace: c.config.get().workspace, data: dataDir(), backups: subDir('backups') };
    if (typeof target === 'string' && map[target]) return shell.openPath(map[target]);
  });
}
