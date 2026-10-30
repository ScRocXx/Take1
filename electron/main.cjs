/**
 * Take1 desktop shell.
 *
 *  - Hold-to-talk from any app (Ctrl+Shift by default, via a low-level keyboard hook),
 *    plus global shortcuts (Ctrl+Alt+R record, Ctrl+Alt+C cut, ...).
 *  - A slim floating bar on the edge of the screen (you drag it where you want it):
 *    transparent, always on top, never steals focus, and excluded from screen
 *    capture (setContentProtection) so it never appears in your video.
 *  - A click-through overlay across the whole screen for command animations, the
 *    replay after "cut" and the 3-2-1 countdown, also excluded from capture.
 *  - Google sign-in for YouTube / Drive uploads through the system browser
 *    (loopback redirect + PKCE), with the refresh token encrypted by the OS.
 *  - A custom window/screen picker (desktopCapturer) behind getDisplayMedia.
 *  - backgroundThrottling off, so recording keeps full frame rate when hidden.
 */
const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, session, screen, protocol, net, shell, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const DEV_URL = process.env.TAKE1_DEV_URL;
const DIST = path.join(__dirname, '..', 'dist');
const SETTINGS = () => path.join(app.getPath('userData'), 'shortcuts.json');
const DESKTOP = () => path.join(app.getPath('userData'), 'desktop.json');

const DEFAULTS = {
  record: 'Ctrl+Alt+R',
  pause: 'Ctrl+Alt+P',
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
let fx = null;
let pendingSource = null;
let shortcuts = { ...DEFAULTS };
let talk = 'Ctrl+Shift';

/*
 * Push-to-talk needs key *up* events, which globalShortcut can't give us, so we
 * use a low-level keyboard hook (uiohook-napi, N-API so it loads in Electron
 * without rebuilding). Fn is not offered: on Windows the Fn key is handled by
 * the keyboard firmware and never reaches the operating system.
 */
let hook = null;
try {
  hook = require('uiohook-napi');
} catch {
  hook = null;
}

const TALK_GROUPS = {
  'Ctrl+Shift': [['Ctrl', 'CtrlRight'], ['Shift', 'ShiftRight']],
  'Ctrl+Win': [['Ctrl', 'CtrlRight'], ['Meta', 'MetaRight']],
  'Alt+Shift': [['Alt', 'AltRight'], ['Shift', 'ShiftRight']],
  RightCtrl: [['CtrlRight']],
};

function startTalkHook() {
  if (!hook) return false;
  const { uIOhook, UiohookKey } = hook;
  const down = new Set();
  let pending = null;
  let active = false;
  const groups = () => (TALK_GROUPS[talk] || TALK_GROUPS['Ctrl+Shift']).map((g) => g.map((k) => UiohookKey[k]));
  const satisfied = () => groups().every((g) => g.some((c) => down.has(c)));
  const extra = () => {
    const allowed = new Set(groups().flat());
    for (const c of down) if (!allowed.has(c)) return true;
    return false;
  };
  uIOhook.on('keydown', (e) => {
    down.add(e.keycode);
    if (extra()) {
      // another key joined in: this was a shortcut like Ctrl+Shift+T, not push-to-talk
      if (pending) clearTimeout(pending), (pending = null);
      if (active) (active = false), send('command:cancel');
      return;
    }
    if (satisfied() && !active && !pending) {
      pending = setTimeout(() => {
        pending = null;
        if (satisfied() && !extra()) {
          active = true;
          send('command:down');
        }
      }, 140);
    }
  });
  // a drag of the bar always ends when the mouse button comes up, wherever that is
  uIOhook.on('mouseup', () => drag && dragEnd());
  uIOhook.on('keyup', (e) => {
    down.delete(e.keycode);
    if (pending && !satisfied()) clearTimeout(pending), (pending = null);
    if (active && !satisfied()) {
      active = false;
      send('command:up');
    }
  });
  try {
    uIOhook.start();
    return true;
  } catch {
    return false;
  }
}

function loadShortcuts() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS(), 'utf8'));
    if (saved.talk) talk = saved.talk;
    delete saved.talk;
    delete saved.command;
    shortcuts = { ...DEFAULTS, ...saved };
  } catch {
    shortcuts = { ...DEFAULTS };
  }
}

function send(name) {
  if (main && !main.isDestroyed()) main.webContents.send('hotkey', name);
}

