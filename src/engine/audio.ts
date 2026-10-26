/**
 * Microphone capture + the audio "tape".
 *
 * - An AudioWorklet taps raw PCM with the AudioContext clock time of every block,
 *   so audio can be placed on the tape sample-accurately (no MediaRecorder drift).
 * - A 10 ms RMS envelope (60 s ring) powers voice-activity detection: it finds where
 *   a sentence really started, because speech recognition reports words late.
 */

const WORKLET = `class Tap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(1024);this.n=0;this.t=0}
process(i){const c=i[0]&&i[0][0];if(!c)return true;if(this.n===0)this.t=currentTime;this.b.set(c,this.n);this.n+=c.length;
if(this.n>=1024){this.port.postMessage({t:this.t,s:this.b.slice(0,this.n)});this.n=0}return true}}
registerProcessor('take1-tap',Tap);`;

export const SAMPLE_RATE = 48000;

/** Growable mono PCM buffer addressed by sample index (= tape time × sample rate). */
export class PcmTape {
  private chunks: Float32Array[] = [];
  length = 0;
  constructor(readonly sr: number) {}

  private ensure(n: number) {
    const need = Math.ceil(n / this.sr);
    while (this.chunks.length < need) this.chunks.push(new Float32Array(this.sr));
  }

  write(index: number, data: Float32Array) {
    index = Math.round(index);
    if (index < 0) {
      data = data.subarray(-index);
      index = 0;
    }
    if (!data.length) return;
    this.ensure(index + data.length);
    let i = 0;
    while (i < data.length) {
      const pos = index + i;
      const c = Math.floor(pos / this.sr);
      const o = pos % this.sr;
      const n = Math.min(this.sr - o, data.length - i);
      this.chunks[c].set(data.subarray(i, i + n), o);
      i += n;
    }
    this.length = Math.max(this.length, index + data.length);
  }

  read(start: number, end: number): Float32Array {
    start = Math.max(0, Math.round(start));
    end = Math.min(this.length, Math.round(end));
    const out = new Float32Array(Math.max(0, end - start));
    let i = 0;
    while (i < out.length) {
      const pos = start + i;
      const c = Math.floor(pos / this.sr);
      const o = pos % this.sr;
      const n = Math.min(this.sr - o, out.length - i);
      out.set(this.chunks[c].subarray(o, o + n), i);
      i += n;
    }
    return out;
  }

  /** Drop everything from `index` on. Zeroes it so later gaps play as silence. */
  truncate(index: number) {
    index = Math.max(0, Math.round(index));
    if (index >= this.length) return;
    let pos = index;
    while (pos < this.length) {
      const c = Math.floor(pos / this.sr);
      const o = pos % this.sr;
      const n = Math.min(this.sr - o, this.length - pos);
      this.chunks[c].fill(0, o, o + n);
      pos += n;
    }
    this.length = index;
  }

  /** RMS of 10 ms windows between two times (seconds). */
  private envelope(a: number, b: number) {
    const win = Math.round(this.sr * 0.01);
    const s = this.read(a * this.sr, b * this.sr);
    const out = new Float32Array(Math.floor(s.length / win));
    for (let k = 0; k < out.length; k++) {
      let e = 0;
      for (let i = k * win; i < (k + 1) * win; i++) e += s[i] * s[i];
      out[k] = Math.sqrt(e / win);
    }
    return out;
  }

  /**
   * Where did the last sentence before `before` start? Walks back over any
   * trailing silence, through the speech, until a pause of `gap` seconds.
   * Returns null if there's no speech in the last `lookback` seconds.
   */
  speechStart(before: number, thr: number, gap = 0.38, lookback = 20): number | null {
    const a = Math.max(0, before - lookback);
    const env = this.envelope(a, before);
    const gapN = Math.round(gap / 0.01);
    let j = env.length - 1;
    // skip trailing quiet (up to 4 s) — e.g. the pause before you said "cut"
    let skipped = 0;
    while (j >= 0 && env[j] < thr && skipped < 400) {
      j--;
      skipped++;
    }
    if (j < 0 || env[j] < thr) return null;
    let quiet = 0;
    for (; j >= 0; j--) {
      if (env[j] < thr) {
        quiet++;
        if (quiet >= gapN) return a + (j + quiet) * 0.01;
      } else quiet = 0;
    }
    // no pause anywhere: either the sentence started with the tape, or the room is noisy enough to
    // look like speech. Only trust the first case for a short tape; otherwise let the caller step back.
    return a === 0 && before < 6 ? 0 : null;
  }

