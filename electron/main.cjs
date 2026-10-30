/**
 * Take1 desktop shell.
 *
 *  - Hold-to-talk from any app (Ctrl+Shift by default, via a low-level keyboard hook),
 *    plus global shortcuts (Ctrl+Alt+R record, Ctrl+Alt+C cut, ...).
 *  - A slim floating bar on the edge of the screen (you drag it where you want it):
 *    transparent, always on top, never steals focus, and excluded from screen
 *    capture (setContentProtection) so it never appears in your video. Take1 checks
 *    that the exclusion really works on this PC (see checkCapture) and says if not.
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
  uIOhook.on('mouseup', () => press && pressEnd());
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
/** the slim bar's centre, measured from the screen edge (10 px gap + half its 5 px width) */
const BAR_INSET = 13;
/** the slim bar's length (1 cm at 100 % scaling) */
const BAR_LEN = 38;

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
  const p = wherePill();
  if (main && !main.isDestroyed()) main.webContents.send('pill:placed', p);
  if (fx && !fx.isDestroyed()) fx.setBounds(p.display);
}

function wherePill() {
  const g = barGeometry();
  const cx = barPlace.side === 'left' ? g.bounds.x + BAR_INSET : g.bounds.x + RAIL.w - BAR_INSET;
  return { side: barPlace.side, cx, cy: g.cy, display: g.display.bounds };
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

/**
 * Moving the bar. Pressing anywhere on it (except the talk button) starts watching the
 * pointer here, in the shell, so it keeps working however fast you move: once it has
 * moved 5 px the window follows the pointer; letting go (seen by the system-wide mouse
 * hook, or by the page) glides it to the nearer side edge of whichever screen it's on.
 * A press that doesn't move stays a normal click.
 */
let press = null;
/** what the page last asked for (hovered or not); held back while a press is going on */
let wantInteractive = false;

function setPillMouse(on) {
  if (!pill || pill.isDestroyed()) return;
  pill.setIgnoreMouseEvents(!on, { forward: true });
  shield(pill); // changing the mouse style can change the window's layering, so re-apply
}

function pressStart() {
  if (!pill || pill.isDestroyed() || press) return;
  const c = screen.getCursorScreenPoint();
  const b = pill.getBounds();
  press = { x: c.x, y: c.y, dx: c.x - b.x, dy: c.y - b.y, moving: false, t0: Date.now(), timer: null };
  setPillMouse(true); // the page must hear the release, even if the pointer outruns the bar
  press.timer = setInterval(() => {
    if (!press) return;
    if (!pill || pill.isDestroyed() || Date.now() - press.t0 > 60000) return pressEnd();
    const p = screen.getCursorScreenPoint();
    if (!press.moving) {
      if (Math.hypot(p.x - press.x, p.y - press.y) < 5) return;
      press.moving = true;
      if (slide) clearInterval(slide), (slide = null);
      if (main && !main.isDestroyed()) main.webContents.send('pill:dragging', true);
    }
    pill.setBounds({ x: p.x - press.dx, y: p.y - press.dy, width: RAIL.w, height: RAIL.h });
  }, 16);
}

function pressEnd() {
  if (!press) return;
  clearInterval(press.timer);
  const moved = press.moving;
  press = null;
  if (!pill || pill.isDestroyed()) return;
  setPillMouse(wantInteractive);
  if (!moved) return;
  const b = pill.getBounds();
  // the bar sits in the window's middle row, on the side it was on while dragging
  const cx = barPlace.side === 'left' ? b.x + BAR_INSET : b.x + RAIL.w - BAR_INSET;
  const cy = b.y + RAIL.h / 2;
  const d = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
  const wa = d.workArea;
  barPlace = { displayId: d.id, side: cx < wa.x + wa.width / 2 ? 'left' : 'right', frac: Math.min(1, Math.max(0, (cy - wa.y) / wa.height)) };
  writeDesktop({ bar: barPlace });
  placePill(true);
  if (main && !main.isDestroyed()) main.webContents.send('pill:dragging', false);
  // moving to another screen moves the overlay too: check it's still hidden there
  scheduleCaptureCheck(900);
}

// ───────────────── keeping the bar and the overlay out of recordings ─────────────────

/**
 * setContentProtection asks Windows (SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
 * Windows 10 2004+) to leave a window out of every screen capture, Take1's own included.
 * Some window changes can drop it, so it is re-applied after each of them and every
 * 2 s while recording. On top of that, Take1 checks that it really works: it flashes a
 * 12 px dot in each window for a moment, takes a screenshot the same way the recording
 * does, and looks for the dot.
 */
function shield(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(true);
  } catch {
    /* not supported here */
  }
}