function persist() {
  try {
    fs.writeFileSync(SETTINGS(), JSON.stringify({ ...shortcuts, talk }, null, 2));
  } catch {
    /* read-only profile */
  }
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

// ───────────────── the floating bar: where it sits ─────────────────

/** The bar's window: room for the opened column, its labels and the cards beside it. */
const RAIL = { w: 380, h: 560 };
/** keeps the opened column (about 380 px tall) on screen */
const EDGE_MARGIN = 200;

let barPlace = { displayId: null, side: 'right', frac: 0.5 };

function readDesktop() {
  try {
    return JSON.parse(fs.readFileSync(DESKTOP(), 'utf8'));
  } catch {
    return {};
  }
}
function writeDesktop(patch) {
  try {
    fs.writeFileSync(DESKTOP(), JSON.stringify({ ...readDesktop(), ...patch }, null, 2));
  } catch {
    /* read-only profile */
  }
}

function barDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === barPlace.displayId) || screen.getPrimaryDisplay();
}

/** Where the bar's centre is on screen, and the window around it. */
function barGeometry() {
  const d = barDisplay();
  const wa = d.workArea;
  const lo = wa.y + Math.min(EDGE_MARGIN, wa.height / 2);
  const hi = wa.y + wa.height - Math.min(EDGE_MARGIN, wa.height / 2);
  const cy = Math.round(Math.min(hi, Math.max(lo, wa.y + barPlace.frac * wa.height)));
  const x = barPlace.side === 'left' ? wa.x : wa.x + wa.width - RAIL.w;
  return { display: d, cy, bounds: { x: Math.round(x), y: Math.round(cy - RAIL.h / 2), width: RAIL.w, height: RAIL.h } };
}

/** Tell the page where the bar is, so the overlay can grow the replay out of it. */
function announcePlace() {
  const g = barGeometry();
  const cx = barPlace.side === 'left' ? g.bounds.x + 37 : g.bounds.x + RAIL.w - 37;
  if (main && !main.isDestroyed()) main.webContents.send('pill:placed', { side: barPlace.side, cx, cy: g.cy, display: g.display.bounds });
  if (fx && !fx.isDestroyed()) fx.setBounds(g.display.bounds);
}

let slide = null;
/** Move the bar's window, gliding when `animate` (snapping to an edge after a drag). */
function moveBar(target, animate) {
  if (!pill || pill.isDestroyed()) return;
  if (slide) clearInterval(slide), (slide = null);
  if (!animate) return pill.setBounds(target);
  const from = pill.getBounds();
  const t0 = Date.now();
  const D = 220;
  slide = setInterval(() => {
    if (!pill || pill.isDestroyed()) return clearInterval(slide);
    const k = Math.min(1, (Date.now() - t0) / D);
    const e = 1 - Math.pow(1 - k, 3);
    pill.setBounds({ x: Math.round(from.x + (target.x - from.x) * e), y: Math.round(from.y + (target.y - from.y) * e), width: RAIL.w, height: RAIL.h });
    if (k >= 1) clearInterval(slide), (slide = null);
  }, 16);
}

function placePill(animate = false) {
  if (!pill || pill.isDestroyed()) return;
  moveBar(barGeometry().bounds, animate);
  announcePlace();
}

