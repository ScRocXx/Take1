/**
 * Take1 desktop shell.
 *
 *  - Global hotkeys that work in any app (Ctrl+Alt+Space to give a command, etc.).
 *  - A Wispr-style floating pill: transparent, always on top, never steals focus,
 *    and excluded from screen capture (setContentProtection) so it never appears
 *    in your video, even when you record the whole screen.
 *  - A custom window/screen picker (desktopCapturer) behind getDisplayMedia.
 *  - backgroundThrottling off, so recording keeps full frame rate when hidden.
 */
const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, session, screen, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const DEV_URL = process.env.TAKE1_DEV_URL;
const DIST = path.join(__dirname, '..', 'dist');
const SETTINGS = () => path.join(app.getPath('userData'), 'shortcuts.json');

const DEFAULTS = {
  command: 'Ctrl+Alt+Space',
  record: 'Ctrl+Alt+R',
  cut: 'Ctrl+Alt+C',
  hold: 'Ctrl+Alt+H',
  mic: 'Ctrl+Alt+M',
  pill: 'Ctrl+Alt+T',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let main = null;
let pill = null;
let pendingSource = null;
let shortcuts = { ...DEFAULTS };

function loadShortcuts() {
  try {
    shortcuts = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) };
  } catch {
    shortcuts = { ...DEFAULTS };
  }
}

function send(name) {
  if (main && !main.isDestroyed()) main.webContents.send('hotkey', name);
}

function registerAll() {
  globalShortcut.unregisterAll();
  const ok = {};
  for (const [name, accel] of Object.entries(shortcuts)) {
    try {
      ok[name] = globalShortcut.register(accel, () => send(name));
    } catch {
      ok[name] = false;
    }
  }
  return ok;
}

function placePill() {
  if (!pill || pill.isDestroyed()) return;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = 560;
  const h = 320;
  pill.setBounds({ x: Math.round(d.x + (d.width - w) / 2), y: Math.round(d.y + d.height - h - 8), width: w, height: h });
}

function createMain() {
  main = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: 'Take1',
    backgroundColor: '#ffffeb',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  main.once('ready-to-show', () => main.show());

  // window.open('about:blank', 'take1-pill') from the renderer becomes the floating pill
  main.webContents.setWindowOpenHandler(({ frameName, url }) => {
    if (frameName === 'take1-pill') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560,
          height: 320,
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          focusable: false,
          hasShadow: false,
          alwaysOnTop: true,
          show: false,
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  main.webContents.on('did-create-window', (win, details) => {
    if (details.frameName !== 'take1-pill') return;
    pill = win;
    pill.setAlwaysOnTop(true, 'screen-saver');
    pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    pill.setContentProtection(true); // invisible to screen capture
    pill.setIgnoreMouseEvents(true, { forward: true });
    placePill();
    pill.showInactive();
    pill.on('closed', () => (pill = null));
  });

  main.on('closed', () => {
    main = null;
    if (pill && !pill.isDestroyed()) pill.close();
  });

  if (DEV_URL) main.loadURL(DEV_URL);
  else main.loadURL('app://take1/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    let file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });

  // our picker chooses the source; this hands it to getDisplayMedia
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
      const src = sources.find((s) => s.id === pendingSource) || sources.find((s) => s.id.startsWith('screen:'));
      callback(src ? { video: src } : {});
    } catch {
      callback({});
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen'].includes(permission));
  });

  loadShortcuts();
  createMain();
  registerAll();

  ipcMain.handle('shortcuts:get', () => shortcuts);
  ipcMain.handle('shortcuts:set', (_e, map) => {
    shortcuts = { ...DEFAULTS, ...map };
    try {
      fs.writeFileSync(SETTINGS(), JSON.stringify(shortcuts, null, 2));
    } catch {
      /* read-only profile */
    }
    return registerAll();
  });

  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: true });
    return sources
      .filter((s) => !/^take1/i.test(s.name))
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      }));
  });
  ipcMain.handle('sources:choose', (_e, id) => {
    pendingSource = id;
  });

  // Esc is only grabbed while a command session is open
  ipcMain.on('listening', (_e, on) => {
    if (on) {
      if (!globalShortcut.isRegistered('Escape')) globalShortcut.register('Escape', () => send('cancel'));
    } else if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
  });

  ipcMain.on('pill:interactive', (_e, on) => {
    if (pill && !pill.isDestroyed()) pill.setIgnoreMouseEvents(!on, { forward: true });
  });
  ipcMain.on('pill:visible', (_e, on) => {
    if (!pill || pill.isDestroyed()) return;
    if (on) {
      placePill();
      pill.showInactive();
    } else pill.hide();
  });
  ipcMain.on('main:show', () => {
    if (!main) return createMain();
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  });
  ipcMain.on('main:hide', () => main && main.minimize());

  app.on('activate', () => {
    if (!main) createMain();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