let recording = false;
let shieldTimer = null;
let capture = { state: 'unknown', fx: null, pill: null, build: require('os').release(), platform: process.platform };
let checking = null;
let checkTimer = null;

function scheduleCaptureCheck(ms) {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    checkTimer = null;
    if (press) return scheduleCaptureCheck(900); // not while the bar is being moved
    if (!recording) checkCapture();
  }, ms);
}

const PROBE = 12;
const probeOn = (x, y) =>
  `(()=>{let d=document.getElementById('t1-probe');if(!d){d=document.createElement('div');d.id='t1-probe';document.body.appendChild(d)}d.style.cssText='position:fixed;left:${x}px;top:${y}px;width:${PROBE}px;height:${PROBE}px;background:#ff00ff;z-index:2147483647;pointer-events:none';})()`;
const PROBE_OFF = `(()=>{const d=document.getElementById('t1-probe');if(d)d.remove()})()`;

/** One screenshot with a dot in each window: does the recording see them? */
async function leakTest() {
  const d = barDisplay();
  const probes = [];
  if (fx && !fx.isDestroyed() && fx.isVisible()) {
    // just under the bar
    const g = barGeometry();
    const x = (barPlace.side === 'left' ? g.bounds.x + BAR_INSET : g.bounds.x + RAIL.w - BAR_INSET) - d.bounds.x - PROBE / 2;
    const y = g.cy - d.bounds.y + BAR_LEN / 2 + 14;
    probes.push({ key: 'fx', win: fx, local: { x, y }, at: { x, y } });
  }
  if (pill && !pill.isDestroyed() && pill.isVisible()) {
    // just above the bar, in the window's see-through part
    const b = pill.getBounds();
    const lx = (barPlace.side === 'left' ? BAR_INSET : RAIL.w - BAR_INSET) - PROBE / 2;
    const ly = RAIL.h / 2 - BAR_LEN / 2 - 14 - PROBE;
    probes.push({ key: 'pill', win: pill, local: { x: lx, y: ly }, at: { x: b.x - d.bounds.x + lx, y: b.y - d.bounds.y + ly } });
  }
  if (!probes.length) return null;
  try {
    await Promise.all(probes.map((p) => p.win.webContents.executeJavaScript(probeOn(p.local.x, p.local.y))));
    await new Promise((r) => setTimeout(r, 260)); // painted and composited
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.bounds.width, height: d.bounds.height } });
    const src = sources.find((s) => s.display_id === String(d.id)) || (sources.length === 1 ? sources[0] : null);
    if (!src || src.thumbnail.isEmpty()) return null;
    const img = src.thumbnail;
    const size = img.getSize();
    const sx = size.width / d.bounds.width;
    const sy = size.height / d.bounds.height;
    const out = {};
    for (const p of probes) {
      // the middle of the dot, 4 × 4 pixels (screen capture is BGRA)
      const cx = Math.round((p.at.x + PROBE / 2) * sx) - 2;
      const cy = Math.round((p.at.y + PROBE / 2) * sy) - 2;
      if (cx < 0 || cy < 0 || cx + 4 > size.width || cy + 4 > size.height) {
        out[p.key] = null;
        continue;
      }
      const px = img.crop({ x: cx, y: cy, width: 4, height: 4 }).toBitmap();
      let hits = 0;
      for (let i = 0; i + 3 < px.length; i += 4) if (px[i] > 180 && px[i + 1] < 100 && px[i + 2] > 180) hits++;
      out[p.key] = hits >= 8; // seen in the capture: it leaks
    }
    return out;
  } catch {
    return null;
  } finally {
    for (const p of probes) if (!p.win.isDestroyed()) p.win.webContents.executeJavaScript(PROBE_OFF).catch(() => {});
  }
}

function report() {
  if (main && !main.isDestroyed()) main.webContents.send('capture:status', capture);
}