  /** Quietest 10 ms point between two times (seconds): where a splice is inaudible. */
  quietestPoint(a: number, b: number): number {
    const win = Math.round(this.sr * 0.01);
    let best = a;
    let bestE = Infinity;
    for (let t = a; t <= b; t += 0.005) {
      const s = this.read(t * this.sr, t * this.sr + win);
      if (!s.length) continue;
      let e = 0;
      for (let i = 0; i < s.length; i++) e += s[i] * s[i];
      if (e < bestE) {
        bestE = e;
        best = t;
      }
    }
    return best;
  }
}

const ENV = 6000; // 60 s of 10 ms frames

export class AudioEngine {
  ctx: AudioContext;
  stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  onBlock: ((samples: Float32Array, ctxTime: number) => void) | null = null;

  private envT = new Float64Array(ENV);
  private envV = new Float32Array(ENV);
  private envN = 0;
  private accE = 0;
  private accN = 0;
  private accT = 0;
  noiseFloor = 0.004;
  level = 0;
  private playing: AudioBufferSourceNode[] = [];

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  }

  get sr() {
    return this.ctx.sampleRate;
  }

  private src: MediaStreamAudioSourceNode | null = null;
  private loaded = false;
  deviceId: string | null = null;

  async start(deviceId?: string) {
    await this.ctx.resume();
    if (this.stream && (deviceId === undefined || deviceId === this.deviceId)) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    if (!this.loaded) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, 'take1-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.node.connect(sink).connect(this.ctx.destination);
      this.node.port.onmessage = (e) => this.handle(e.data.s as Float32Array, e.data.t as number);
      this.loaded = true;
    }
    // hot-swap the input without touching the worklet (safe mid-take)
    this.src?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.deviceId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId ?? null;
    this.src = this.ctx.createMediaStreamSource(stream);
    this.src.connect(this.node!);
  }

  static async inputs() {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
  }

  private handle(s: Float32Array, t: number) {
    const hop = this.sr / 100;
    let peak = 0;
    for (let i = 0; i < s.length; i++) {
      if (this.accN === 0) this.accT = t + i / this.sr;
      this.accE += s[i] * s[i];
      if (++this.accN < hop) continue;
      const v = Math.sqrt(this.accE / hop);
      this.accE = 0;
      this.accN = 0;
      const j = this.envN++ % ENV;
      this.envT[j] = this.accT;
      this.envV[j] = v;
      peak = Math.max(peak, v);
      // slow-rising minimum tracker = room noise floor
      if (v < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.9 + v * 0.1;
      else this.noiseFloor *= 1.0004;
      this.noiseFloor = Math.min(Math.max(this.noiseFloor, 0.0015), 0.05);
    }
    this.level = Math.max(peak, this.level * 0.85);
    this.onBlock?.(s, t);
  }

  get speechThreshold() {
    return Math.max(this.noiseFloor * 3.5, 0.008);
  }

  /**
   * Walk back from a moment inside an utterance to where the speech began:
   * the first loud frame after ≥250 ms of quiet. Returns AudioContext time.
   */
  findOnset(hint: number): number {
    const thr = this.speechThreshold;
    const oldest = Math.max(0, this.envN - ENV);
    let j = this.envN - 1;
    while (j >= oldest && this.envT[j % ENV] > hint) j--;
    if (j < oldest) return hint - 0.5;
    // step back out of any silence we landed in (up to 1.5 s) to reach the speech
    const limitSkip = hint - 1.5;
    while (j >= oldest && this.envV[j % ENV] < thr && this.envT[j % ENV] > limitSkip) j--;
    const limit = hint - 8;
    let run = 0;
    let runStart = j;
    for (; j >= oldest && this.envT[j % ENV] > limit; j--) {
      if (this.envV[j % ENV] < thr) {
        if (run === 0) runStart = j;
        run++;
        if (run >= 25) return this.envT[Math.min(runStart + 1, this.envN - 1) % ENV];
      } else run = 0;
    }
    return this.envT[Math.max(j + 1, oldest) % ENV] ?? hint - 0.5;
  }

  /** Play mono samples at an AudioContext time (pre-roll cue into headphones). */
  play(samples: Float32Array, when: number, gain = 1) {
    if (!samples.length) return;
    const buf = this.ctx.createBuffer(1, samples.length, this.sr);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.ctx.destination);
    src.start(Math.max(when, this.ctx.currentTime));
    this.playing.push(src);
    src.onended = () => (this.playing = this.playing.filter((p) => p !== src));
  }

  stopPlayback() {
    this.playing.forEach((p) => {
      try {
        p.stop();
      } catch {
        /* already stopped */
      }
    });
    this.playing = [];
  }

  stop() {
    this.src?.disconnect();
    this.src = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
