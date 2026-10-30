import { store, pushLog, toast, uid, DEFAULT_SHORTCUTS, setFlag, type Rect, type StageMark, type RangeInfo, type Tone } from '../lib/store';
import { native } from '../lib/native';
import { library } from '../lib/library';
import { suggestChapters } from '../lib/transcript';
import { buildTrack, type CaptionStyle } from '../lib/captions';
import { fontFile } from '../lib/captionFonts';
import { AudioEngine, PcmBuffer, SAMPLE_RATE } from './audio';
import { Compositor } from './compositor';
import { EncodedVideo, type Chunk } from './video';
import { Snapshots, releaseSnaps, type Snap } from './snapshots';
import { Replay } from './replay';
import { createTicker } from './ticker';
import { buildVideo } from './export';
import { interpret, INTENT_LABEL, type Command } from '../voice/intent';
import { stt, to16k, prepCommand } from '../voice/stt';
import { sounds, bindSounds, setSoundsEnabled } from '../ui/sounds';

/**
 * The Recorder turns commands (voice, hotkeys, buttons) into edits of the recording.
 *
 * Two clocks:
 *  - AudioContext time ("ctx"): when things physically happened.
 *  - Output time: where they land in the final video. It only advances while recording
 *    (1/8 speed during Hold) and jumps back on a Cut.
 * A "stretch" maps one run of ctx time onto output time; audio blocks are placed on
 * the timeline through the stretch that was live when they were captured.
 *
 * Nothing listens for commands until you ask it to: a hotkey or a click opens a
 * short command session, which ends on its own after you stop speaking.
 */

interface Stretch {
  ctxStart: number;
  ctxEnd: number | null;
  outStart: number;
  rate: number;
  dead?: boolean;
}

interface Outtake {
  id: string;
  take: number;
  from: number;
  to: number;
  prefix: Chunk[];
  chunks: Chunk[];
  audio: Float32Array;
  snaps: Snap[];
  saved: {
    ranges: RangeInfo[];
    chapters: ReturnType<typeof store.get>['chapters'];
    scrubs: { start: number; end: number }[];
    viewHistory: { t: number; view: Rect }[];
    take: number;
  };
}

interface Session {
  hold: boolean;
  startCtx: number;
  startOut: number | null;
  buf: Float32Array[];
  speech: boolean;
  lastLoud: number;
  /** AudioContext time of the first loud block (may be just before the keys went down) */
  onsetCtx?: number;
  /** keys released: we keep listening for a short tail, then recognise */
  releasing?: boolean;
  endOut?: number | null;
}

/** "Take one, …" as Whisper tends to write it (take 1, take won, okay take one…) */
const WAKE = /^(?:(?:ok|okay|hey)\s+)?(?:take|tape|taik|tech|taken|takes)\s*(?:one|1|won|wan|on)\b\s*(.*)$/;

const FPS = 30;
const FD = 1 / FPS;

export class Recorder {
  audio: AudioEngine | null = null;
  comp = new Compositor();
  video = new EncodedVideo();
  pcm = new PcmBuffer(SAMPLE_RATE);
  snaps = new Snapshots();
  screenStream: MediaStream | null = null;
  cameraStream: MediaStream | null = null;
  pillWin: Window | null = null;
  pillRoot: HTMLElement | null = null;
  /** desktop: the click-through overlay across the screen (command animations, replay, countdown) */
  fxWin: Window | null = null;
  fxRoot: HTMLElement | null = null;
  onName: ((name: string) => void) | null = null;
  replay: Replay | null = null;

  private ticker: { stop: () => void } | null = null;
  private outBase = 0;
  private resumeCtx = 0;
  private rate = 1;
  private stretches: Stretch[] = [];
  private lastFrameTs = -1;
  private forceKey = false;
  private frozen = false;
  private lastSnapT = -1e9;
  private lastPunch = 0;
  private punchAt: number | null = null;
  private prerollTotal = 0;
  private holdStart: { out: number; ctx: number } | null = null;
  private timers: { at: number; fn: () => void; tag: string }[] = [];
  private matchSig = false;
  private tickN = 0;
  private actionN = 0;
  private session: Session | null = null;
  /** wake phrase: the phrase being heard right now, and "Take one" heard on its own */
  private wake: { onset: number; startOut: number | null; buf: Float32Array[]; lastLoud: number; long: boolean } | null = null;
  private wakeArmed: { until: number; startOut: number | null; id: number } | null = null;
  private wakeBusy = false;
  /** the last second of mic audio, so a command spoken a beat before the keys still counts */
  private ring: { t: number; s: Float32Array }[] = [];

  scrubs: { start: number; end: number }[] = [];
  outtakes: Outtake[] = [];
  private cutStack: Outtake[] = [];
  private undo: { label: string; fn: () => void }[] = [];
  private viewHistory: { t: number; view: Rect }[] = [];
  private previewCache: string | null = null;
  /** the last export and what it was made from, so revisiting Export doesn't redo it */
  private exportCache: { key: string; blob: Blob } | null = null;

  constructor() {
    this.comp.onChunk = (c) => this.video.add(c);
    this.comp.onMatch = (score) => store.get().phase === 'preroll' && store.set({ matchScore: score });
    this.comp.onError = (m) => toast(`Video encoder: ${m}`, 'rec');
    setSoundsEnabled(store.get().settings.sounds);
    if (native) {
      native.onHotkey((name) => this.hotkey(name));
      native.getShortcuts().then((s) => {
        if (!s) return;
        const { talk, ...rest } = s as Record<string, string>;
        store.set({ shortcuts: { ...DEFAULT_SHORTCUTS, ...rest }, ...(talk ? { talkKey: talk } : {}) });
      });
      native.talkStatus().then((ok) => store.set({ talkHook: ok }));
      native.onPillPlaced?.((p) => store.set({ pillPlace: p }));
      native.pillWhere?.().then((p) => p && store.set({ pillPlace: p }));
    }
  }

  // ───────────────────────── setup ─────────────────────────

  private ensureAudio() {
    if (!this.audio) {
      this.audio = new AudioEngine();
      bindSounds(this.audio.ctx);
      this.audio.onBlock = (s, t) => this.onAudio(s, t);
    }
    return this.audio;
  }

  get ctxTime() {
    return this.audio?.ctx.currentTime ?? performance.now() / 1000;
  }

  private get thr() {
    return this.audio?.speechThreshold ?? 0.01;
  }

  async micOn(deviceId?: string) {
    const a = this.ensureAudio();
    try {
      await a.start(deviceId);
      store.set({ micOn: true, micDevice: a.deviceId, micDevices: await AudioEngine.inputs() });
    } catch (e) {
      toast('Microphone blocked. Allow it and try again.', 'rec');
      throw e;
    }
    this.startTicker();
    stt.warm();
  }

  /** Turn the microphone off completely (Setup, while not recording). */
  micOff() {
    if (!['idle', 'wrapped'].includes(store.get().phase)) return toast('Stop recording first.', 'muted');
    this.audio?.stop();
    store.set({ micOn: false, micMuted: false });
  }

  private startTicker() {
    if (!this.ticker) this.ticker = createTicker(FPS, () => this.tick());
  }

