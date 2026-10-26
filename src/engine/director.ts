import { store, pushTicker, toast, uid, type Rect, type StageMark, type RangeInfo, type Tone } from '../lib/store';
import { AudioEngine, PcmTape, SAMPLE_RATE } from './audio';
import { Compositor, signature, matchScore } from './compositor';
import { VideoTape, type Chunk } from './videoTape';
import { Snapshots, type Snap } from './snapshots';
import { createTicker } from './ticker';
import { buildMp4, encodeAudio, processAudio, renderClips, type Clip } from './exporter';
import { Recognizer, type SpeechEvent } from '../voice/recognizer';
import { parse, type Command } from '../voice/grammar';
import { sounds, bindSounds, setSoundsEnabled } from '../ui/sounds';

/**
 * The Director turns voice into tape edits.
 *
 * Two clocks:
 *  - AudioContext time ("ctx"): when things physically happened.
 *  - Tape time: where they land in the final video. It only advances while Rolling
 *    (and at 1/8 speed during Hold), and jumps backwards on a Cut.
 *
 * A "stretch" maps one run of ctx time onto tape time. Audio blocks and recognized
 * words are placed on the tape through the stretch that was live when they happened.
 */

interface Stretch {
  ctxStart: number;
  ctxEnd: number | null;
  tapeStart: number;
  rate: number;
  dead?: boolean;
}

export interface Utt {
  key: string;
  text: string;
  firstHeard: number;
  onset: number | null; // tape seconds
  end: number | null;
  command: boolean;
  final: boolean;
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
  utts: Utt[];
  saved: {
    ranges: RangeInfo[];
    chapters: ReturnType<typeof store.get>['chapters'];
    scrubs: { start: number; end: number }[];
    viewHistory: { t: number; view: Rect }[];
    take: number;
  };
}

const FPS = 30;
const FD = 1 / FPS;

const LABEL: Record<Command['type'], (c: any) => [string, Tone]> = {
  action: () => ['ACTION', 'tally'],
  cut: () => ['CUT', 'cue'],
  cutBack: (c) => [`CUT BACK ${c.seconds}s`, 'cue'],
  scratch: () => ['SCRATCH THAT', 'muted'],
  hold: () => ['HOLD', 'hold'],
  zoom: (c) => [`ZOOM · ${c.mark.name.toUpperCase()}`, 'ok'],
  wide: () => ['WIDE', 'ok'],
  redact: () => ['REDACT', 'redact'],
  chapter: (c) => [`MARK · ${c.name || 'CHAPTER'}`, 'ok'],
  camera: (c) => [`CAMERA ${c.on ? 'ON' : 'OFF'}`, 'muted'],
  wrap: () => ['THAT’S A WRAP', 'tally'],
};

export class Director {
  audio: AudioEngine | null = null;
  comp = new Compositor();
  video = new VideoTape(FPS, 5_000_000);
  pcm = new PcmTape(SAMPLE_RATE);
  snaps = new Snapshots();
  rec: Recognizer | null = null;
  screenStream: MediaStream | null = null;
  cameraStream: MediaStream | null = null;
  hudWindow: Window | null = null;
  hudRoot: HTMLElement | null = null;
  onName: ((name: string) => void) | null = null;

  private ticker: { stop: () => void } | null = null;
  private tapeBase = 0;
  private resumeCtx = 0;
  private rate = 1;
  private stretches: Stretch[] = [];
  private lastFrameTs = -1;
  private forceKey = false;
  private lastSnapT = -1e9;
  private lastPunch = 0;
  private punchAt: number | null = null;
  private holdStart: { tape: number; ctx: number } | null = null;
  private timers: { at: number; fn: () => void; tag: string }[] = [];
  private matchSig: Float32Array | null = null;
  private tickN = 0;
  private kb = 0;

  utts: Utt[] = [];
  private live = new Map<string, Utt>();
  private consumed = new Set<string>();
  scrubs: { start: number; end: number }[] = [];
  outtakes: Outtake[] = [];
  private cutStack: Outtake[] = [];
  private undo: { label: string; fn: () => void }[] = [];
  private viewHistory: { t: number; view: Rect }[] = [];
  private previewCache: string | null = null;

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