/** Dragging: the window follows the pointer; letting go snaps it to the nearer side edge. */
let drag = null;
function dragStart() {
  if (!pill || pill.isDestroyed() || drag) return;
  const c = screen.getCursorScreenPoint();
  const b = pill.getBounds();
  drag = { dx: c.x - b.x, dy: c.y - b.y, timer: null };
  drag.timer = setInterval(() => {
    if (!pill || pill.isDestroyed()) return dragEnd();
    const p = screen.getCursorScreenPoint();
    pill.setBounds({ x: p.x - drag.dx, y: p.y - drag.dy, width: RAIL.w, height: RAIL.h });
  }, 16);
}
function dragEnd() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  if (!pill || pill.isDestroyed()) return;
  const b = pill.getBounds();
  // the bar sits in the window's middle row, on the side it was on while dragging
  const cx = barPlace.side === 'left' ? b.x + 37 : b.x + RAIL.w - 37;
  const cy = b.y + RAIL.h / 2;
  const d = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
  const wa = d.workArea;
  barPlace = { displayId: d.id, side: cx < wa.x + wa.width / 2 ? 'left' : 'right', frac: Math.min(1, Math.max(0, (cy - wa.y) / wa.height)) };
  writeDesktop({ bar: barPlace });
  placePill(true);
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
          width: RAIL.w,
          height: RAIL.h,
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
    if (frameName === 'take1-fx') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...barDisplay().bounds,
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
    if (details.frameName === 'take1-fx') {
      // whole-screen animations: never clickable, never recorded, under the bar
      fx = win;
      fx.setAlwaysOnTop(true, 'pop-up-menu');
      fx.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      fx.setContentProtection(true);
      fx.setIgnoreMouseEvents(true);
      fx.setBounds(barDisplay().bounds);
      fx.showInactive();
      if (pill && !pill.isDestroyed()) pill.moveTop();
      fx.on('closed', () => (fx = null));
      return;
    }
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
  // the page is ready to hear where the bar is
  main.webContents.on('did-finish-load', () => announcePlace());

  main.on('closed', () => {
    main = null;
    if (pill && !pill.isDestroyed()) pill.close();
    if (fx && !fx.isDestroyed()) fx.close();
  });

  if (DEV_URL) main.loadURL(DEV_URL);
  else main.loadURL('app://take1/index.html');
}

// one Take1 at a time: opening it again brings the running one forward
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', () => {
  if (!main) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
});

app.whenReady().then(() => {
  if (!firstInstance) return;
  const saved = readDesktop();
  if (saved.bar && (saved.bar.side === 'left' || saved.bar.side === 'right')) barPlace = { displayId: saved.bar.displayId ?? null, side: saved.bar.side, frac: Number(saved.bar.frac) || 0.5 };
  // a monitor plugged in or out: put the bar back somewhere visible
  screen.on('display-removed', () => placePill(true));
  screen.on('display-metrics-changed', () => placePill(false));

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
      // Only ever capture what you picked. If that window has gone (closed, or its id
      // changed), refuse rather than fall back to the whole screen.
      const src = pendingSource ? sources.find((s) => s.id === pendingSource) : null;
      pendingSource = null;
      callback(src ? { video: src } : {});
    } catch {
      callback({});
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen'].includes(permission));
  });

  // Uploads go from the page to Google's APIs. The app:// origin isn't a web origin
  // Google knows, so make sure the browser lets those responses through.
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://*.googleapis.com/*'] }, (details, cb) => {
    const h = details.responseHeaders || {};
    for (const k of Object.keys(h)) if (/^access-control-/i.test(k)) delete h[k];
    h['Access-Control-Allow-Origin'] = ['*'];
    h['Access-Control-Allow-Headers'] = ['Authorization, Content-Type, Content-Range, X-Upload-Content-Type, X-Upload-Content-Length'];
    h['Access-Control-Allow-Methods'] = ['GET, POST, PUT, OPTIONS'];
    h['Access-Control-Expose-Headers'] = ['Location, Range'];
    cb({ responseHeaders: h, statusLine: details.method === 'OPTIONS' ? 'HTTP/1.1 200 OK' : details.statusLine });
  });

  loadShortcuts();
  createMain();
  registerAll();
  const hookOk = startTalkHook();

  ipcMain.handle('shortcuts:get', () => ({ ...shortcuts, talk }));
  ipcMain.handle('shortcuts:set', (_e, map) => {
    const { talk: _t, command: _c, ...rest } = map || {};
    shortcuts = { ...DEFAULTS, ...rest };
    persist();
    return registerAll();
  });
  ipcMain.handle('talk:set', (_e, key) => {
    if (TALK_GROUPS[key]) talk = key;
    persist();
    return hookOk;
  });
  ipcMain.handle('talk:status', () => hookOk);

  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: true });
    return sources
      .filter((s) => !/^take1/i.test(s.name))
      .map((s) => ({
        id: s.id,
        name: s.name,
        // JPEG keeps 40 open windows to a few hundred KB over IPC (PNG data URLs are ~10× bigger)
        thumbnail: 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(72).toString('base64'),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      }));
  });
  ipcMain.handle('sources:choose', (_e, id) => {
    pendingSource = id;
  });

  // Esc is only grabbed while a command session is open
  // Esc while talking: the keyboard hook already treats any extra key (Esc included)
  // as "not a command" and cancels, so no system-wide Escape shortcut is needed.
  ipcMain.on('listening', () => {});

  ipcMain.on('pill:interactive', (_e, on) => {
    if (pill && !pill.isDestroyed()) pill.setIgnoreMouseEvents(!on, { forward: true });
  });
  ipcMain.on('pill:visible', (_e, on) => {
    if (!pill || pill.isDestroyed()) return;
    if (on) {
      placePill();
      pill.showInactive();
      if (fx && !fx.isDestroyed()) fx.showInactive();
      pill.moveTop();
    } else {
      pill.hide();
      if (fx && !fx.isDestroyed()) fx.hide();
    }
  });
  ipcMain.on('pill:drag', (_e, phase) => (phase === 'start' ? dragStart() : dragEnd()));
  ipcMain.on('pill:reset', () => {
    barPlace = { displayId: screen.getPrimaryDisplay().id, side: 'right', frac: 0.5 };
    writeDesktop({ bar: barPlace });
    placePill(true);
  });
  ipcMain.handle('pill:where', () => {
    const g = barGeometry();
    return { side: barPlace.side, cx: barPlace.side === 'left' ? g.bounds.x + 37 : g.bounds.x + RAIL.w - 37, cy: g.cy, display: g.display.bounds };
  });
  ipcMain.handle('login:get', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('login:set', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.on('main:show', () => {
    if (!main) return createMain();
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  });
  ipcMain.on('main:hide', () => main && main.minimize());

  ipcMain.handle('google:auth', (_e, o) => googleToken(o));
  ipcMain.handle('google:signout', () => {
    try {
      fs.unlinkSync(GOOGLE_FILE());
    } catch {
      /* not signed in */
    }
  });

  app.on('activate', () => {
    if (!main) createMain();
  });
});