  /** Browser: the native picker. Desktop: our own picker (Stage shows it). */
  async shareScreen() {
    if (native) {
      store.set({ pickingSource: true });
      return;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'window', frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      preferCurrentTab: false,
    } as any);
    await this.attachScreen(stream);
  }

  async useSource(id: string, name: string) {
    store.set({ pickingSource: false });
    await native!.chooseSource(id);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false } as any);
    } catch {
      // the shell refuses rather than silently capturing the whole screen
      toast(`Couldn’t capture “${name}”. It may have closed. Choose it again.`, 'rec');
      store.set({ pickingSource: true });
      return;
    }
    await this.attachScreen(stream, id.startsWith('screen:') ? 'monitor' : 'window', name);
  }

  async attachScreen(stream: MediaStream, surface?: string, name?: string) {
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.comp.detach('screen');
    this.screenStream = stream;
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
    this.comp.setSize(s.width || 1920, s.height || 1080);
    this.comp.attach(track, 'screen');
    this.video.codec = await this.comp.configure(FPS, 5_000_000);
    this.startTicker();
    const surf = surface ?? s.displaySurface ?? null;
    store.set({ hasScreen: true, surface: surf, sourceName: name ?? friendlySource(track.label, surf) });
    track.addEventListener('ended', () => {
      store.set({ hasScreen: false });
      if (['rolling', 'hold'].includes(store.get().phase)) toast('Window sharing stopped. Wrap, or share again.', 'rec');
    });
  }

  /** Stop sharing the chosen window (Setup, while not recording). */
  removeScreen() {
    if (!['idle', 'wrapped'].includes(store.get().phase)) return toast('Stop recording first.', 'muted');
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.comp.detach('screen');
    this.zoomTo(null, false);
    store.set({ hasScreen: false, surface: null, sourceName: null });
  }

  async toggleCamera() {
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach((t) => t.stop());
      this.cameraStream = null;
      this.comp.detach('camera');
      store.set({ hasCamera: false });
      return;
    }
    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      this.comp.attach(this.cameraStream.getVideoTracks()[0], 'camera');
      store.set({ hasCamera: true, cameraOn: true });
      this.comp.setCamera(true);
    } catch {
      toast('Camera blocked or not found.', 'rec');
    }
  }

  setSettings(p: Partial<ReturnType<typeof store.get>['settings']>) {
    store.set((s) => ({ settings: { ...s.settings, ...p } }));
    if (p.sounds !== undefined) setSoundsEnabled(p.sounds);
  }

  async setTalkKey(key: string) {
    store.set({ talkKey: key });
    if (native) {
      const ok = await native.setTalkKey(key);
      if (!ok) toast('Push-to-talk needs the keyboard hook, which didn’t load. Click and hold the pill’s voice button instead.', 'rec');
    }
  }

  async setShortcut(name: string, accel: string) {
    const next = { ...store.get().shortcuts, [name]: accel };
    store.set({ shortcuts: next });
    if (native) {
      const ok = await native.setShortcuts(next);
      const bad = Object.entries(ok).filter(([, v]) => !v).map(([k]) => k);
      if (bad.length) toast(`Couldn’t register ${bad.join(', ')}: another app may own that shortcut.`, 'rec');
    }
  }

  // ───────────────────────── marks ─────────────────────────

  addMark(name: string, rect: Rect) {
    const m: StageMark = { id: uid(), name: name.trim() || `Mark ${store.get().marks.length + 1}`, rect };
    store.set((s) => ({ marks: [...s.marks, m] }));
    return m;
  }

  removeMark(id: string) {
    store.set((s) => ({ marks: s.marks.filter((m) => m.id !== id), activeMark: s.activeMark === id ? null : s.activeMark }));
  }

  zoomTo(mark: StageMark | null, record = true) {
    const v = this.comp.viewFor(mark?.rect ?? null);
    const prev = { ...this.comp.target };
    const prevActive = store.get().activeMark;
    this.comp.setView(v);
    this.viewHistory.push({ t: this.outputTime(), view: v });
    store.set({ activeMark: mark?.id ?? null });
    if (record) {
      this.undo.push({
        label: 'zoom',
        fn: () => {
          this.comp.setView(prev);
          this.viewHistory.push({ t: this.outputTime(), view: prev });
          store.set({ activeMark: prevActive });
        },
      });
      this.act(mark ? 'zoom' : 'wide', mark ? `Zoom · ${mark.name}` : 'Wide', 'ok');
    }
  }

  // ───────────────────────── floating controls ─────────────────────────

  /**
   * Desktop: a transparent, always-on-top window on the right edge that the shell
   * excludes from screen capture. Browser: a small Document Picture-in-Picture window.
   */
  async openPill() {
    if (this.pillWin && !this.pillWin.closed) return true;
    let w: Window | null = null;
    if (native) w = window.open('about:blank', 'take1-pill');
    else {
      const dpip = (window as any).documentPictureInPicture;
      if (!dpip) {
        toast('Floating controls need Chrome or Edge 116+. The desktop app has them everywhere.', 'muted');
        return false;
      }
      // as small as Chrome allows: the window is just the bar (it won't go under ~240 × 50)
      w = await dpip.requestWindow({ width: 344, height: 56 });
    }
    if (!w) return false;
    const root = prepWindow(w, native ? 'fc-native' : 'fc-pip', 'pill-root');
    w.addEventListener('keydown', (e) => keyHandler(e));
    w.addEventListener('keyup', (e) => keyUpHandler(e));
    w.addEventListener('blur', () => releaseKeys());
    // closed by the user or the OS: stop rendering into it straight away
    w.addEventListener('pagehide', () => {
      if (this.pillWin !== w) return;
      this.pillWin = null;
      this.pillRoot = null;
      store.set({ pillOpen: false });
      // in the browser, the keys can't reach Take1 from other windows without it
      if (!native && ['rolling', 'hold', 'paused', 'preroll', 'rewinding'].includes(store.get().phase))
        toast('Floating bar closed. Take1 can only hear Ctrl+Shift while its tab is in front now. Reopen it from Record, or get the desktop app.', 'rec');
    });
    this.pillWin = w;
    this.pillRoot = root;
    if (native) this.openFx();
    store.set({ pillOpen: true });
    return true;
  }

  /** Desktop: the transparent overlay across the screen, under the bar. */
  private openFx() {
    if (this.fxWin && !this.fxWin.closed) return;
    const w = window.open('about:blank', 'take1-fx');
    if (!w) return;
    this.fxRoot = prepWindow(w, 'fc-native', 'fx-root');
    this.fxWin = w;
    w.addEventListener('pagehide', () => {
      if (this.fxWin !== w) return;
      this.fxWin = null;
      this.fxRoot = null;
    });
  }

  closePill() {
    this.pillWin?.close();
    this.pillWin = null;
    this.pillRoot = null;
    this.fxWin?.close();
    this.fxWin = null;
    this.fxRoot = null;
    store.set({ pillOpen: false });
  }

  togglePill() {
    if (store.get().pillOpen) this.closePill();
    else this.openPill();
  }

  // ───────────────────────── clocks ─────────────────────────

  outputTime() {
    const ph = store.get().phase;
    if (!this.frozen && (ph === 'rolling' || ph === 'hold')) return this.outBase + Math.max(0, this.ctxTime - this.resumeCtx) * this.rate;
    return this.outBase;
  }

  private closeStretch(kill: boolean) {
    const s = this.stretches[this.stretches.length - 1];
    if (!s) return;
    if (s.ctxEnd === null) s.ctxEnd = this.ctxTime;
    if (kill) s.dead = true;
  }

  private openStretch(rate: number, at = this.ctxTime) {
    this.resumeCtx = at;
    this.rate = rate;
    this.stretches.push({ ctxStart: at, ctxEnd: null, outStart: this.outBase, rate });
  }

  private after(ms: number, fn: () => void, tag = 'sys') {
    this.timers.push({ at: performance.now() + ms, fn, tag });
  }

  private clearTimers(tag: string) {
    this.timers = this.timers.filter((t) => t.tag !== tag);
  }

  private act(kind: string, label: string, tone: Tone, detail?: string) {
    store.set({ lastAction: { kind, label, id: ++this.actionN } });
    pushLog({ kind, label, tone, detail, at: this.outputTime() });
  }

  // ───────────────────────── capture loop ─────────────────────────

  private onAudio(s: Float32Array, t: number) {
    const copy = s.slice();
    this.ring.push({ t, s: copy });
    while (this.ring.length && this.ring[0].t < t - 1) this.ring.shift();
    const ses = this.session;
    if (!ses) this.wakeFeed(copy, t);
    else this.wake = null;
    if (ses) {
      ses.buf.push(copy);
      if (this.loud(copy)) {
        ses.speech = true;
        ses.onsetCtx ??= t;
        ses.lastLoud = t + s.length / this.pcm.sr;
      }
    }
    if (store.get().micMuted) return;
    const sr = this.pcm.sr;
    const dur = s.length / sr;
    for (let i = this.stretches.length - 1; i >= 0 && i >= this.stretches.length - 3; i--) {
      const st = this.stretches[i];
      if (st.dead || st.rate !== 1) continue;
      const a = Math.max(t, st.ctxStart);
      const b = Math.min(t + dur, st.ctxEnd ?? Infinity);
      if (b <= a) continue;
      const i0 = Math.round((a - t) * sr);
      const i1 = Math.round((b - t) * sr);
      this.pcm.write((st.outStart + (a - st.ctxStart)) * sr, s.subarray(i0, i1));
    }
  }

  private loud(s: Float32Array) {
    let e = 0;
    for (let i = 0; i < s.length; i++) e += s[i] * s[i];
    return Math.sqrt(e / s.length) > this.thr * 1.15;
  }

  private tick() {
    const now = performance.now();
    if (this.timers.length) {
      const due = this.timers.filter((x) => x.at <= now);
      if (due.length) {
        this.timers = this.timers.filter((x) => x.at > now);
        due.forEach((x) => x.fn());
      }
    }
    this.tickN++;
    if (this.tickN % 30 === 0 && this.pillWin?.closed) {
      this.pillWin = null;
      this.pillRoot = null;
      store.set({ pillOpen: false });
    }
    this.sessionTick();
    const ph = store.get().phase;
    if (ph === 'rolling' || ph === 'hold') this.captureFrame();
    else if (ph === 'preroll') this.prerollTick();
  }

  private captureFrame() {
    if (this.frozen || !this.comp.hasScreen) return;
    const t = this.outputTime();
    if (this.lastFrameTs >= 0 && t - this.lastFrameTs < FD * 0.95) return;
    let ts = Math.round(t * 1e6);
    if (this.lastFrameTs >= 0) ts = Math.max(ts, Math.round(this.lastFrameTs * 1e6) + 1);
    // the worker draws and encodes; the first frame after resuming is always a keyframe
    this.comp.encode(ts, Math.round(FD * 1e6), this.video.wantsKey(ts, this.forceKey));
    this.forceKey = false;
    this.lastFrameTs = ts / 1e6;
    if (t - this.lastSnapT >= 0.5) {
      this.lastSnapT = t;
      this.snaps.capture(() => this.comp.snapshot(480), t, { ...this.comp.target });
    }
  }

  private prerollTick() {
    if (this.punchAt === null) return;
    const rem = this.punchAt - this.ctxTime;
    const cd = store.get().settings.countdown;
    const n = rem <= cd ? Math.max(1, Math.ceil(rem)) : null;
    if (store.get().countdown !== n) {
      store.set({ countdown: n });
      if (n !== null) sounds.tick();
    }
    if (rem <= 0) return this.punchIn(this.punchAt);
    // reference frame for the screen match: the last replayed frame, scored in the compositor worker
    if (!this.matchSig && this.replay?.last) {
      this.matchSig = true;
      this.comp.setMatchRef(this.replay.last);
    }
  }

  /** The replay frame that should be on screen right now, plus progress (0..1). */
  replayNow(): { frame: ImageBitmap | null; progress: number; remaining: number } | null {
    if (store.get().phase !== 'preroll' || this.punchAt === null) return null;
    const rem = Math.max(0, this.punchAt - this.ctxTime);
    const progress = this.prerollTotal ? 1 - rem / this.prerollTotal : 1;
    const T = this.outBase;
    const frame = this.replay ? this.replay.frameAt(T - Math.min(rem, T - this.replay.from)) : null;
    return { frame, progress, remaining: rem };
  }

  // ───────────────────────── command sessions ─────────────────────────

  hotkey(name: string) {
    switch (name) {
      case 'command:down':
        return this.commandDown();
      case 'command:up':
        return this.commandUp();
      case 'command:cancel':
        return this.cancelCommand();
      case 'record':
        return this.record();
      case 'cut':
        return this.run({ type: 'cut' });
      case 'hold':
        return this.holdToggle();
      case 'pause':
        return this.pauseToggle();
      case 'mic':
        return this.toggleMic();
      case 'pill':
        return this.togglePill();
      case 'cancel':
        return this.cancelCommand();
    }
  }

  /**
   * Push-to-talk. Commands are only heard while the talk key (default Ctrl+Shift)
   * or the pill's voice button is held. Released = not listening; everything you
   * say then is just narration in the recording.
   */
  commandDown() {
    if (this.session) return;
    this.startCommand();
  }

  commandUp() {
    const s = this.session;
    if (!s || s.releasing) return;
    const held = this.ctxTime - s.startCtx;
    const ph = store.get().phase;
    s.releasing = true;
    // the mute in the recording ends here, when you let go, not when recognition finishes
    s.endOut = ph === 'rolling' || ph === 'hold' ? this.outputTime() : null;
    // people let go while finishing the word: keep listening for a short tail
    store.set((x) => ({ listen: { ...x.listen, state: 'thinking' } }));
    this.after(
      220,
      () => {
        if (this.session !== s) return;
        if (!s.speech) return this.cancelCommand(held > 0.6 ? 'Didn’t hear a command. Speak while holding the keys.' : undefined);
        this.finishFromAudio();
      },
      'tail',
    );
  }

  async startCommand() {
    const st = store.get();
    if (st.listen.state === 'thinking') return;
    if (!st.micOn) {
      try {
        await this.micOn();
      } catch {
        return;
      }
    }
    // Speech is only ever recognised on this computer. Until the model is ready, say so.
    if (!stt.ready.command) {
      const e = store.get().engine;
      if (e.status === 'loading') toast(`Speech model still loading (${Math.round(e.progress * 100)}%). Buttons and shortcuts work now.`, 'muted');
      else if (e.status === 'error') {
        toast(`${e.detail ?? 'The speech model couldn’t load.'} Trying again…`, 'rec');
        stt.retry();
      } else {
        toast('Loading the speech model… try again in a moment.', 'muted');
        stt.warm();
      }
      return;
    }
    const live = st.phase === 'rolling' || st.phase === 'hold';
    const now = this.ctxTime;
    const ses: Session = { hold: true, startCtx: now, startOut: live ? this.outputTime() : null, buf: [], speech: false, lastLoud: now };
    // the beat before the keys went down (the hotkey itself takes ~150 ms to register)
    for (const r of this.ring) {
      if (r.t < now - 0.55) continue;
      ses.buf.push(r.s);
      if (this.loud(r.s)) {
        ses.speech = true;
        ses.onsetCtx ??= r.t;
      }
    }
    this.session = ses;
    native?.listening(true);
    store.set((s) => ({ listen: { state: 'listening', heard: '', intent: null, alternatives: [], id: s.listen.id + 1 } }));
    sounds.ping();
  }

  cancelCommand(msg?: string) {
    if (!this.session) return;
    this.session = null;
    native?.listening(false);
    store.set((s) => ({ listen: { ...s.listen, state: 'off' } }));
    if (msg) toast(msg, 'muted');
  }

  private sessionTick() {
    const s = this.session;
    if (!s || s.releasing) return;
    const now = this.ctxTime;
    // released keys end the session; this only guards against a stuck key
    if (now - s.startCtx > 15) s.speech ? this.finishFromAudio() : this.cancelCommand();
  }

  private async finishFromAudio() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    native?.listening(false);
    store.set((x) => ({ listen: { ...x.listen, state: 'thinking' } }));
    const total = s.buf.reduce((a, b) => a + b.length, 0);
    const pcm = new Float32Array(total);
    let p = 0;
    for (const b of s.buf) {
      pcm.set(b, p);
      p += b.length;
    }
    const audio16 = prepCommand(to16k(pcm, this.pcm.sr), this.thr * 0.8);
    let text = '';
    try {
      text = await stt.command(audio16.slice());
    } catch {
      return this.unsure('', ['cut', 'pause', 'wrap']);
    }
    this.finishCommand(text, s, audio16);
  }

  // ───────────────────────── wake phrase (desktop, opt-in) ─────────────────────────

  /**
   * "Take one, cut": commands without holding keys. Speech is split into phrases at
   * pauses; only short phrases (where a command could be) are recognised, on this
   * computer, and only ones that start with "Take one" count. Their audio is removed
   * from the recording like a held-key command.
   */
  private wakeFeed(s: Float32Array, t: number) {
    const st = store.get();
    if (!native || !st.settings.wake || !stt.ready.command || st.micMuted) {
      this.wake = null;
      return;
    }
    if (this.wakeArmed && this.ctxTime > this.wakeArmed.until) {
      const id = this.wakeArmed.id;
      this.wakeArmed = null;
      if (store.get().listen.id === id && store.get().listen.state === 'listening') store.set((x) => ({ listen: { ...x.listen, state: 'off' } }));
    }
    const dur = s.length / this.pcm.sr;
    const loud = this.loud(s);
    const w = this.wake;
    if (!w) {
      if (!loud) return;
      // a phrase begins: keep a moment before it, so the first syllable isn't clipped
      const pre = this.ring.filter((r) => r.t >= t - 0.3 && r.t < t).map((r) => r.s);
      this.wake = { onset: t, startOut: this.outputAt(t), buf: [...pre, s], lastLoud: t + dur, long: false };
      return;
    }
    if (loud) w.lastLoud = t + dur;
    // "Take one, speed up 8x" fits in ~3 s; longer phrases are narration (after "Take one" alone, allow 5 s)
    const limit = this.wakeArmed ? 5 : 3.2;
    if (!w.long) {
      if (t + dur - w.onset > limit) {
        w.long = true;
        w.buf = [];
      } else w.buf.push(s);
    }
    if (t + dur - w.lastLoud > 0.45) {
      this.wake = null;
      if (!w.long) this.wakeRecognise(w, t + dur);
    }
  }

  /** Output-timeline position of an AudioContext time, while recording (else null). */
  private outputAt(ctxT: number): number | null {
    const ph = store.get().phase;
    if (ph !== 'rolling' && ph !== 'hold') return null;
    return Math.max(this.lastPunch, this.outputTime() - Math.max(0, this.ctxTime - ctxT) * this.rate);
  }

  private async wakeRecognise(w: { onset: number; startOut: number | null; buf: Float32Array[] }, endCtx: number) {
    if (this.wakeBusy || this.session || store.get().listen.state === 'thinking') return;
    this.wakeBusy = true;
    try {
      const total = w.buf.reduce((a, b) => a + b.length, 0);
      const pcm = new Float32Array(total);
      let p = 0;
      for (const b of w.buf) {
        pcm.set(b, p);
        p += b.length;
      }
      const audio16 = prepCommand(to16k(pcm, this.pcm.sr), this.thr * 0.8);
      let text = '';
      try {
        text = (await stt.command(audio16)).trim();
      } catch {
        return;
      }
      const m = WAKE.exec(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim());
      const armed = this.wakeArmed && this.ctxTime <= this.wakeArmed.until ? this.wakeArmed : null;
      if (!m && !armed) return;
      if (this.session) return; // you started holding the keys meanwhile
      const endOut = this.outputAt(endCtx);
      const startOut = armed && !m ? armed.startOut ?? w.startOut : w.startOut;
      if (m && !m[1].trim()) {
        // just "Take one": listen for the command in the next phrase, like holding the keys
        const ph = store.get().phase;
        if (startOut !== null && endOut !== null && (ph === 'rolling' || ph === 'hold')) this.scrubs.push({ start: Math.max(this.lastPunch, startOut - 0.05), end: endOut + 0.2 });
        store.set((x) => ({ listen: { state: 'listening', heard: '', intent: null, alternatives: [], id: x.listen.id + 1 } }));
        this.wakeArmed = { until: this.ctxTime + 5, startOut, id: store.get().listen.id };
        sounds.ping();
        return;
      }
      const said = m ? m[1].trim() : text;
      // "Take on the next part…" is narration, not a command: only act on something we understand
      if (!armed && !interpret(said, store.get().marks, await stt.intentScores(said)).command) return;
      this.wakeArmed = null;
      const s: Session = { hold: false, startCtx: w.onset, onsetCtx: w.onset, startOut, endOut, buf: [], speech: true, lastLoud: endCtx };
      store.set((x) => ({ listen: { state: 'thinking', heard: '', intent: null, alternatives: [], id: armed ? x.listen.id : x.listen.id + 1 } }));
      await this.finishCommand(said, s);
    } finally {
      this.wakeBusy = false;
    }
  }

  private unsure(heard: string, alternatives: string[]) {
    store.set((x) => ({ listen: { ...x.listen, state: 'unsure', heard, intent: null, alternatives } }));
    const id = store.get().listen.id;
    this.after(4000, () => store.get().listen.id === id && store.set((x) => ({ listen: { ...x.listen, state: 'off' } })), 'listen');
  }

  private async finishCommand(raw: string, s: Session, retry?: Float32Array) {
    let text = raw.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim(); // whisper noise tags
    const marks = () => store.get().marks;
    let r = interpret(text, marks(), await stt.intentScores(text));
    // not sure? listen again with the bigger model before asking you
    if (!r.command && retry && stt.ready.transcript) {
      try {
        const t2 = (await stt.command(retry, true)).trim();
        if (t2) {
          const r2 = interpret(t2, marks(), await stt.intentScores(t2));
          if (r2.command || !text) {
            r = r2;
            text = t2;
          }
        }
      } catch {
        /* keep the first answer */
      }
    }
    // the spoken command never reaches the final audio: mute from where you started
    // speaking (at most a moment before the keys) to when you let go, plus the tail
    let start = s.startOut;
    if (start !== null) {
      const lead = s.onsetCtx !== undefined ? Math.min(0.3, Math.max(0, s.startCtx - s.onsetCtx)) : 0;
      start = Math.max(this.lastPunch, start - lead - 0.05);
    }
    const ph = store.get().phase;
    if (start !== null && (ph === 'rolling' || ph === 'hold')) this.scrubs.push({ start, end: (s.endOut ?? this.outputTime()) + 0.25 });
    if (!r.command) return this.unsure(text, r.alternatives);
    store.set((x) => ({ listen: { ...x.listen, state: 'done', heard: text, intent: r.intent } }));
    const id = store.get().listen.id;
    this.after(1500, () => store.get().listen.id === id && store.set((x) => ({ listen: { ...x.listen, state: 'off' } })), 'listen');
    this.run(r.command, { startOut: start });
  }

  /** Act as if a command session just heard `text` (tests, demos). */
  async simulate(text: string, secondsAgo = 1) {
    const live = ['rolling', 'hold'].includes(store.get().phase);
    const s: Session = { hold: true, startCtx: this.ctxTime - secondsAgo, startOut: live ? Math.max(0, this.outputTime() - secondsAgo) : null, buf: [], speech: true, lastLoud: this.ctxTime };
    store.set((x) => ({ listen: { ...x.listen, id: x.listen.id + 1 } }));
    await this.finishCommand(text, s);
  }

  // ───────────────────────── intents ─────────────────────────

  /** One entry point for voice, buttons and hotkeys. */
  run(cmd: Command, o: { startOut?: number | null } = {}) {
    const st = store.get();
    if (st.trying) return this.tryOut(cmd);
    const ph = st.phase;
    const live = ph === 'rolling' || ph === 'hold';
    const paused = ph === 'paused';
    const rew = ph === 'preroll' || ph === 'rewinding';
    if (st.drawing && cmd.type !== 'scratch' && cmd.type !== 'wrap') return toast('Finish the box first: drag it in Take1, or press Skip.', 'muted');
    switch (cmd.type) {
      case 'action':
      case 'play':
        this.play(cmd.type === 'action');
        break;
      case 'pause':
        if (live) this.pause(o.startOut ?? null);
        else if (rew) this.pauseAtSplice();
        else if (paused) toast('Already paused. Say “play” to carry on.', 'muted');
        break;
      case 'cut':
        if (live || paused) this.cut({ before: o.startOut ?? undefined });
        else if (rew) this.cutFurther();
        else toast('Nothing to cut yet. Start rolling first.', 'muted');
        break;
      case 'cutBack':
        if (live || paused) this.cut({ seconds: cmd.seconds });
        else if (rew) this.cutFurther(cmd.seconds);
        break;
      case 'scratch':
        if (st.drawing) this.finishDrawing(null);
        else if (rew) this.abortCut();
        else this.undoLast();
        break;
      case 'hold': {
        const f = cmd.factor ?? st.settings.speed;
        if (ph === 'rolling') this.speed(o.startOut ?? null, f);
        else if (ph === 'hold') cmd.factor && cmd.factor !== st.speed ? this.changeSpeed(cmd.factor) : this.endHold(true);
        else if (paused) {
          this.resume();
          this.speed(null, f);
        }
        break;
      }
      case 'zoom':
        if (cmd.mark) this.zoomTo(cmd.mark);
        else if (live || paused) this.startDrawing('zoom', o.startOut ?? null, cmd.name);
        else toast('Say “zoom in” while recording and draw the area, or name a zoom spot in Setup.', 'muted');
        break;
      case 'wide':
        this.zoomTo(null);
        break;
      case 'redact':
        if (live || paused) this.startDrawing('redact', o.startOut ?? null);
        break;
      case 'unblur':
        this.unblur();
        break;
      case 'chapter':
        if (live || paused) this.addChapter(cmd.name, o.startOut ?? this.outputTime());
        break;
      case 'camera':
        this.setCamera(cmd.on);
        break;
      case 'mic':
        this.setMicMuted(!cmd.on);
        break;
      case 'wrap':
        if (st.drawing) store.set({ drawing: null });
        if (live || rew || paused) this.wrap(o.startOut ?? null);
        break;
    }
  }

  private tryOut(cmd: Command) {
    store.set((s) => ({ tried: { ...s.tried, [cmd.type]: true } }));
    const label =
      cmd.type === 'zoom' ? (cmd.mark ? `Zoom · ${cmd.mark.name}` : 'Zoom in') : cmd.type === 'cutBack' ? `Back ${cmd.seconds} s` : cmd.type === 'hold' ? `Speed up · ${cmd.factor ?? store.get().settings.speed}×` : INTENT_LABEL[cmd.type];
    this.act(cmd.type, label, 'ok');
    this.cue(cmd.type);
  }

  /** A short sound for the big moments (zoom, blur and the like stay quiet). */
  private cue(kind: string) {
    if (kind === 'cut' || kind === 'cutBack') sounds.rewind(0.7);
    else if (kind === 'action') sounds.roll();
    else if (kind === 'play') sounds.play();
    else if (kind === 'pause') sounds.pause();
    else if (kind === 'hold') sounds.speed();
    else if (kind === 'scratch') sounds.undo();
    else if (kind === 'chapter') sounds.pip();
    else if (kind === 'wrap') sounds.chime();
  }

  /** The manual switch: start rolling, or stop and wrap. */
  record() {
    const ph = store.get().phase;
    if (ph === 'idle') this.run({ type: 'action' });
    else if (ph !== 'wrapped') this.run({ type: 'wrap' });
  }

  holdToggle() {
    const ph = store.get().phase;
    if (ph === 'rolling') this.run({ type: 'hold' });
    else if (ph === 'hold') this.run({ type: 'play' });
  }

  pauseToggle() {
    const ph = store.get().phase;
    if (ph === 'paused') this.run({ type: 'play' });
    else if (ph === 'rolling' || ph === 'hold' || ph === 'preroll' || ph === 'rewinding') this.run({ type: 'pause' });
  }

  toggleMic() {
    this.setMicMuted(!store.get().micMuted);
  }

  setMicMuted(m: boolean) {
    store.set({ micMuted: m });
    this.act('mic', m ? 'Mic muted' : 'Mic live', m ? 'rec' : 'ok');
    sounds.blip(m ? 520 : 880);
  }

  // ───────────────────────── recording operations ─────────────────────────

  roll() {
    if (!this.comp.hasScreen) {
      toast('Choose a window in Setup first.', 'rec');
      return;
    }
    if (!this.audio) return;
    // every recording starts empty, whatever happened before
    this.clearRecording();
    store.set({ take: 1, sessionId: uid(), title: '', transcript: null, outtakes: [], ranges: [], chapters: [], duration: 0, log: [], captions: { status: 'idle', progress: 0, detail: null } });
    setFlag('take1.onboarded');
    store.set({ onboarded: true, practice: false });
    this.punchIn(this.ctxTime, { kind: 'action', label: 'Action' });
    this.act('action', 'Action', 'rec');
    this.cue('action');
  }

  /** Play / Action: start, resume after Pause or Speed up, or skip the countdown. */
  private play(isAction = false) {
    const ph = store.get().phase;
    if (ph === 'idle') this.roll();
    else if (ph === 'paused') this.resume();
    else if (ph === 'hold') this.endHold(true);
    else if (ph === 'preroll') this.punchIn(this.ctxTime);
    else if (ph === 'rolling' && !isAction) toast('Already rolling.', 'muted');
  }

  private resume() {
    store.set({ toast: null }); // "Paused. Say play…" is no longer true
    this.punchIn(this.ctxTime, { kind: 'play', label: 'Play' });
    this.act('play', 'Play', 'rec');
    this.cue('play');
  }

  /** Stop recording. Nothing is recorded until Play; the spoken "pause" is trimmed off. */
  private async pause(startOut: number | null, quiet = false) {
    const ph = store.get().phase;
    const tNow = this.outputTime();
    if (ph === 'hold') this.endHold(false);
    if (ph === 'rolling' && startOut !== null && tNow - startOut > 0.15) {
      this.frozen = true;
      this.closeStretch(true);
      this.outBase = tNow;
      store.set({ phase: 'paused' });
      await this.trim(Math.max(this.lastPunch, startOut - 0.05));
      this.frozen = false;
    } else {
      this.closeStretch(false);
      this.outBase = tNow;
      store.set({ phase: 'paused' });
    }
    this.previewCache = null;
    if (!quiet) {
      this.act('pause', 'Paused', 'muted');
      this.cue('pause');
    }
  }

  /** "Pause" while a cut is replaying: stay at the splice point instead of punching in. */
  private pauseAtSplice() {
    this.audio?.stopPlayback();
    this.punchAt = null;
    this.clearTimers('sys');
    this.replay?.dispose();
    this.replay = null;
    this.cutStack = [];
    store.set({ phase: 'paused', countdown: null, matchScore: null, rewind: null });
    this.act('pause', 'Paused at the splice', 'muted');
    this.cue('pause');
  }

  private punchIn(atCtx: number, beat: { kind: string; label: string } | null = null) {
    this.punchAt = null;
    this.clearTimers('sys');
    this.openStretch(1, atCtx);
    this.forceKey = true;
    this.lastPunch = this.outBase;
    this.lastSnapT = -1e9;
    this.cutStack = [];
    this.matchSig = false;
    this.comp.setMatchRef(null);
    this.previewCache = null;
    this.replay?.dispose();
    this.replay = null;
    store.set((s) => ({
      phase: 'rolling',
      countdown: null,
      matchScore: null,
      teleprompter: null,
      rewind: null,
      slateKey: s.slateKey + 1,
      lastAction: beat ? { ...beat, id: ++this.actionN } : { kind: 'punch', label: `Take ${s.take}`, id: ++this.actionN },
    }));
  }

  /** Remove everything after T without a rewind (used to drop a spoken command's dead air). */
  private async trim(T: number) {
    await this.comp.flush();
    this.video.truncate(Math.round(T * 1e6));
    this.pcm.truncate(T * this.pcm.sr);
    releaseSnaps(this.snaps.truncate(T));
    this.scrubs = this.scrubs.filter((s) => s.start < T).map((s) => (s.end > T ? { ...s, end: T } : s));
    this.outBase = T;
    this.lastFrameTs = this.video.lastTs >= 0 ? this.video.lastTs / 1e6 : -1;
    this.forceKey = true; // the encoder's reference frame was just dropped
  }

  private async speed(trimTo: number | null, factor: number) {
    const tNow = this.outputTime();
    if (trimTo !== null && tNow - trimTo > 0.15) {
      this.frozen = true;
      this.closeStretch(true);
      this.outBase = tNow;
      await this.trim(Math.max(this.lastPunch, trimTo - 0.05));
      this.frozen = false;
    } else {
      this.closeStretch(false);
      this.outBase = tNow;
    }
    this.openStretch(1 / factor);
    this.holdStart = { out: this.outBase, ctx: this.resumeCtx };
    store.set({ phase: 'hold', holdBadge: null, speed: factor });
    this.act('hold', `Speed up · ${factor}×`, 'hold');
    this.cue('hold');
  }

  private changeSpeed(factor: number) {
    const t = this.outputTime();
    this.closeStretch(false);
    this.outBase = t;
    this.openStretch(1 / factor);
    store.set({ speed: factor });
    this.act('hold', `Speed · ${factor}×`, 'hold');
    this.cue('hold');
  }

  private endHold(resume: boolean) {
    const t = this.outputTime();
    const hs = this.holdStart;
    this.holdStart = null;
    if (hs) {
      const wall = this.ctxTime - hs.ctx;
      const r: RangeInfo = { id: uid(), kind: 'hold', start: hs.out, end: t, wall, factor: store.get().speed };
      store.set((s) => ({ ranges: [...s.ranges, r], holdBadge: `${Math.round(wall)} s of waiting became ${(t - hs.out).toFixed(1)} s` }));
      this.after(4000, () => store.set({ holdBadge: null }), 'badge');
    }
    if (resume) {
      this.closeStretch(false);
      this.outBase = t;
      this.openStretch(1);
      store.set({ phase: 'rolling' });
      this.act('play', 'Back to normal speed', 'rec');
      this.cue('play');
    }
  }

  private async cut(o: { before?: number; seconds?: number }) {
    const tCut = this.outputTime();
    if (store.get().phase === 'hold') this.endHold(false);
    this.closeStretch(true);
    store.set({ phase: 'rewinding' });
    this.outBase = tCut;
    let T: number;
    if (o.seconds) T = tCut - o.seconds;
    else {
      const before = Math.min(o.before ?? tCut, tCut);
      const s = this.pcm.speechStart(before, this.thr);
      if (s === null) {
        // no sentence found (mic muted or silent): never throw away the whole take, step back 5 s
        T = Math.max(this.lastPunch, tCut - 5);
        toast('Didn’t hear a sentence, so I went back 5 s.', 'muted');
      } else T = s;
    }
    this.act(o.seconds ? 'cutBack' : 'cut', o.seconds ? `Back ${o.seconds} s` : 'Cut', 'cue');
    await this.performCut(T, tCut);
  }

  private async cutFurther(seconds?: number) {
    this.audio?.stopPlayback();
    this.punchAt = null;
    this.clearTimers('sys');
    const T0 = this.outBase;
    store.set({ phase: 'rewinding', countdown: null });
    const T = seconds ? T0 - seconds : (this.pcm.speechStart(T0 - 0.05, this.thr) ?? Math.max(0, T0 - 5));
    if (T0 < 0.05) toast('Already at the start of the recording.', 'muted');
    this.act('cut', seconds ? `Back ${seconds} s more` : 'One more line', 'cue');
    await this.performCut(T, T0);
  }

  private viewAt(t: number): Rect {
    let v: Rect = this.comp.viewFor(null);
    for (const h of this.viewHistory) if (h.t <= t + 0.01) v = h.view;
    return v;
  }

  private async performCut(T: number, tEnd: number) {
    T = Math.max(0, Math.min(T, tEnd));
    if (tEnd - T > 0.05) {
      // back off a beat, then land on the quietest 10 ms nearby so the splice is inaudible
      T = Math.max(0, T - 0.08);
      T = this.pcm.quietestPoint(Math.max(0, T - 0.15), Math.min(T + 0.04, tEnd));
    }
    await this.comp.flush();
    const sr = this.pcm.sr;
    const st = store.get();
    let removedAudio: Float32Array | null = null;
    let otId: string | null = null;
    if (tEnd - T > 0.05) {
      const { removed, prefix } = this.video.truncate(Math.round(T * 1e6));
      const audio = this.pcm.read(T * sr, tEnd * sr);
      removedAudio = audio;
      this.pcm.truncate(T * sr);
      const snaps = this.snaps.truncate(T);
      const saved = { ranges: st.ranges, chapters: st.chapters, scrubs: this.scrubs, viewHistory: this.viewHistory, take: st.take };
      this.scrubs = this.scrubs.filter((s) => s.start < T).map((s) => (s.end > T ? { ...s, end: T } : s));
      this.viewHistory = this.viewHistory.filter((v) => v.t < T);
      const ot: Outtake = { id: uid(), take: st.take, from: T, to: tEnd, prefix, chunks: removed, audio, snaps, saved };
      otId = ot.id;
      this.outtakes.push(ot);
      this.cutStack.push(ot);
      store.set((s) => ({
        ranges: s.ranges.filter((r) => r.start < T).map((r) => (r.end > T && !r.open ? { ...r, end: T } : r)),
        chapters: s.chapters.filter((c) => c.t < T),
        outtakes: [...s.outtakes, { id: ot.id, take: ot.take, from: T, to: tEnd, text: '', thumb: snaps[0]?.url ?? this.snaps.at(T)?.url ?? null }],
        take: s.take + 1,
        teleprompter: null,
      }));
    }
    this.outBase = T;
    this.lastFrameTs = this.video.lastTs >= 0 ? this.video.lastTs / 1e6 : -1;
    this.comp.setView(this.viewAt(T), true);
    store.set({ rewind: { from: tEnd, to: T }, holdBadge: null });
    sounds.rewind(1.1);

    // build the replay while the rewind plays
    this.replay?.dispose();
    this.replay = null;
    const R = Math.min(store.get().settings.replaySeconds, T);
    if (R > 0.2 && this.video.decoderConfig) {
      Replay.build(this.video.decoderConfig, this.video.chunks, T - R, T)
        .then((r) => {
          if (this.outBase === T && ['rewinding', 'preroll'].includes(store.get().phase)) this.replay = r;
          else r.dispose();
        })
        .catch(() => {});
    }
    // what you said in the fluffed line → teleprompter + outtake label
    if (removedAudio && otId && stt.ready.command) {
      const id = otId;
      stt
        .command(to16k(removedAudio.subarray(0, sr * 12), sr))
        .then((text) => {
          const clean = text.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim();
          store.set((s) => ({
            outtakes: s.outtakes.map((o) => (o.id === id ? { ...o, text: clean } : o)),
            teleprompter: ['rewinding', 'preroll'].includes(s.phase) ? clean || null : s.teleprompter,
          }));
        })
        .catch(() => {});
    }
    this.after(1150, () => this.startPreroll(), 'sys');
  }

  private startPreroll() {
    if (store.get().phase !== 'rewinding' || !this.audio) return;
    const T = this.outBase;
    const st = store.get().settings;
    const R = Math.min(st.replaySeconds, T);
    const total = Math.max(st.countdown, R > 0.2 ? R : 0);
    this.prerollTotal = total;
    this.punchAt = this.ctxTime + total;
    store.set({ phase: 'preroll', countdown: total <= st.countdown ? st.countdown : null, matchScore: null, rewind: null });
    this.matchSig = false;
    const snap = this.snaps.at(T - 0.05);
    if (snap && !this.replay) {
      this.matchSig = true;
      this.comp.setMatchRef(snap.blob);
    }
    if (st.prerollAudio && R > 0.2) {
      const s = this.pcm.read((T - R) * this.pcm.sr, T * this.pcm.sr);
      this.audio.play(s, this.punchAt - R, 1);
    }
  }

  private abortCut() {
    if (!this.cutStack.length) return;
    this.audio?.stopPlayback();
    this.punchAt = null;
    this.clearTimers('sys');
    const stack = this.cutStack;
    this.cutStack = [];
    const sr = this.pcm.sr;
    for (let i = stack.length - 1; i >= 0; i--) {
      const o = stack[i];
      this.video.restore(o.chunks);
      this.pcm.write(o.from * sr, o.audio);
      this.snaps.restore(o.snaps);
    }
    const first = stack[0];
    this.scrubs = first.saved.scrubs;
    this.viewHistory = first.saved.viewHistory;
    this.outtakes = this.outtakes.filter((o) => !stack.includes(o));
    const ids = new Set(stack.map((o) => o.id));
    store.set((s) => ({
      ranges: first.saved.ranges,
      chapters: first.saved.chapters,
      take: first.saved.take,
      outtakes: s.outtakes.filter((o) => !ids.has(o.id)),
    }));
    this.outBase = first.to;
    this.lastFrameTs = this.video.lastTs >= 0 ? this.video.lastTs / 1e6 : -1;
    this.comp.setView(this.viewAt(first.to), true);
    this.act('scratch', 'Cut cancelled', 'muted');
    this.cue('scratch');
    this.punchIn(this.ctxTime);
  }

  /**
   * "Blur that" / "zoom in": pause recording and let you drag a box over the frame you
   * were showing. Blur covers the 5 s before you asked (and can keep going); zoom
   * eases in when you press Play.
   */
  private async startDrawing(kind: 'redact' | 'zoom', startOut: number | null, name?: string) {
    const ph = store.get().phase;
    if (ph === 'rolling' || ph === 'hold') await this.pause(startOut, true);
    const img = (await this.comp.freeze(kind === 'redact' ? 'output' : 'source')) ?? (await this.comp.freeze('output'));
    if (!img) return toast('Couldn’t grab the frame. Is the window still shared?', 'rec');
    store.set({ drawing: { kind, image: img.url, aspect: img.aspect, at: this.outBase, name } });
    this.act(kind, kind === 'redact' ? 'Blur · drag over it' : 'Zoom · drag the area', kind === 'redact' ? 'redact' : 'ok');
    native?.showMain();
  }

  finishDrawing(rect: Rect | null, opts: { keep?: boolean; name?: string } = {}) {
    const d = store.get().drawing;
    if (!d) return;
    store.set({ drawing: null });
    if (native) native.hideMain();
    if (!rect || rect.w < 0.01 || rect.h < 0.01) {
      this.act('scratch', d.kind === 'redact' ? 'No blur added' : 'No zoom', 'muted');
      return;
    }
    if (d.kind === 'redact') {
      const r: RangeInfo = { id: uid(), kind: 'redact', start: Math.max(0, d.at - 5), end: opts.keep ? 1e9 : d.at, rect, open: !!opts.keep };
      store.set((s) => ({ ranges: [...s.ranges, r] }));
      this.undo.push({ label: 'blur', fn: () => store.set((s) => ({ ranges: s.ranges.filter((x) => x.id !== r.id) })) });
      this.act('redact', opts.keep ? 'Blurring until “unblur”' : 'Blurred the last 5 s', 'redact');
    } else {
      const name = opts.name?.trim();
      const m: StageMark = name ? this.addMark(name, rect) : { id: uid(), name: 'Zoom', rect };
      this.zoomTo(m);
    }
    toast('Paused. Say “play” (or press Play) when you’re ready.', 'muted');
  }

  private unblur() {
    const open = store.get().ranges.filter((r) => r.kind === 'redact' && r.open);
    if (!open.length) return toast('Nothing is being blurred.', 'muted');
    const t = this.outputTime();
    store.set((s) => ({ ranges: s.ranges.map((r) => (r.open ? { ...r, end: Math.max(r.start + 0.5, t), open: false } : r)) }));
    this.act('unblur', 'Blur ended', 'muted');
  }

  private addChapter(name: string, t: number) {
    const c = { id: uid(), t: Math.max(0, t), name: name || `Chapter ${store.get().chapters.length + 2}` };
    store.set((s) => ({ chapters: [...s.chapters, c].sort((a, b) => a.t - b.t) }));
    this.undo.push({ label: 'chapter', fn: () => store.set((s) => ({ chapters: s.chapters.filter((x) => x.id !== c.id) })) });
    this.act('chapter', `Chapter · ${c.name}`, 'ok');
    this.cue('chapter');
  }

  setCamera(on: boolean, record = true) {
    const prev = this.comp.cameraOn;
    this.comp.setCamera(on);
    store.set({ cameraOn: on });
    if (record) {
      this.undo.push({ label: 'camera', fn: () => this.setCamera(prev, false) });
      this.act('camera', on ? 'Camera on' : 'Camera off', 'muted');
    }
  }

  private undoLast() {
    const u = this.undo.pop();
    if (!u) return toast('Nothing to undo.', 'muted');
    u.fn();
    this.act('scratch', `Undid ${u.label}`, 'muted');
    this.cue('scratch');
  }

  private async wrap(startOut: number | null) {
    const ph = store.get().phase;
    let tEnd = this.outputTime();
    if (ph === 'hold') this.endHold(false);
    if (ph === 'paused') startOut = null;
    if (ph === 'preroll' || ph === 'rewinding') {
      this.audio?.stopPlayback();
      this.punchAt = null;
      this.clearTimers('sys');
      tEnd = this.outBase;
    } else if (startOut !== null) {
      tEnd = Math.max(Math.min(startOut - 0.05, tEnd), Math.min(tEnd, this.lastPunch + 0.2));
    }
    this.closeStretch(true);
    this.outBase = tEnd;
    store.set({ phase: 'wrapped' });
    this.act('wrap', 'That’s a wrap', 'rec');
    // delivers the last chunks, then frees the encoder (sharing a window again makes a new one)
    await this.comp.release();
    this.video.truncate(Math.round(tEnd * 1e6));
    this.pcm.truncate(tEnd * this.pcm.sr);
    releaseSnaps(this.snaps.truncate(tEnd));
    this.scrubs = this.scrubs.filter((s) => s.start < tEnd).map((s) => (s.end > tEnd ? { ...s, end: tEnd } : s));
    this.replay?.dispose();
    this.replay = null;
    const last = this.video.chunks[this.video.chunks.length - 1];
    const duration = last ? (last.ts + (last.dur || FD * 1e6)) / 1e6 : tEnd;
    this.cue('wrap');
    this.screenStream?.getTracks().forEach((t) => t.stop());
    native?.showMain();
    store.set((s) => ({
      screen: 'review',
      duration,
      activeMark: null,
      rewind: null,
      countdown: null,
      teleprompter: null,
      hasScreen: false,
      transcript: null,
      ranges: s.ranges.filter((r) => r.start < tEnd).map((r) => (r.end > tEnd ? { ...r, end: tEnd, open: false } : r)),
      drawing: null,
      chapters: s.chapters.filter((c) => c.t < tEnd),
    }));
  }

  /** Empty the recorded video, audio and every edit (keeps the window, mic, zoom spots and settings). */
  private clearRecording() {
    this.audio?.stopPlayback();
    this.clearTimers('sys');
    this.punchAt = null;
    this.replay?.dispose();
    this.replay = null;
    this.video.clear();
    this.pcm = new PcmBuffer(SAMPLE_RATE);
    this.snaps.dispose();
    this.outtakes.forEach((o) => releaseSnaps(o.snaps));
    this.snaps = new Snapshots();
    this.scrubs = [];
    this.outtakes = [];
    this.cutStack = [];
    this.undo = [];
    this.viewHistory = [];
    this.stretches = [];
    this.holdStart = null;
    this.outBase = 0;
    this.lastPunch = 0;
    this.lastFrameTs = -1;
    this.lastSnapT = -1e9;
    this.previewCache = null;
    this.exportCache = null;
  }

  /** Clear everything for a fresh recording and go back to Setup. */
  reset() {
    this.clearRecording();
    store.set({ phase: 'idle', take: 1, outtakes: [], ranges: [], chapters: [], duration: 0, log: [], transcript: null, transcribing: false, screen: 'setup', sessionId: '', title: '', drawing: null, captions: { status: 'idle', progress: 0, detail: null } });
  }

  // ───────────────────────── review + export ─────────────────────────

  /** Local Whisper over the final cut: transcript, captions and post copy. Runs when you ask for it. */
  async transcribe() {
    const st = store.get();
    if (st.transcribing) return st.transcript;
    if (st.transcript?.length) return st.transcript;
    store.set({ transcribing: true, captions: { status: stt.ready.transcript ? 'transcribing' : 'downloading', progress: 0, detail: null } });
    try {
      const sr = this.pcm.sr;
      const raw = this.pcm.read(0, Math.round(st.duration * sr));
      for (const s of this.scrubs) raw.fill(0, Math.max(0, Math.round(s.start * sr)), Math.min(raw.length, Math.round(s.end * sr)));
      let e = 0;
      for (let i = 0; i < raw.length; i += 16) e += raw[i] * raw[i];
      if (!raw.length || Math.sqrt(e / Math.max(1, raw.length / 16)) < 0.0004) throw new Error('This take has no audible audio. Check the microphone in Setup.');
      const chunks = await stt.transcribe(to16k(raw, sr), (p) => store.set({ captions: { status: 'transcribing', progress: p, detail: null } }));
      const lines = chunks
        .map((c, i) => ({
          start: c.start,
          end: Math.min(st.duration, c.end ?? chunks[i + 1]?.start ?? c.start + 3),
          text: c.text.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(),
          ...(c.words?.length ? { words: c.words.map((w) => ({ text: w.text, start: Math.min(st.duration, w.start), end: Math.min(st.duration, w.end) })) } : {}),
        }))
        .filter((l) => l.text && !/^(you|thank you\.?|\.+)$/i.test(l.text));
      const chapters = store.get().chapters.length ? null : suggestChapters(lines, st.duration).map((c) => ({ ...c, id: uid(), auto: true }));
      store.set({
        transcript: lines,
        transcribing: false,
        ...(chapters?.length ? { chapters } : {}),
        captions: { status: lines.length ? 'ready' : 'error', progress: 1, detail: lines.length ? null : 'No speech found in this take. Was the right microphone selected?' },
      });
      if (st.sessionId && lines.length) library.update(st.sessionId, { transcript: lines, chapters: store.get().chapters.map((c) => ({ t: c.t, name: c.name })) });
      return lines;
    } catch (e) {
      store.set({ transcript: null, transcribing: false, captions: { status: 'error', progress: 0, detail: String((e as Error)?.message ?? e) } });
      return null;
    }
  }

  /** Re-suggest chapters from the transcript (Review → Chapters). */
  suggestChapters() {
    const st = store.get();
    if (!st.transcript?.length) return;
    store.set({ chapters: suggestChapters(st.transcript, st.duration).map((c) => ({ ...c, id: uid(), auto: true })) });
  }

  addChapterAt(t: number) {
    const st = store.get();
    const c = { id: uid(), t: Math.max(0, Math.min(t, st.duration)), name: "New chapter" };
    store.set({ chapters: [...st.chapters, c].sort((a, b) => a.t - b.t) });
  }

  private keptAudio() {
    return this.pcm.read(0, Math.round(store.get().duration * this.pcm.sr));
  }

  private chaptersForFile() {
    const st = store.get();
    const list = [...st.chapters].filter((c) => c.t < st.duration).sort((a, b) => a.t - b.t);
    if (list.length && list[0].t > 0.5) list.unshift({ id: 'start', t: 0, name: 'Start' });
    return list.map((c, i) => ({ t: i === 0 ? 0 : c.t, name: c.name || `Chapter ${i + 1}` }));
  }

  /** Quick MP4 for Review: the recorded chunks copied as they are (no re-encode). */
  async previewMp4() {
    if (this.previewCache) return this.previewCache;
    const blob = await buildVideo({
      width: this.comp.W,
      height: this.comp.H,
      codec: this.video.codec,
      config: this.video.decoderConfig,
      clips: [{ chunks: this.video.chunks, from: 0, to: Infinity }],
      render: false,
      redactions: [],
      captions: [],
      captionStyle: null,
      captionFont: null,
      pcm: this.keptAudio(),
      sampleRate: this.pcm.sr,
      scrubs: this.scrubs,
      level: true,
      chapters: [],
    });
    this.previewCache = URL.createObjectURL(blob);
    return this.previewCache;
  }

  /** Final file. Re-encodes only when something must be drawn in (blur boxes, captions). */
  async exportFinal(onProgress?: (p: number) => void, opts: { captions?: CaptionStyle | null } = {}) {
    const st = store.get();
    if (!this.video.chunks.length) throw new Error('There’s nothing recorded to export yet.');
    const redactions = st.ranges.filter((r) => r.kind === 'redact' && r.rect).map((r) => ({ start: r.start, end: r.end, rect: r.rect! }));
    const style = opts.captions && st.transcript?.length ? opts.captions : null;
    const captions = style ? buildTrack(st.transcript!, style) : [];
    const key = JSON.stringify([st.sessionId, st.duration, this.video.chunks.length, this.scrubs, redactions, captions, style, this.chaptersForFile()]);
    if (this.exportCache?.key === key) {
      onProgress?.(1);
      return { blob: this.exportCache.blob, url: URL.createObjectURL(this.exportCache.blob), cached: true };
    }
    // never sit on a frozen progress ring: if nothing moves for 30 s, fail loudly
    let last = performance.now();
    let watch: ReturnType<typeof setInterval> | null = null;
    const stalled = new Promise<never>((_, reject) => {
      watch = setInterval(() => performance.now() - last > 30000 && reject(new Error('Export stopped making progress. Go back to Review and try again.')), 2000);
    });
    try {
      const job = buildVideo(
        {
          width: this.comp.W,
          height: this.comp.H,
          codec: this.video.codec,
          config: this.video.decoderConfig,
          clips: [{ chunks: this.video.chunks, from: 0, to: Math.round(st.duration * 1e6) + 1 }],
          render: redactions.length > 0 || captions.length > 0,
          redactions,
          captions,
          captionStyle: style,
          captionFont: style ? fontFile(style.font) : null,
          pcm: this.keptAudio(),
          sampleRate: this.pcm.sr,
          scrubs: this.scrubs,
          level: true,
          chapters: this.chaptersForFile(),
        },
        (p) => {
          last = performance.now();
          onProgress?.(p);
        },
      );
      const blob = await Promise.race([job, stalled]);
      onProgress?.(1);
      this.exportCache = { key, blob };
      await this.saveToLibrary(blob, captions.length > 0);
      return { blob, url: URL.createObjectURL(blob), cached: false };
    } finally {
      if (watch) clearInterval(watch);
    }
  }

  /** Every export lands in your Library (re-exports of the same recording update it). */
  private async saveToLibrary(video: Blob, captionsBurned: boolean) {
    const st = store.get();
    if (!st.sessionId) return;
    const notSaved = 'isn’t in your Library: there isn’t enough storage. It’s still here, so Download or Save it now.';
    try {
      // check the quota first rather than failing halfway through a large write
      const est = await navigator.storage?.estimate?.();
      if (est?.quota && est.usage !== undefined && est.quota - est.usage < video.size * 1.1) {
        toast(`This video ${notSaved}`, 'rec');
        return;
      }
      const prev = await library.getMeta(st.sessionId);
      const sped = st.ranges.filter((r) => r.kind === 'hold').reduce((a, r) => a + (r.wall ?? 0) - (r.end - r.start), 0);
      await library.save(
        {
          id: st.sessionId,
          title: st.title || prev?.title || 'Untitled recording',
          createdAt: prev?.createdAt ?? Date.now(),
          duration: st.duration,
          retakes: st.outtakes.length,
          held: sped,
          thumb: this.snaps.at(st.duration * 0.3)?.blob ?? null,
          transcript: st.transcript ?? prev?.transcript ?? null,
          chapters: st.chapters.map((c) => ({ t: c.t, name: c.name })),
          captionsBurned,
          seen: prev?.seen ?? false,
          size: video.size,
        },
        video,
      );
    } catch (e) {
      toast((e as DOMException)?.name === 'QuotaExceededError' ? `This video ${notSaved}` : 'Couldn’t save to your Library (storage is blocked). Download or Save the video now.', 'rec');
    }
  }

  setTitle(title: string) {
    store.set({ title });
    const id = store.get().sessionId;
    this.clearTimers('title');
    if (id) this.after(600, () => library.update(id, { title: title || 'Untitled recording' }), 'title');
  }

  /** Play back removed lines (one, or all of them back to back with labels). */
  async renderOuttakes(ids: string[], onProgress?: (p: number) => void) {
    const list = this.outtakes.filter((o) => ids.includes(o.id));
    if (!list.length || !this.video.decoderConfig) return null;
    const sr = this.pcm.sr;
    const pcm = new Float32Array(list.reduce((a, o) => a + o.audio.length, 0));
    let p = 0;
    const fade = Math.round(sr * 0.02);
    for (const o of list) {
      const a = o.audio.slice();
      for (let i = 0; i < fade && i < a.length; i++) {
        a[i] *= i / fade;
        a[a.length - 1 - i] *= i / fade;
      }
      pcm.set(a, p);
      p += a.length;
    }
    const blob = await buildVideo(
      {
        width: this.comp.W,
        height: this.comp.H,
        codec: this.video.codec,
        config: this.video.decoderConfig,
        clips: list.map((o) => ({ chunks: [...o.prefix, ...o.chunks], from: Math.round(o.from * 1e6), to: Math.round(o.to * 1e6), label: list.length > 1 ? `Removed line ${o.take}` : undefined })),
        render: true,
        redactions: [],
        captions: [],
        captionStyle: null,
        captionFont: null,
        pcm,
        sampleRate: sr,
        scrubs: [],
        level: true,
        chapters: [],
      },
      onProgress,
    );
    return URL.createObjectURL(blob);
  }

  snapAt(t: number) {
    return this.snaps.at(t);
  }
}