/** Check, and if a window shows up in captures, try to fix it before giving up on it. */
async function checkCapture() {
  if (checking) return checking;
  checking = (async () => {
    const windows = () => ({ fx, pill });
    let r = await leakTest();
    const repairs = [
      // 1. set it again from scratch
      (w) => {
        w.setContentProtection(false);
        w.setContentProtection(true);
      },
      // 2. hide, protect, show: the order Windows is happiest with
      (w) => {
        w.hide();
        w.setContentProtection(true);
        w.showInactive();
        w.setContentProtection(true);
        if (w === pill) setPillMouse(wantInteractive), pill.moveTop();
        else w.setIgnoreMouseEvents(true);
      },
    ];
    for (const fix of repairs) {
      if (!r || !(r.fx || r.pill)) break;
      for (const k of ['fx', 'pill']) {
        const w = windows()[k];
        if (r[k] && w && !w.isDestroyed()) fix(w);
      }
      await new Promise((res) => setTimeout(res, 200));
      r = await leakTest();
    }
    // before Windows 10 2004 there is no "leave it out" mode, only "show it black"
    const build = Number(String(capture.build).split('.')[2]) || 0;
    if (process.platform === 'win32' && build > 0 && build < 19041) r = { fx: true, pill: true };
    capture = { ...capture, state: !r ? 'unknown' : r.fx || r.pill ? 'leaks' : 'hidden', fx: r ? r.fx : null, pill: r ? r.pill : null, at: Date.now() };
    report();
    return capture;
  })();
  try {
    return await checking;
  } finally {
    checking = null;
  }
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
      fx.setIgnoreMouseEvents(true);
      shield(fx);
      fx.setBounds(barDisplay().bounds);
      fx.on('show', () => shield(fx));
      fx.showInactive();
      shield(fx);
      if (pill && !pill.isDestroyed()) pill.moveTop();
      fx.on('closed', () => (fx = null));
      scheduleCaptureCheck(1500);
      return;
    }
    if (details.frameName !== 'take1-pill') return;
    pill = win;
    pill.setAlwaysOnTop(true, 'screen-saver');
    pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    wantInteractive = false;
    setPillMouse(false); // click-through until hovered; also applies the capture shield
    placePill();
    pill.on('show', () => shield(pill));
    pill.showInactive();
    shield(pill);
    pill.on('closed', () => {
      pill = null;
      if (press) clearInterval(press.timer), (press = null);
    });
    scheduleCaptureCheck(1500);
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
  screen.on('display-removed', () => (placePill(true), scheduleCaptureCheck(1500)));
  screen.on('display-metrics-changed', () => (placePill(false), scheduleCaptureCheck(1500)));

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
    wantInteractive = !!on;
    if (!press) setPillMouse(wantInteractive);
  });
  ipcMain.on('pill:visible', (_e, on) => {
    if (!pill || pill.isDestroyed()) return;
    if (on) {
      placePill();
      pill.showInactive();
      shield(pill);
      if (fx && !fx.isDestroyed()) fx.showInactive(), shield(fx);
      pill.moveTop();
    } else {
      pill.hide();
      if (fx && !fx.isDestroyed()) fx.hide();
    }
  });
  ipcMain.on('pill:press', () => pressStart());
  ipcMain.on('pill:release', () => pressEnd());
  // recording: keep re-applying the shield, and never flash the check's dot into a take
  ipcMain.on('rec:live', (_e, on) => {
    recording = !!on;
    if (shieldTimer) clearInterval(shieldTimer), (shieldTimer = null);
    if (recording) {
      if (checkTimer) clearTimeout(checkTimer), (checkTimer = null);
      shield(pill);
      shield(fx);
      shieldTimer = setInterval(() => (shield(pill), shield(fx)), 2000);
    }
  });
  ipcMain.handle('capture:status', () => capture);
  ipcMain.handle('capture:check', () => (recording ? capture : checkCapture()));
  ipcMain.on('pill:reset', () => {
    barPlace = { displayId: screen.getPrimaryDisplay().id, side: 'right', frac: 0.5 };
    writeDesktop({ bar: barPlace });
    placePill(true);
  });
  ipcMain.handle('pill:where', () => wherePill());
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