  async micOn() {
    const a = this.ensureAudio();
    try {
      await a.start();
      store.set({ micOn: true });
    } catch (e) {
      toast('Microphone blocked. Allow it in the address bar and try again.', 'tally');
      throw e;
    }
    this.startTicker();
    this.listen();
  }

  listen() {
    if (!Recognizer.supported) {
      store.set({ listening: 'unsupported' });
      return;
    }
    if (this.rec) return this.rec.start();
    this.rec = new Recognizer(
      () => this.ctxTime,
      (e) => this.onSpeech(e),
      (s, d) => store.set({ listening: s, listenError: d ?? null }),
    );
    this.rec.start();
  }

  private startTicker() {
    if (!this.ticker) this.ticker = createTicker(FPS, () => this.tick());
  }

  async shareScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'window', frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      preferCurrentTab: false,
    } as any);
    await this.attachScreen(stream);
  }

  async attachScreen(stream: MediaStream) {
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.comp.detach('screen');
    this.screenStream = stream;
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
    this.comp.setSize(s.width || 1920, s.height || 1080);
    this.comp.attach(track, 'screen');
    await this.video.configure(this.comp.W, this.comp.H);
    this.startTicker();
    store.set({ hasScreen: true, surface: s.displaySurface ?? null });
    track.addEventListener('ended', () => {
      store.set({ hasScreen: false });
      if (['rolling', 'hold'].includes(store.get().phase)) toast('Window sharing stopped. Say “That’s a wrap” or share again.', 'tally');
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
      toast('Camera blocked or not found.', 'tally');
    }
  }

  setSettings(p: Partial<ReturnType<typeof store.get>['settings']>) {
    store.set((s) => ({ settings: { ...s.settings, ...p } }));
    if (p.sounds !== undefined) setSoundsEnabled(p.sounds);
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
    if (record)
      this.undo.push({
        label: 'zoom',
        fn: () => {
          this.comp.setView(prev);
          this.viewHistory.push({ t: this.tapeNow(), view: prev });
          store.set({ activeMark: prevActive });
        },
      });
  }

  // ───────────────────────── HUD ─────────────────────────

  async openHud() {
    const dpip = (window as any).documentPictureInPicture;
    if (!dpip) {
      toast('Floating console needs Chrome or Edge 116+. This tab works as the console.', 'muted');
      return false;
    }
    if (this.hudWindow) return true;
    const w: Window = await dpip.requestWindow({ width: 360, height: 210 });
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
    w.document.body.className = 'hud-body';
    const root = w.document.createElement('div');
    root.id = 'hud-root';
    w.document.body.appendChild(root);
    this.hudWindow = w;
    this.hudRoot = root;
    w.addEventListener('pagehide', () => {
      this.hudWindow = null;
      this.hudRoot = null;
      store.set({ hudOpen: false });
    });
    store.set({ hudOpen: true });
    return true;
  }

  closeHud() {
    this.hudWindow?.close();
    this.hudWindow = null;
    this.hudRoot = null;
    store.set({ hudOpen: false });
  }

  // ───────────────────────── clocks ─────────────────────────

  tapeNow() {
    const ph = store.get().phase;
    if (ph === 'rolling' || ph === 'hold') return this.tapeBase + Math.max(0, this.ctxTime - this.resumeCtx) * this.rate;
    return this.tapeBase;
  }

  private ctxToTape(c: number): number | null {
    for (let i = this.stretches.length - 1; i >= 0; i--) {
      const s = this.stretches[i];
      if (s.dead) continue;
      if (c >= s.ctxStart && (s.ctxEnd === null || c <= s.ctxEnd)) return s.tapeStart + (c - s.ctxStart) * s.rate;
      // speech that began just before a punch-in belongs to the new take
      if (c < s.ctxStart && s.ctxStart - c < 0.8 && (i === 0 || (this.stretches[i - 1].ctxEnd ?? 0) <= c)) return s.tapeStart;
    }
    return null;
  }

  private closeStretch(kill: boolean) {
    const s = this.stretches[this.stretches.length - 1];
    if (!s) return;
    if (s.ctxEnd === null) s.ctxEnd = this.ctxTime;
    if (kill) s.dead = true;
  }

  private openStretch(rate: number) {
    this.resumeCtx = this.ctxTime;
    this.rate = rate;
    this.stretches.push({ ctxStart: this.resumeCtx, ctxEnd: null, tapeStart: this.tapeBase, rate });
  }

  private after(ms: number, fn: () => void, tag = 'sys') {
    this.timers.push({ at: performance.now() + ms, fn, tag });
  }

  private clearTimers(tag: string) {
    this.timers = this.timers.filter((t) => t.tag !== tag);
  }

  // ───────────────────────── capture loop ─────────────────────────

  private onAudio(s: Float32Array, t: number) {
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
    if (this.audio && this.tickN % 3 === 0) {
      const lv = Math.min(1, this.audio.level * 6);
      if (Math.abs(lv - store.get().micLevel) > 0.01) store.set({ micLevel: lv });
    }
    this.comp.draw(now);
    const ph = store.get().phase;
    if (ph === 'rolling' || ph === 'hold') this.captureFrame();
    else if (ph === 'preroll') this.prerollTick();
  }

  private captureFrame() {
    if (!this.comp.hasScreen || this.video.busy) return;
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
    if (this.punchAt !== null) {
      const rem = this.punchAt - this.ctxTime;
      const n = Math.max(1, Math.ceil(rem));
      if (store.get().countdown !== n) {
        store.set({ countdown: n });
        sounds.tick();
      }
      if (rem <= 0) return this.punchIn(this.punchAt);
    }
    if (this.matchSig && this.tickN % 5 === 0) {
      const score = matchScore(this.matchSig, signature(this.comp.canvas));
      store.set({ matchScore: score });
    }
  }

  // ───────────────────────── speech ─────────────────────────

  /** Simulate a spoken phrase (keyboard fallback and tests). */
  say(text: string) {
    const key = `kb:${++this.kb}`;
    const firstHeard = this.ctxTime - 0.3;
    this.onSpeech({ type: 'final', key, text, firstHeard });
  }

  private onSpeech(e: SpeechEvent) {
    const st = store.get();
    let u = this.live.get(e.key);
    if (!u) {
      const onTape = st.phase === 'rolling' || st.phase === 'hold';
      const onsetCtx = this.audio && !e.key.startsWith('kb:') ? this.audio.findOnset(e.firstHeard - 0.25) : e.firstHeard;
      u = { key: e.key, text: e.text, firstHeard: e.firstHeard, onset: onTape ? this.ctxToTape(onsetCtx) : null, end: null, command: false, final: false };
      this.live.set(e.key, u);
      if (this.live.size > 300) this.live.delete(this.live.keys().next().value!);
      if (u.onset !== null) this.utts.push(u);
    }
    u.text = e.text;
    if (this.consumed.has(e.key)) {
      if (e.type === 'final') store.set({ interim: '' });
      return;
    }
    const cmd = parse(e.text, st.marks, st.settings.strict);
    if (e.type === 'interim') {
      store.set({ interim: e.text });
      // fast path: an exact command that stays unchanged for 350 ms fires before the final result
      this.timers = this.timers.filter((x) => x.tag !== `cmd:${e.key}`);
      if (cmd && !(cmd.type === 'cut' && cmd.trailing)) {
        const snapshot = e.text;
        const uu = u;
        this.after(350, () => {
          if (!this.consumed.has(uu.key) && uu.text === snapshot) this.fire(cmd, uu);
        }, `cmd:${e.key}`);
      }
      return;
    }
    u.final = true;
    if (u.onset !== null) u.end = this.ctxToTape(this.ctxTime - 0.25) ?? this.tapeNow();
    this.clearTimers(`cmd:${e.key}`);
    store.set({ interim: '' });
    if (cmd) this.fire(cmd, u);
    else this.onPlain(u);
  }

  private onPlain(u: Utt) {
    const st = store.get();
    if (st.namingMark && this.onName) {
      this.onName(u.text.replace(/[.!?]+$/, ''));
      return;
    }
    pushTicker({ kind: 'speech', text: u.text });
  }

  private scrub(u: Utt) {
    const ph = store.get().phase;
    if ((ph === 'rolling' || ph === 'hold') && u.onset !== null) {
      this.scrubs.push({ start: Math.max(0, u.onset - 0.08), end: this.tapeNow() + 0.15 });
    }
  }

  private fire(cmd: Command, u: Utt) {
    this.consumed.add(u.key);
    u.command = !(cmd.type === 'cut' && cmd.trailing);
    const st = store.get();
    const [label, tone] = LABEL[cmd.type](cmd);
    pushTicker({ kind: 'command', text: label, tone });
    store.set({ lastCommand: cmd.type });

    if (st.rehearsing) {
      store.set((s) => ({ rehearsal: { ...s.rehearsal, [cmd.type]: true } }));
      if (cmd.type === 'cut' || cmd.type === 'cutBack') sounds.rewind(0.7);
      else sounds.blip();
      if (cmd.type === 'zoom') this.zoomTo(cmd.mark, false);
      if (cmd.type === 'wide') this.zoomTo(null, false);
      return;
    }

    const ph = st.phase;
    const live = ph === 'rolling' || ph === 'hold';
    const rewinding = ph === 'preroll' || ph === 'rewinding';
    if (!['cut', 'cutBack', 'wrap'].includes(cmd.type)) sounds.blip();

    switch (cmd.type) {
      case 'action':
        if (ph === 'idle') this.roll();
        else if (ph === 'hold') this.endHold(true);
        else if (ph === 'preroll') this.punchIn(this.ctxTime);
        break;
      case 'cut':
        if (live) this.cut({ utt: u, trailing: cmd.trailing });
        else if (rewinding) this.cutFurther();
        break;
      case 'cutBack':
        if (live) this.cut({ seconds: cmd.seconds });
        else if (rewinding) this.cutFurther(cmd.seconds);
        break;
      case 'scratch':
        if (rewinding) this.abortCut();
        else this.undoLast();
        break;
      case 'hold':
        if (ph === 'rolling') {
          this.scrub(u);
          this.hold();
        }
        break;
      case 'zoom':
        this.scrub(u);
        this.zoomTo(cmd.mark);
        break;
      case 'wide':
        this.scrub(u);
        this.zoomTo(null);
        break;
      case 'redact':
        if (live) {
          this.scrub(u);
          this.addRedact();
        }
        break;
      case 'chapter':
        if (live) {
          this.scrub(u);
          this.addChapter(cmd.name, u.onset ?? this.tapeNow());
        }
        break;
      case 'camera':
        this.scrub(u);
        this.setCamera(cmd.on);
        break;
      case 'wrap':
        if (ph !== 'idle' && ph !== 'wrapped') this.wrap(u);
        break;
    }
  }

  // ───────────────────────── tape operations ─────────────────────────

  roll() {
    if (!this.comp.hasScreen) {
      toast('Share a window first.', 'tally');
      return;
    }
    if (!this.audio) return;
    this.tapeBase = 0;
    this.lastFrameTs = -1;
    store.set({ take: 1 });
    this.punchIn(this.ctxTime);
  }

  private punchIn(atCtx: number) {
    this.punchAt = null;
    this.clearTimers('sys');
    this.resumeCtx = atCtx;
    this.rate = 1;
    this.stretches.push({ ctxStart: atCtx, ctxEnd: null, tapeStart: this.tapeBase, rate: 1 });
    this.forceKey = true;
    this.lastPunch = this.tapeBase;
    this.lastSnapT = -1e9;
    this.cutStack = [];
    this.matchSig = null;
    this.previewCache = null;
    store.set((s) => ({
      phase: 'rolling',
      countdown: null,
      matchFrame: null,
      matchScore: null,
      teleprompter: null,
      rewind: null,
      slateKey: s.slateKey + 1,
    }));
  }

  private hold() {
    const t = this.tapeNow();
    this.closeStretch(false);
    this.tapeBase = t;
    this.openStretch(1 / 8);
    this.holdStart = { tape: t, ctx: this.resumeCtx };
    store.set({ phase: 'hold', holdBadge: null });
  }

  private endHold(resume: boolean) {
    const t = this.tapeNow();
    const hs = this.holdStart;
    this.holdStart = null;
    if (hs) {
      const wall = this.ctxTime - hs.ctx;
      const r: RangeInfo = { id: uid(), kind: 'hold', start: hs.tape, end: t, wall };
      store.set((s) => ({
        ranges: [...s.ranges, r],
        holdBadge: `Held ${Math.round(wall)} s → ${(t - hs.tape).toFixed(1)} s. Nobody will know.`,
      }));
      this.after(4000, () => store.set({ holdBadge: null }), 'badge');
    }
    if (resume) {
      this.closeStretch(false);
      this.tapeBase = t;
      this.openStretch(1);
      store.set({ phase: 'rolling' });
    }
  }

  private sentenceStart(tCut: number, u?: Utt, trailing?: boolean) {
    if (trailing && u?.onset != null) return u.onset;
    const before = u?.onset ?? tCut;
    const prev = this.utts.filter((x) => !x.command && x !== u && x.onset !== null && x.onset < before - 0.05);
    if (prev.length) return prev[prev.length - 1].onset!;
    return this.lastPunch;
  }

  private async cut(o: { utt?: Utt; trailing?: boolean; seconds?: number }) {
    const tCut = this.tapeNow();
    if (store.get().phase === 'hold') this.endHold(false);
    this.closeStretch(true);
    store.set({ phase: 'rewinding' });
    this.tapeBase = tCut;
    const T = o.seconds ? tCut - o.seconds : this.sentenceStart(tCut, o.utt, o.trailing);
    await this.performCut(T, tCut);
  }

  private async cutFurther(seconds?: number) {
    this.audio?.stopPlayback();
    this.punchAt = null;
    this.clearTimers('sys');
    const T0 = this.tapeBase;
    store.set({ phase: 'rewinding', countdown: null });
    let T: number;
    if (seconds) T = T0 - seconds;
    else {
      const prev = this.utts.filter((x) => !x.command && x.onset !== null && x.onset < T0 - 0.3);
      T = prev.length ? prev[prev.length - 1].onset! : 0;
    }
    if (T0 < 0.05) toast('Already at the top of the tape.', 'muted');
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
      T = Math.max(0, T - 0.1);
      T = this.pcm.quietestPoint(Math.max(0, T - 0.2), Math.min(T + 0.04, tEnd));
    }
    await this.video.flush();
    const sr = this.pcm.sr;
    const st = store.get();
    if (tEnd - T > 0.05) {
      const { removed, prefix } = this.video.truncate(Math.round(T * 1e6));
      const audio = this.pcm.read(T * sr, tEnd * sr);
      this.pcm.truncate(T * sr);
      const snaps = this.snaps.truncate(T);
      const utts = this.utts.filter((x) => (x.onset ?? 0) >= T);
      this.utts = this.utts.filter((x) => (x.onset ?? 0) < T);
      const saved = { ranges: st.ranges, chapters: st.chapters, scrubs: this.scrubs, viewHistory: this.viewHistory, take: st.take };
      this.scrubs = this.scrubs.filter((s) => s.start < T).map((s) => (s.end > T ? { ...s, end: T } : s));
      this.viewHistory = this.viewHistory.filter((v) => v.t < T);
      const text = utts.filter((x) => !x.command).map((x) => x.text).join(' ');
      const ot: Outtake = { id: uid(), take: st.take, from: T, to: tEnd, prefix, chunks: removed, audio, snaps, utts, saved };
      this.outtakes.push(ot);
      this.cutStack.push(ot);
      store.set((s) => ({
        ranges: s.ranges.filter((r) => r.start < T).map((r) => (r.end > T ? { ...r, end: T } : r)),
        chapters: s.chapters.filter((c) => c.t < T),
        outtakes: [...s.outtakes, { id: ot.id, take: ot.take, from: T, to: tEnd, text, thumb: snaps[0]?.url ?? this.snaps.at(T)?.url ?? null }],
        take: s.take + 1,
        teleprompter: utts.find((x) => !x.command)?.text ?? null,
      }));
    }
    this.tapeBase = T;
    this.lastFrameTs = this.video.lastTs >= 0 ? this.video.lastTs / 1e6 : -1;
    this.comp.setView(this.viewAt(T), true);
    store.set({ rewind: { from: tEnd, to: T }, holdBadge: null });
    sounds.rewind(1.1);
    this.after(1150, () => this.startPreroll(), 'sys');
  }

  private startPreroll() {
    if (store.get().phase !== 'rewinding' || !this.audio) return;
    const T = this.tapeBase;
    const n = store.get().settings.countdown;
    const punchAt = this.ctxTime + n;
    this.punchAt = punchAt;
    const snap = this.snaps.at(T - 0.05);
    store.set({ phase: 'preroll', countdown: n, matchFrame: snap?.url ?? null, matchScore: null, rewind: null });
    sounds.tick();
    this.matchSig = null;
    if (snap)
      createImageBitmap(snap.blob).then((b) => {
        this.matchSig = signature(b);
        b.close();
      });
    if (store.get().settings.prerollAudio && T > 0.1) {
      const pre = Math.min(2, T);
      const s = this.pcm.read((T - pre) * this.pcm.sr, T * this.pcm.sr);
      this.audio.play(s, punchAt - pre, 1);
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
      this.utts.push(...o.utts);
    }
    this.utts.sort((a, b) => (a.onset ?? 0) - (b.onset ?? 0));
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
    pushTicker({ kind: 'system', text: 'Cut cancelled. Rolling on from where you were.', tone: 'muted' });
    this.punchIn(this.ctxTime);
  }

  private addRedact() {
    const t = this.tapeNow();
    const r: RangeInfo = { id: uid(), kind: 'redact', start: Math.max(0, t - 5), end: t, rect: { x: 0, y: 0, w: 1, h: 1 } };
    store.set((s) => ({ ranges: [...s.ranges, r] }));
    this.undo.push({ label: 'redaction', fn: () => store.set((s) => ({ ranges: s.ranges.filter((x) => x.id !== r.id) })) });
    toast('Last 5 s will be blurred. Adjust the box in Dailies.', 'redact');
  }

  private addChapter(name: string, t: number) {
    const c = { id: uid(), t: Math.max(0, t), name: name || `Chapter ${store.get().chapters.length + 2}` };
    store.set((s) => ({ chapters: [...s.chapters, c].sort((a, b) => a.t - b.t) }));
    this.undo.push({ label: 'chapter', fn: () => store.set((s) => ({ chapters: s.chapters.filter((x) => x.id !== c.id) })) });
  }

  setCamera(on: boolean, record = true) {
    const prev = this.comp.cameraOn;
    this.comp.cameraOn = on;
    store.set({ cameraOn: on });
    if (record) this.undo.push({ label: 'camera', fn: () => this.setCamera(prev, false) });
  }

  private undoLast() {
    const u = this.undo.pop();
    if (!u) return toast('Nothing to undo.', 'muted');
    u.fn();
    toast(`Undid ${u.label}.`, 'muted');
  }

  private async wrap(u?: Utt) {
    const ph = store.get().phase;
    let tEnd = this.tapeNow();
    if (ph === 'hold') this.endHold(false);
    if (ph === 'preroll' || ph === 'rewinding') {
      this.audio?.stopPlayback();
      this.punchAt = null;
      this.clearTimers('sys');
      tEnd = this.tapeBase;
    } else if (u?.onset != null) {
      tEnd = Math.max(Math.min(u.onset - 0.05, tEnd), Math.min(tEnd, this.lastPunch + 0.2));
    }
    this.closeStretch(true);
    this.tapeBase = tEnd;
    store.set({ phase: 'wrapped' });
    await this.video.flush();
    this.video.truncate(Math.round(tEnd * 1e6));
    this.pcm.truncate(tEnd * this.pcm.sr);
    this.snaps.truncate(tEnd);
    this.utts = this.utts.filter((x) => (x.onset ?? 0) < tEnd);
    this.scrubs = this.scrubs.filter((s) => s.start < tEnd).map((s) => (s.end > tEnd ? { ...s, end: tEnd } : s));
    const last = this.video.chunks[this.video.chunks.length - 1];
    const duration = last ? (last.ts + (last.dur || FD * 1e6)) / 1e6 : tEnd;
    sounds.chime();
    this.rec?.stop();
    store.set({ listening: 'off' });
    this.closeHud();
    this.screenStream?.getTracks().forEach((t) => t.stop());
    store.set((s) => ({
      screen: 'dailies',
      duration,
      activeMark: null,
      rewind: null,
      countdown: null,
      matchFrame: null,
      teleprompter: null,
      hasScreen: false,
      ranges: s.ranges.filter((r) => r.start < tEnd).map((r) => (r.end > tEnd ? { ...r, end: tEnd } : r)),
      chapters: s.chapters.filter((c) => c.t < tEnd),
    }));
  }

  /** Clear the tape for a fresh recording (keeps marks and settings). */
  reset() {
    this.video.chunks = [];
    this.pcm = new PcmTape(SAMPLE_RATE);
    this.snaps = new Snapshots();
    this.utts = [];
    this.scrubs = [];
    this.outtakes = [];
    this.cutStack = [];
    this.undo = [];
    this.viewHistory = [];
    this.stretches = [];
    this.tapeBase = 0;
    this.lastFrameTs = -1;
    this.previewCache = null;
    store.set({ phase: 'idle', take: 1, outtakes: [], ranges: [], chapters: [], duration: 0, ticker: [], screen: 'stage' });
    this.listen();
  }

  // ───────────────────────── export ─────────────────────────

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

  /** Final render: re-encodes only when there are redactions to burn in. */
  async exportFinal(onProgress?: (p: number) => void) {
    const redactions = store.get().ranges.filter((r) => r.kind === 'redact' && r.rect) as { start: number; end: number; rect: Rect }[];
    onProgress?.(0.02);
    let video = { codec: this.video.codec, width: this.comp.W, height: this.comp.H, description: this.video.decoderConfig?.description as AllowSharedBufferSource | undefined, chunks: this.video.chunks };
    if (redactions.length && this.video.decoderConfig) {
      const dur = Math.round(store.get().duration * 1e6);
      const r = await renderClips({
        config: this.video.decoderConfig,
        width: this.comp.W,
        height: this.comp.H,
        clips: [{ chunks: this.video.chunks, from: 0, to: dur + 1 }],
        redactions,
        onProgress: (p) => onProgress?.(p * 0.85),
      });
      video = { ...video, codec: r.codec, chunks: r.chunks, description: r.description };
    }
    onProgress?.(0.9);
    const audio = await encodeAudio(this.keptAudio(), this.pcm.sr);
    const blob = buildMp4(video, audio);
    onProgress?.(1);
    return { blob, url: URL.createObjectURL(blob), rerendered: redactions.length > 0 };
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

  /** Kept, spoken (non-command) lines on the final timeline. */
  transcript() {
    const dur = store.get().duration;
    return this.utts
      .filter((u) => !u.command && u.onset !== null && u.onset < dur && u.text.trim())
      .map((u) => ({ start: u.onset!, end: Math.min(dur, u.end ?? u.onset! + Math.max(1.2, u.text.split(' ').length * 0.38)), text: u.text.trim() }));
  }

  snapAt(t: number) {
    return this.snaps.at(t);
  }
}

export const director = new Director();
(window as any).take1 = director;