/** Chrome labels captures with internal ids ("web-contents-media-stream://7F40…"); show something human. */
/** Give a new floating window Take1's styles and an empty root to render into. */
function prepWindow(w: Window, htmlClass: string, rootId: string) {
  [...document.styleSheets].forEach((ss) => {
    try {
      const css = [...ss.cssRules].map((r) => r.cssText).join('\n');
      const st = w.document.createElement('style');
      st.textContent = css;
      w.document.head.appendChild(st);
    } catch {
      if (ss.href) {
        const l = w.document.createElement('link');
        l.rel = 'stylesheet';
        l.href = ss.href;
        w.document.head.appendChild(l);
      }
    }
  });
  w.document.title = 'Take1';
  w.document.documentElement.className = htmlClass;
  w.document.body.className = 'fc-body';
  const root = w.document.createElement('div');
  root.id = rootId;
  w.document.body.appendChild(root);
  return root;
}

function friendlySource(label: string, surface: string | null) {
  if (!label || /^web-contents-media-stream:/i.test(label)) return surface === 'browser' || /^web-contents/.test(label) ? 'A browser tab' : 'Shared window';
  if (/^screen:/i.test(label) || surface === 'monitor') return 'Entire screen';
  if (/^window:\d/i.test(label)) return 'Shared window';
  // an opaque id rather than a window title
  if (!/\s/.test(label) && label.length > 24) return 'Shared window';
  return label;
}