// ───────────────── Google sign-in (desktop) ─────────────────

const GOOGLE_FILE = () => path.join(app.getPath('userData'), 'google.bin');

function readGoogle() {
  try {
    const raw = fs.readFileSync(GOOGLE_FILE());
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
  } catch {
    return null;
  }
}

function writeGoogle(data) {
  const json = JSON.stringify(data);
  fs.writeFileSync(GOOGLE_FILE(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || `Google said ${res.status}`);
  return j;
}

/** Fresh access token: from the saved refresh token if it covers the scopes, else a sign-in in the browser. */
async function googleToken({ clientId, clientSecret, scopes }) {
  const saved = readGoogle();
  const want = scopes.split(' ');
  if (saved && saved.clientId === clientId && saved.refresh_token && want.every((s) => saved.scopes.includes(s))) {
    try {
      const t = await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: saved.refresh_token, grant_type: 'refresh_token' });
      return { access_token: t.access_token, expires_in: t.expires_in, scope: saved.scopes.join(' ') };
    } catch {
      /* revoked or expired: sign in again */
    }
  }
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const allScopes = [...new Set([...(saved && saved.clientId === clientId ? saved.scopes : []), ...want])];
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') return res.end();
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<body style="font:16px system-ui;padding:40px;background:#ffffeb;color:#1a1a1a">${ok ? 'Signed in. You can close this tab and go back to Take1.' : 'Sign-in didn’t complete. Go back to Take1 and try again.'}</body>`);
      server.close();
      ok ? resolve({ code: u.searchParams.get('code'), redirect: `http://127.0.0.1:${server.address()?.port ?? port}` }) : reject(new Error(u.searchParams.get('error') || 'Sign-in was cancelled'));
    });
    let port = 0;
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `http://127.0.0.1:${port}`,
        response_type: 'code',
        scope: allScopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString();
      shell.openExternal(auth.toString());
    });
    // a wrong client type makes Google stop on its own error page and never come back here
    setTimeout(() => {
      server.close();
      reject(new Error('Sign-in timed out'));
    }, 3 * 60 * 1000);
  });
  const t = await tokenRequest({ client_id: clientId, client_secret: clientSecret, code: code.code, code_verifier: verifier, redirect_uri: code.redirect, grant_type: 'authorization_code' });
  const scopesGranted = (t.scope || allScopes.join(' ')).split(' ');
  writeGoogle({ clientId, refresh_token: t.refresh_token || saved?.refresh_token, scopes: scopesGranted });
  if (main && !main.isDestroyed()) main.show();
  return { access_token: t.access_token, expires_in: t.expires_in, scope: scopesGranted.join(' ') };
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try {
    hook && hook.uIOhook.stop();
  } catch {
    /* already stopped */
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
