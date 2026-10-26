import { store, pushLog, toast, uid, DEFAULT_SHORTCUTS, type Rect, type StageMark, type RangeInfo, type Tone } from '../lib/store';
import { native } from '../lib/native';
import { library } from '../lib/library';
import { toCues } from '../features/packet';
import { AudioEngine, PcmTape, SAMPLE_RATE } from './audio';
import { Compositor, signature, matchScore } from './compositor';
import { VideoTape, type Chunk } from './videoTape';
import { Snapshots, type Snap } from './snapshots';
import { Replay } from './replay';
import { createTicker } from './ticker';
import { buildMp4, encodeAudio, processAudio, renderClips, type Clip } from './exporter';
import { interpret, INTENT_LABEL, type Command } from '../voice/intent';
import { stt, to16k } from '../voice/stt';
import { listenOnce, webSpeechAvailable } from '../voice/recognizer';
import { sounds, bindSounds, setSoundsEnabled } from '../ui/sounds';

/**
 * The Director turns intents (voice, hotkeys, buttons) into tape edits.
 *
 * Two clocks:
 *  - AudioContext time ("ctx"): when things physically happened.
 *  - Tape time: where they land in the final video. It only advances while Rolling
 *    (1/8 speed during Hold) and jumps back on a Cut.
 * A "stretch" maps one run of ctx time onto tape time; audio blocks are placed on
 * the tape through the stretch that was live when they were captured.
 *
 * Nothing listens for commands until you ask it to: a hotkey or a click opens a
 * short command session, which ends on its own after you stop speaking.
 */

interface Stretch {
  ctxStart: number;
  ctxEnd: number | null;
  tapeStart: number;
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
  startTape: number | null;
  buf: Float32Array[];
  speech: boolean;
  lastLoud: number;
  web?: { stop: () => void };
}

const FPS = 30;
const FD = 1 / FPS;

export class Director {
  audio: AudioEngine | null = null;
  comp = new Compositor();
  video = new VideoTape(FPS, 5_000_000);
  pcm = new PcmTape(SAMPLE_RATE);
  snaps = new Snapshots();
  screenStream: MediaStream | null = null;
  cameraStream: MediaStream | null = null;
  pillWin: Window | null = null;
  pillRoot: HTMLElement | null = null;
  onName: ((name: string) => void) | null = null;
  replay: Replay | null = null;

  private ticker: { stop: () => void } | null = null;
  private tapeBase = 0;
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
  private holdStart: { tape: number; ctx: number } | null = null;
  private timers: { at: number; fn: () => void; tag: string }[] = [];
  private matchSig: Float32Array | null = null;
  private tickN = 0;
  private actionN = 0;
  private session: Session | null = null;

  scrubs: { start: number; end: number }[] = [];
  outtakes: Outtake[] = [];
  private cutStack: Outtake[] = [];
  private undo: { label: string; fn: () => void }[] = [];
  private viewHistory: { t: number; view: Rect }[] = [];
  private previewCache: string | null = null;