// ───────────────────────── keyboard (in-app; the desktop shell adds global ones) ─────────────────────────

const TALK_MODS: Record<string, { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; code?: string }> = {
  'Ctrl+Shift': { ctrl: true, alt: false, shift: true, meta: false },
  'Ctrl+Win': { ctrl: true, alt: false, shift: false, meta: true },
  'Alt+Shift': { ctrl: false, alt: true, shift: true, meta: false },
  RightCtrl: { ctrl: true, alt: false, shift: false, meta: false, code: 'ControlRight' },
};
const MODIFIER = /^(Control|Shift|Alt|Meta|OS)$/;
let talkTimer: ReturnType<typeof setTimeout> | null = null;
let talking = false;

function matches(e: KeyboardEvent, accel: string) {
  const parts = accel.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const need = { ctrl: parts.includes('ctrl') || parts.includes('control') || parts.includes('commandorcontrol'), alt: parts.includes('alt'), shift: parts.includes('shift'), meta: parts.includes('super') || parts.includes('cmd') };
  if (e.ctrlKey !== need.ctrl || e.altKey !== need.alt || e.shiftKey !== need.shift || e.metaKey !== need.meta) return false;
  const k = e.code.toLowerCase();
  return key === 'space' ? k === 'space' : k === `key${key}` || k === `digit${key}` || e.key.toLowerCase() === key;
}

