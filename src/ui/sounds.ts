/** Synthesized UI sounds (no asset files): tape rewind, slate clap, command blip, wrap chime. */

let ctx: AudioContext | null = null;
let enabled = true;

export function bindSounds(c: AudioContext) {
  ctx = c;
}
export function setSoundsEnabled(v: boolean) {
  enabled = v;
}

function out(gain: number) {
  const g = ctx!.createGain();
  g.gain.value = gain;
  g.connect(ctx!.destination);
  return g;
}

function noise(seconds: number) {
  const b = ctx!.createBuffer(1, Math.round(ctx!.sampleRate * seconds), ctx!.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx!.createBufferSource();
  s.buffer = b;
  return s;
}

export const sounds = {
  blip(pitch = 880) {
    if (!ctx || !enabled) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = out(0);
    o.type = 'sine';
    o.frequency.setValueAtTime(pitch, t);
    o.frequency.exponentialRampToValueAtTime(pitch * 1.25, t + 0.06);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.14);
  },
  rewind(seconds = 1.1) {
    if (!ctx || !enabled) return;
    const t = ctx.currentTime;
    const n = noise(seconds);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(3200, t + seconds * 0.7);
    bp.frequency.exponentialRampToValueAtTime(900, t + seconds);
    const g = out(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.12);
    g.gain.setValueAtTime(0.12, t + seconds * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    // reel flutter
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 18;
    lg.gain.value = 0.04;
    lfo.connect(lg).connect(g.gain);
    n.connect(bp).connect(g);
    n.start(t);
    lfo.start(t);
    lfo.stop(t + seconds);
  },
  clap() {
    if (!ctx || !enabled) return;
    const t = ctx.currentTime;
    const n = noise(0.12);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    const g = out(0);
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    n.connect(hp).connect(g);
    n.start(t);
  },
  tick() {
    sounds.blip(660);
  },
  /** Start-of-listening ping, like Flow's. */
  ping() {
    if (!ctx || !enabled) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = out(0);
    o.type = 'sine';
    o.frequency.setValueAtTime(1046.5, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.24);
  },
  chime() {
    if (!ctx || !enabled) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = out(0);
      o.type = 'triangle';
      o.frequency.value = f;
      const s = t + i * 0.09;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.07, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.9);
      o.connect(g);
      o.start(s);
      o.stop(s + 1);
    });
  },
};