  constructor() {
    if (native) {
      native.onHotkey((name) => this.hotkey(name));
      native.getShortcuts().then((s) => {
        if (!s) return;
        const { talk, ...rest } = s as Record<string, string>;
        store.set({ shortcuts: { ...DEFAULT_SHORTCUTS, ...rest }, ...(talk ? { talkKey: talk } : {}) });
      });
      native.talkStatus().then((ok) => store.set({ talkHook: ok }));
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
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false } as any);
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
    await this.video.configure(this.comp.W, this.comp.H);
    this.startTicker();
    store.set({ hasScreen: true, surface: surface ?? s.displaySurface ?? null, sourceName: name ?? track.label ?? null });
    track.addEventListener('ended', () => {
      store.set({ hasScreen: false });
      if (['rolling', 'hold'].includes(store.get().phase)) toast('Window sharing stopped. Wrap, or share again.', 'rec');
    });
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
      this.comp.cameraOn = true;
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
    this.viewHistory.push({ t: this.tapeNow(), view: v });
    store.set({ activeMark: mark?.id ?? null });
    if (record) {
      this.undo.push({
        label: 'zoom',
        fn: () => {
          this.comp.setView(prev);
          this.viewHistory.push({ t: this.tapeNow(), view: prev });
          store.set({ activeMark: prevActive });
        },
      });
      this.act(mark ? 'zoom' : 'wide', mark ? `Zoom · ${mark.name}` : 'Wide', 'ok');
    }
  }

  // ───────────────────────── pill surface ─────────────────────────

  /**
   * Desktop: a transparent, always-on-top window the shell excludes from screen
   * capture. Browser: a Document Picture-in-Picture window (needs a click).
   */
  async openPill() {
    if (this.pillWin && !this.pillWin.closed) return true;
    let w: Window | null = null;
    if (native) w = window.open('about:blank', 'take1-pill');
    else {
      const dpip = (window as any).documentPictureInPicture;
      if (!dpip) {
        toast('The floating pill needs Chrome or Edge 116+. Use the desktop app for a system-wide pill.', 'muted');
        return false;
      }
      w = await dpip.requestWindow({ width: 460, height: 320 });
    }
    if (!w) return false;
    [...document.styleSheets].forEach((ss) => {
      try {
        const css = [...ss.cssRules].map((r) => r.cssText).join('\n');
        const st = w!.document.createElement('style');
        st.textContent = css;
        w!.document.head.appendChild(st);
      } catch {
        if (ss.href) {
          const l = w!.document.createElement('link');
          l.rel = 'stylesheet';
          l.href = ss.href;
          w!.document.head.appendChild(l);
        }
      }
    });
    w.document.title = 'Take1';
    w.document.documentElement.className = native ? 'pill-native' : 'pill-pip';
    w.document.body.className = 'pill-body';
    const root = w.document.createElement('div');
    root.id = 'pill-root';
    w.document.body.appendChild(root);
    w.addEventListener('keydown', (e) => keyHandler(e));
    w.addEventListener('keyup', (e) => keyUpHandler(e));
    w.addEventListener('blur', () => releaseKeys());
    this.pillWin = w;
    this.pillRoot = root;
    store.set({ pillOpen: true });
    return true;
  }

  closePill() {
    this.pillWin?.close();
    this.pillWin = null;
    this.pillRoot = null;
    store.set({ pillOpen: false });
  }

  togglePill() {
    if (store.get().pillOpen) this.closePill();
    else this.openPill();
  }

  // ───────────────────────── clocks ─────────────────────────

  tapeNow() {
    const ph = store.get().phase;
    if (!this.frozen && (ph === 'rolling' || ph === 'hold')) return this.tapeBase + Math.max(0, this.ctxTime - this.resumeCtx) * this.rate;
    return this.tapeBase;
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
    this.stretches.push({ ctxStart: at, ctxEnd: null, tapeStart: this.tapeBase, rate });
  }

  private after(ms: number, fn: () => void, tag = 'sys') {
    this.timers.push({ at: performance.now() + ms, fn, tag });
  }

  private clearTimers(tag: string) {
    this.timers = this.timers.filter((t) => t.tag !== tag);
  }

  private act(kind: string, label: string, tone: Tone, detail?: string) {
    store.set({ lastAction: { kind, label, id: ++this.actionN } });
    pushLog({ kind, label, tone, detail, at: this.tapeNow() });
  }

  // ───────────────────────── capture loop ─────────────────────────

  private onAudio(s: Float32Array, t: number) {
    const ses = this.session;
    if (ses && !ses.web) {
      ses.buf.push(s.slice());
      let e = 0;
      for (let i = 0; i < s.length; i++) e += s[i] * s[i];
      if (Math.sqrt(e / s.length) > this.thr * 1.15) {
        ses.speech = true;
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
      this.pcm.write((st.tapeStart + (a - st.ctxStart)) * sr, s.subarray(i0, i1));
    }
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
    if (this.audio && this.tickN % 2 === 0) {
      const lv = Math.min(1, this.audio.level * 6);
      if (Math.abs(lv - store.get().micLevel) > 0.01) store.set({ micLevel: lv });
    }
    if (this.tickN % 30 === 0 && this.pillWin?.closed) {
      this.pillWin = null;
      this.pillRoot = null;
      store.set({ pillOpen: false });
    }
    this.sessionTick();
    this.comp.draw(now);
    const ph = store.get().phase;
    if (ph === 'rolling' || ph === 'hold') this.captureFrame();
    else if (ph === 'preroll') this.prerollTick();
  }

  private captureFrame() {
    if (this.frozen || !this.comp.hasScreen || this.video.busy) return;
    const t = this.tapeNow();
    if (this.lastFrameTs >= 0 && t - this.lastFrameTs < FD * 0.95) return;
    let ts = Math.round(t * 1e6);
    if (this.lastFrameTs >= 0) ts = Math.max(ts, Math.round(this.lastFrameTs * 1e6) + 1);
    const vf = new VideoFrame(this.comp.canvas, { timestamp: ts, duration: Math.round(FD * 1e6) });
    this.video.encode(vf, this.forceKey); // forced I-frame on the first frame of every take
    vf.close();
    this.forceKey = false;
    this.lastFrameTs = ts / 1e6;
    if (t - this.lastSnapT >= 0.5) {
      this.lastSnapT = t;
      this.snaps.capture(this.comp.canvas, t, { ...this.comp.target });
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
    if (this.tickN % 5 === 0) {
      if (!this.matchSig && this.replay?.last) this.matchSig = signature(this.replay.last);
      if (this.matchSig) store.set({ matchScore: matchScore(this.matchSig, signature(this.comp.canvas)) });
    }
  }

  /** The replay frame that should be on screen right now, plus progress (0..1). */
  replayNow(): { frame: ImageBitmap | null; progress: number; remaining: number } | null {
    if (store.get().phase !== 'preroll' || this.punchAt === null) return null;
    const rem = Math.max(0, this.punchAt - this.ctxTime);
    const progress = this.prerollTotal ? 1 - rem / this.prerollTotal : 1;
    const T = this.tapeBase;
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
   * say then is just narration on the tape.
   */
  commandDown() {
    if (this.session) return;
    this.startCommand();
  }

  commandUp() {
    const s = this.session;
    if (!s) return;
    if (s.web) return s.web.stop(); // the browser fallback finalizes its result
    const held = this.ctxTime - s.startCtx;
    if (!s.speech) return this.cancelCommand(held > 0.6 ? 'Didn’t hear a command. Speak while holding the keys.' : undefined);
    this.finishFromAudio();
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
    const useWeb = !stt.ready.command && webSpeechAvailable();
    if (!stt.ready.command && !useWeb) {
      const e = store.get().engine;
      toast(
        e.status === 'loading' ? `Voice engine still loading (${Math.round(e.progress * 100)}%). Buttons and hotkeys work now.` : 'Voice engine unavailable. Buttons and hotkeys still work.',
        'muted',
      );
      return;
    }
    const live = st.phase === 'rolling' || st.phase === 'hold';
    const ses: Session = { hold: true, startCtx: this.ctxTime, startTape: live ? this.tapeNow() : null, buf: [], speech: false, lastLoud: this.ctxTime };
    this.session = ses;
    native?.listening(true);
    store.set((s) => ({ listen: { state: 'listening', heard: '', intent: null, alternatives: [], id: s.listen.id + 1 } }));
    sounds.ping();
    if (useWeb) {
      const h = listenOnce(20000);
      ses.web = h;
      h.promise.then((text) => {
        if (this.session !== ses) return;
        this.session = null;
        native?.listening(false);
        if (!text.trim()) return this.unsure('', ['cut', 'wrap', 'hold']);
        this.finishCommand(text, ses);
      });
    }
  }

  cancelCommand(msg?: string) {
    if (!this.session) return;
    this.session.web?.stop();
    this.session = null;
    native?.listening(false);
    store.set((s) => ({ listen: { ...s.listen, state: 'off' } }));
    if (msg) toast(msg, 'muted');
  }

  private sessionTick() {
    const s = this.session;
    if (!s || s.web) return;
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
    let text = '';
    try {
      text = await stt.command(to16k(pcm, this.pcm.sr));
    } catch {
      return this.unsure('', ['cut', 'wrap', 'hold']);
    }
    this.finishCommand(text, s);
  }

  private unsure(heard: string, alternatives: string[]) {
    store.set((x) => ({ listen: { ...x.listen, state: 'unsure', heard, intent: null, alternatives } }));
    const id = store.get().listen.id;
    this.after(4000, () => store.get().listen.id === id && store.set((x) => ({ listen: { ...x.listen, state: 'off' } })), 'listen');
  }

  private async finishCommand(raw: string, s: Session) {
    const text = raw.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim(); // whisper noise tags
    const st = store.get();
    const emb = await stt.intentScores(text);
    const r = interpret(text, st.marks, emb);
    // the spoken command never reaches the final audio
    const ph = store.get().phase;
    if (s.startTape !== null && (ph === 'rolling' || ph === 'hold')) this.scrubs.push({ start: Math.max(0, s.startTape - 0.05), end: this.tapeNow() + 0.1 });
    if (!r.command) return this.unsure(text, r.alternatives);
    store.set((x) => ({ listen: { ...x.listen, state: 'done', heard: text, intent: r.intent } }));
    const id = store.get().listen.id;
    this.after(1500, () => store.get().listen.id === id && store.set((x) => ({ listen: { ...x.listen, state: 'off' } })), 'listen');
    this.run(r.command, { startTape: s.startTape });
  }

  /** Act as if a command session just heard `text` (tests, demos). */
  async simulate(text: string, secondsAgo = 1) {
    const live = ['rolling', 'hold'].includes(store.get().phase);
    const s: Session = { hold: true, startCtx: this.ctxTime - secondsAgo, startTape: live ? Math.max(0, this.tapeNow() - secondsAgo) : null, buf: [], speech: true, lastLoud: this.ctxTime };
    store.set((x) => ({ listen: { ...x.listen, id: x.listen.id + 1 } }));
    await this.finishCommand(text, s);
  }

  // ───────────────────────── intents ─────────────────────────

  /** One entry point for voice, buttons and hotkeys. */
  run(cmd: Command, o: { startTape?: number | null } = {}) {
    const st = store.get();
    if (st.trying) return this.tryOut(cmd);
    const ph = st.phase;
    const live = ph === 'rolling' || ph === 'hold';
    const rew = ph === 'preroll' || ph === 'rewinding';
    switch (cmd.type) {
      case 'action':
        if (ph === 'idle') this.roll();
        else if (ph === 'hold') this.endHold(true);
        else if (ph === 'preroll') this.punchIn(this.ctxTime);
        break;
      case 'cut':
        if (live) this.cut({ before: o.startTape ?? undefined });
        else if (rew) this.cutFurther();
        else toast('Nothing to cut yet. Start rolling first.', 'muted');
        break;
      case 'cutBack':
        if (live) this.cut({ seconds: cmd.seconds });
        else if (rew) this.cutFurther(cmd.seconds);
        break;
      case 'scratch':
        if (rew) this.abortCut();
        else this.undoLast();
        break;
      case 'hold':
        if (ph === 'rolling') this.hold(o.startTape ?? null);
        else if (ph === 'hold') this.endHold(true);
        break;
      case 'zoom':
        this.zoomTo(cmd.mark);
        break;
      case 'wide':
        this.zoomTo(null);
        break;
      case 'redact':
        if (live) this.addRedact();
        break;
      case 'chapter':
        if (live) this.addChapter(cmd.name, o.startTape ?? this.tapeNow());
        break;
      case 'camera':
        this.setCamera(cmd.on);
        break;
      case 'mic':
        this.setMicMuted(!cmd.on);
        break;
      case 'wrap':
        if (live || rew) this.wrap(o.startTape ?? null);
        break;
    }
  }

  private tryOut(cmd: Command) {
    store.set((s) => ({ tried: { ...s.tried, [cmd.type]: true } }));
    const label = cmd.type === 'zoom' ? `Zoom · ${cmd.mark.name}` : cmd.type === 'cutBack' ? `Back ${cmd.seconds} s` : INTENT_LABEL[cmd.type];
    this.act(cmd.type, label, 'ok');
    if (cmd.type === 'cut' || cmd.type === 'cutBack') sounds.rewind(0.7);
  }

  /** The manual switch: start rolling, or stop and wrap. */
  record() {
    const ph = store.get().phase;
    if (ph === 'idle') this.run({ type: 'action' });
    else if (ph !== 'wrapped') this.run({ type: 'wrap' });
  }

  holdToggle() {
    const ph = store.get().phase;
    if (ph === 'hold' || ph === 'rolling') this.run({ type: ph === 'hold' ? 'action' : 'hold' });
  }

  toggleMic() {
    this.setMicMuted(!store.get().micMuted);
  }

  setMicMuted(m: boolean) {
    store.set({ micMuted: m });
    this.act('mic', m ? 'Mic muted' : 'Mic live', m ? 'rec' : 'ok');
  }

  // ───────────────────────── tape operations ─────────────────────────

  roll() {
    if (!this.comp.hasScreen) {
      toast('Share a window first.', 'rec');
      return;
    }
    if (!this.audio) return;
    this.tapeBase = 0;
    this.lastFrameTs = -1;
    store.set({ take: 1, sessionId: uid(), title: '', transcript: null, captions: { status: 'idle', progress: 0, detail: null } });
    this.punchIn(this.ctxTime);
    this.act('action', 'Action', 'rec');
  }

  private punchIn(atCtx: number) {
    this.punchAt = null;
    this.clearTimers('sys');
    this.openStretch(1, atCtx);
    this.forceKey = true;
    this.lastPunch = this.tapeBase;
    this.lastSnapT = -1e9;
    this.cutStack = [];
    this.matchSig = null;
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
      lastAction: { kind: 'punch', label: `Take ${s.take}`, id: ++this.actionN },
    }));
  }

  /** Remove the tape after T without a rewind (used to drop a spoken command's dead air). */
  private async trim(T: number) {
    await this.video.flush();
    this.video.truncate(Math.round(T * 1e6));
    this.pcm.truncate(T * this.pcm.sr);
    this.snaps.truncate(T);
    this.scrubs = this.scrubs.filter((s) => s.start < T).map((s) => (s.end > T ? { ...s, end: T } : s));
    this.tapeBase = T;
    this.lastFrameTs = this.video.lastTs >= 0 ? this.video.lastTs / 1e6 : -1;
    this.forceKey = true; // the encoder's reference frame was just dropped
  }

  private async hold(trimTo: number | null) {
    const tNow = this.tapeNow();
    if (trimTo !== null && tNow - trimTo > 0.15) {
      this.frozen = true;
      this.closeStretch(true);
      this.tapeBase = tNow;
      await this.trim(Math.max(this.lastPunch, trimTo - 0.05));
      this.frozen = false;
    } else {
      this.closeStretch(false);
      this.tapeBase = tNow;
    }
    this.openStretch(1 / 8);
    this.holdStart = { tape: this.tapeBase, ctx: this.resumeCtx };
    store.set({ phase: 'hold', holdBadge: null });
    this.act('hold', 'Hold · 8×', 'hold');
  }

  private endHold(resume: boolean) {
    const t = this.tapeNow();
    const hs = this.holdStart;
    this.holdStart = null;
    if (hs) {
      const wall = this.ctxTime - hs.ctx;
      const r: RangeInfo = { id: uid(), kind: 'hold', start: hs.tape, end: t, wall };
      store.set((s) => ({ ranges: [...s.ranges, r], holdBadge: `${Math.round(wall)} s of waiting became ${(t - hs.tape).toFixed(1)} s` }));
      this.after(4000, () => store.set({ holdBadge: null }), 'badge');
    }
    if (resume) {
      this.closeStretch(false);
      this.tapeBase = t;
      this.openStretch(1);
      store.set({ phase: 'rolling' });
      this.act('resume', 'Back to 1×', 'rec');
    }
  }

  private async cut(o: { before?: number; seconds?: number }) {
    const tCut = this.tapeNow();
    if (store.get().phase === 'hold') this.endHold(false);
    this.closeStretch(true);
    store.set({ phase: 'rewinding' });
    this.tapeBase = tCut;
    let T: number;
    if (o.seconds) T = tCut - o.seconds;
    else {
      const before = Math.min(o.before ?? tCut, tCut);
      const s = this.pcm.speechStart(before, this.thr);
      if (s === null) {
        // no sentence on the tape (mic muted or silent): never throw away the whole take, step back 5 s
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
    const T0 = this.tapeBase;
    store.set({ phase: 'rewinding', countdown: null });
    const T = seconds ? T0 - seconds : (this.pcm.speechStart(T0 - 0.05, this.thr) ?? Math.max(0, T0 - 5));
    if (T0 < 0.05) toast('Already at the top of the tape.', 'muted');
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
    await this.video.flush();
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
        ranges: s.ranges.filter((r) => r.start < T).map((r) => (r.end > T ? { ...r, end: T } : r)),
        chapters: s.chapters.filter((c) => c.t < T),
        outtakes: [...s.outtakes, { id: ot.id, take: ot.take, from: T, to: tEnd, text: '', thumb: snaps[0]?.url ?? this.snaps.at(T)?.url ?? null }],
        take: s.take + 1,
        teleprompter: null,
      }));
    }
    this.tapeBase = T;
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
          if (this.tapeBase === T && ['rewinding', 'preroll'].includes(store.get().phase)) this.replay = r;
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
    const T = this.tapeBase;
    const st = store.get().settings;
    const R = Math.min(st.replaySeconds, T);
    const total = Math.max(st.countdown, R > 0.2 ? R : 0);
    this.prerollTotal = total;
    this.punchAt = this.ctxTime + total;
    store.set({ phase: 'preroll', countdown: total <= st.countdown ? st.countdown : null, matchScore: null, rewind: null });
    this.matchSig = null;
    const snap = this.snaps.at(T - 0.05);
    if (snap && !this.replay)
      createImageBitmap(snap.blob).then((b) => {
        if (!this.matchSig) this.matchSig = signature(b);
        b.close();
      });
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
    this.tapeBase = first.to;
    this.lastFrameTs = this.video.lastTs >= 0 ? this.video.lastTs / 1e6 : -1;
    this.comp.setView(this.viewAt(first.to), true);
    this.act('scratch', 'Cut cancelled', 'muted');
    this.punchIn(this.ctxTime);
  }

  private addRedact() {
    const t = this.tapeNow();
    const r: RangeInfo = { id: uid(), kind: 'redact', start: Math.max(0, t - 5), end: t, rect: { x: 0, y: 0, w: 1, h: 1 } };
    store.set((s) => ({ ranges: [...s.ranges, r] }));
    this.undo.push({ label: 'redaction', fn: () => store.set((s) => ({ ranges: s.ranges.filter((x) => x.id !== r.id) })) });
    this.act('redact', 'Redact · last 5 s', 'redact');
  }

  private addChapter(name: string, t: number) {
    const c = { id: uid(), t: Math.max(0, t), name: name || `Chapter ${store.get().chapters.length + 2}` };
    store.set((s) => ({ chapters: [...s.chapters, c].sort((a, b) => a.t - b.t) }));
    this.undo.push({ label: 'chapter', fn: () => store.set((s) => ({ chapters: s.chapters.filter((x) => x.id !== c.id) })) });
    this.act('chapter', `Chapter · ${c.name}`, 'ok');
  }

  setCamera(on: boolean, record = true) {
    const prev = this.comp.cameraOn;
    this.comp.cameraOn = on;
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
  }

  private async wrap(startTape: number | null) {
    const ph = store.get().phase;
    let tEnd = this.tapeNow();
    if (ph === 'hold') this.endHold(false);
    if (ph === 'preroll' || ph === 'rewinding') {
      this.audio?.stopPlayback();
      this.punchAt = null;
      this.clearTimers('sys');
      tEnd = this.tapeBase;
    } else if (startTape !== null) {
      tEnd = Math.max(Math.min(startTape - 0.05, tEnd), Math.min(tEnd, this.lastPunch + 0.2));
    }
    this.closeStretch(true);
    this.tapeBase = tEnd;
    store.set({ phase: 'wrapped' });
    this.act('wrap', 'That’s a wrap', 'rec');
    await this.video.flush();
    this.video.truncate(Math.round(tEnd * 1e6));
    this.pcm.truncate(tEnd * this.pcm.sr);
    this.snaps.truncate(tEnd);
    this.scrubs = this.scrubs.filter((s) => s.start < tEnd).map((s) => (s.end > tEnd ? { ...s, end: tEnd } : s));
    this.replay?.dispose();
    this.replay = null;
    const last = this.video.chunks[this.video.chunks.length - 1];
    const duration = last ? (last.ts + (last.dur || FD * 1e6)) / 1e6 : tEnd;
    sounds.chime();
    this.screenStream?.getTracks().forEach((t) => t.stop());
    native?.showMain();
    store.set((s) => ({
      screen: 'dailies',
      duration,
      activeMark: null,
      rewind: null,
      countdown: null,
      teleprompter: null,
      hasScreen: false,
      transcript: null,
      ranges: s.ranges.filter((r) => r.start < tEnd).map((r) => (r.end > tEnd ? { ...r, end: tEnd } : r)),
      chapters: s.chapters.filter((c) => c.t < tEnd),
    }));
  }

  /** Clear the tape for a fresh recording (keeps marks, mic and settings). */
  reset() {
    this.video.chunks = [];
    this.pcm = new PcmTape(SAMPLE_RATE);
    this.snaps = new Snapshots();
    this.scrubs = [];
    this.outtakes = [];
    this.cutStack = [];
    this.undo = [];
    this.viewHistory = [];
    this.stretches = [];
    this.tapeBase = 0;
    this.lastFrameTs = -1;
    this.previewCache = null;
    store.set({ phase: 'idle', take: 1, outtakes: [], ranges: [], chapters: [], duration: 0, log: [], transcript: null, screen: 'stage', sessionId: '', title: '', captions: { status: 'idle', progress: 0, detail: null } });
  }

  // ───────────────────────── review + export ─────────────────────────

  /** Local Whisper over the final cut: transcript, captions and post copy. Runs when you ask for it. */
  async transcribe() {
    const st = store.get();
    if (st.transcribing) return st.transcript;
    if (st.transcript?.length) return st.transcript;
    store.set({ transcribing: true, captions: { status: stt.ready.transcript ? 'transcribing' : 'downloading', progress: 0, detail: null } });
    try {
      const raw = this.pcm.read(0, Math.round(st.duration * this.pcm.sr));
      const sr = this.pcm.sr;
      for (const s of this.scrubs) raw.fill(0, Math.max(0, Math.round(s.start * sr)), Math.min(raw.length, Math.round(s.end * sr)));
      const chunks = await stt.transcribe(to16k(raw, sr));
      const lines = chunks
        .map((c, i) => ({ start: c.start, end: Math.min(st.duration, c.end ?? chunks[i + 1]?.start ?? c.start + 3), text: c.text.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim() }))
        .filter((l) => l.text && !/^(you|thank you\.?|\.+)$/i.test(l.text));
      store.set({
        transcript: lines,
        transcribing: false,
        captions: { status: lines.length ? 'ready' : 'error', progress: 1, detail: lines.length ? null : 'No speech found in the final cut.' },
      });
      if (st.sessionId && lines.length) library.update(st.sessionId, { transcript: lines });
      return lines;
    } catch (e) {
      store.set({ transcript: null, transcribing: false, captions: { status: 'error', progress: 0, detail: String((e as Error)?.message ?? e) } });
      return null;
    }
  }

  private keptAudio() {
    const st = store.get();
    const pcm = this.pcm.read(0, Math.round(st.duration * this.pcm.sr));
    return processAudio({ pcm, sampleRate: this.pcm.sr, scrubs: this.scrubs });
  }

  /** Fast path: stream-copy the kept tape (no re-encode). */
  async previewMp4() {
    if (this.previewCache) return this.previewCache;
    const audio = await encodeAudio(this.keptAudio(), this.pcm.sr);
    const blob = buildMp4({ codec: this.video.codec, width: this.comp.W, height: this.comp.H, description: this.video.decoderConfig?.description, chunks: this.video.chunks }, audio);
    this.previewCache = URL.createObjectURL(blob);
    return this.previewCache;
  }

  /** Final render. Re-encodes only when something must be burned in (redactions, captions). */
  async exportFinal(onProgress?: (p: number) => void, opts: { captions?: boolean } = {}) {
    const st = store.get();
    const redactions = st.ranges.filter((r) => r.kind === 'redact' && r.rect) as { start: number; end: number; rect: Rect }[];
    const cues = opts.captions && st.transcript?.length ? toCues(st.transcript) : undefined;
    if (!this.video.chunks.length) throw new Error('There’s nothing on the tape to export. Record a take first.');
    onProgress?.(0.02);
    let video = { codec: this.video.codec, width: this.comp.W, height: this.comp.H, description: this.video.decoderConfig?.description as AllowSharedBufferSource | undefined, chunks: this.video.chunks };
    if ((redactions.length || cues) && this.video.decoderConfig) {
      const dur = Math.round(st.duration * 1e6);
      const r = await renderClips({
        config: this.video.decoderConfig,
        width: this.comp.W,
        height: this.comp.H,
        clips: [{ chunks: this.video.chunks, from: 0, to: dur + 1 }],
        redactions,
        captions: cues,
        onProgress: (p) => onProgress?.(p * 0.85),
      });
      video = { ...video, codec: r.codec, chunks: r.chunks, description: r.description };
    }
    onProgress?.(0.9);
    const audio = await encodeAudio(this.keptAudio(), this.pcm.sr);
    const blob = buildMp4(video, audio);
    onProgress?.(1);
    await this.saveToLibrary(blob, !!cues);
    return { blob, url: URL.createObjectURL(blob), rerendered: redactions.length > 0 || !!cues };
  }

  /** Every printed master lands in your library (re-prints update the same entry). */
  private async saveToLibrary(video: Blob, captionsBurned: boolean) {
    const st = store.get();
    if (!st.sessionId) return;
    try {
      const prev = await library.get(st.sessionId);
      const held = st.ranges.filter((r) => r.kind === 'hold').reduce((a, r) => a + (r.wall ?? 0) - (r.end - r.start), 0);
      await library.put({
        id: st.sessionId,
        title: st.title || prev?.title || 'Untitled take',
        createdAt: prev?.createdAt ?? Date.now(),
        duration: st.duration,
        retakes: st.outtakes.length,
        held,
        video,
        thumb: this.snaps.at(st.duration * 0.3)?.blob ?? null,
        transcript: st.transcript ?? prev?.transcript ?? null,
        chapters: st.chapters.map((c) => ({ t: c.t, name: c.name })),
        captionsBurned,
      });
    } catch {
      toast('Couldn’t save to your library (storage full or blocked).', 'rec');
    }
  }

  setTitle(title: string) {
    store.set({ title });
    const id = store.get().sessionId;
    this.clearTimers('title');
    if (id) this.after(600, () => library.update(id, { title: title || 'Untitled take' }), 'title');
  }

  private outtakeClip(o: Outtake, label?: string): Clip {
    return { chunks: [...o.prefix, ...o.chunks], from: Math.round(o.from * 1e6), to: Math.round(o.to * 1e6), label };
  }

  async renderOuttakes(ids: string[], onProgress?: (p: number) => void) {
    const list = this.outtakes.filter((o) => ids.includes(o.id));
    if (!list.length || !this.video.decoderConfig) return null;
    const r = await renderClips({
      config: this.video.decoderConfig,
      width: this.comp.W,
      height: this.comp.H,
      clips: list.map((o) => this.outtakeClip(o, list.length > 1 ? `TAKE ${o.take} · OUTTAKE` : undefined)),
      onProgress: (p) => onProgress?.(p * 0.9),
    });
    const sr = this.pcm.sr;
    const total = list.reduce((a, o) => a + o.audio.length, 0);
    const pcm = new Float32Array(total);
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
    const audio = await encodeAudio(processAudio({ pcm, sampleRate: sr, scrubs: [] }), sr);
    const blob = buildMp4({ codec: r.codec, width: this.comp.W, height: this.comp.H, description: r.description, chunks: r.chunks }, audio);
    onProgress?.(1);
    return URL.createObjectURL(blob);
  }

  snapAt(t: number) {
    return this.snaps.at(t);
  }
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
  if (e.key === 'Escape') return director.cancelCommand();
  if (native) return; // global keys (incl. the talk key) come from the shell's keyboard hook
  const combo = TALK_MODS[store.get().talkKey];
  if (MODIFIER.test(e.key)) {
    const exact = combo && e.ctrlKey === combo.ctrl && e.altKey === combo.alt && e.shiftKey === combo.shift && e.metaKey === combo.meta && (!combo.code || e.code === combo.code);
    if (exact && !talking && !talkTimer && !e.repeat) {
      // a short grace period so Ctrl+Shift+T and friends don't open a session
      talkTimer = setTimeout(() => {
        talkTimer = null;
        talking = true;
        director.commandDown();
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
    director.cancelCommand();
  }
  const sc = store.get().shortcuts;
  for (const [name, accel] of Object.entries(sc)) {
    if (matches(e, accel)) {
      e.preventDefault();
      director.hotkey(name);
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
    director.commandUp();
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
    director.commandUp();
  }
}

export const director = new Director();
(window as any).take1 = director;
(window as any).take1Store = store;

// The director owns the live tape. Hot-swapping it would leave the UI pointing at an empty recorder,
// so any code change that reaches this module reloads the page instead.
(import.meta as any).hot?.decline();