function trackKeys(e: KeyboardEvent) {
  const k = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
  const cur = store.get().keysDown;
  if (k.ctrl !== cur.ctrl || k.shift !== cur.shift || k.alt !== cur.alt || k.meta !== cur.meta) store.set({ keysDown: k });
}

export function keyHandler(e: KeyboardEvent) {
  trackKeys(e);
  if (e.key === 'Escape') return recorder.cancelCommand();
  if (native) return; // global keys (incl. the talk key) come from the shell's keyboard hook
  const combo = TALK_MODS[store.get().talkKey];
  if (MODIFIER.test(e.key)) {
    const exact = combo && e.ctrlKey === combo.ctrl && e.altKey === combo.alt && e.shiftKey === combo.shift && e.metaKey === combo.meta && (!combo.code || e.code === combo.code);
    if (exact && !talking && !talkTimer && !e.repeat) {
      // a short grace period so Ctrl+Shift+T and friends don't open a session
      talkTimer = setTimeout(() => {
        talkTimer = null;
        talking = true;
        recorder.commandDown();
      }, 140);
    }
    return;
  }
  // a real key pressed while holding the talk keys = it was a shortcut, not a command
  if (talkTimer) {
    clearTimeout(talkTimer);
    talkTimer = null;
  }
  if (talking) {
    talking = false;
    recorder.cancelCommand();
  }
  const sc = store.get().shortcuts;
  for (const [name, accel] of Object.entries(sc)) {
    if (matches(e, accel)) {
      e.preventDefault();
      recorder.hotkey(name);
      return;
    }
  }
}

/** Window lost focus mid-hold (alt-tab): treat it as releasing the keys. */
export function releaseKeys() {
  store.set({ keysDown: { ctrl: false, shift: false, alt: false, meta: false } });
  if (talkTimer) {
    clearTimeout(talkTimer);
    talkTimer = null;
  }
  if (talking) {
    talking = false;
    recorder.commandUp();
  }
}

export function keyUpHandler(e: KeyboardEvent) {
  trackKeys(e);
  if (native || !MODIFIER.test(e.key)) return;
  if (talkTimer) {
    clearTimeout(talkTimer);
    talkTimer = null;
  }
  if (talking) {
    talking = false;
    recorder.commandUp();
  }
}

export const recorder = new Recorder();
(window as any).take1 = recorder;
(window as any).take1Store = store;

// The recorder owns the live recording. Hot-swapping it would leave the UI pointing at an empty recorder,
// so any code change that reaches this module reloads the page instead.
(import.meta as any).hot?.decline();
