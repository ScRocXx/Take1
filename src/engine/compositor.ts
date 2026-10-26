import type { Rect } from '../lib/store';

/**
 * Draws what the viewer sees: the captured window, eased zoom to Stage Marks,
 * and an optional camera bubble. What you see in the preview is what is encoded.
 *
 * Frames are pulled with MediaStreamTrackProcessor (not a <video> element), so
 * capture keeps flowing while the Take1 tab is hidden.
 */

type Source = VideoFrame | HTMLVideoElement;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Compositor {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  W = 1920;
  H = 1080;
  private screen: Source | null = null;
  private camera: Source | null = null;
  private readers: { cancel: () => void }[] = [];
  private from: Rect;
  private to: Rect;
  private t0 = 0;
  private dur = 700;
  cameraOn = true;
  background = '#0E0D0C';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.setSize(1920, 1080);
    this.from = this.to = { x: 0, y: 0, w: this.W, h: this.H };
  }

  setSize(w: number, h: number) {
    const scale = Math.min(1, 1920 / w, 1080 / h);
    this.W = Math.max(2, Math.round((w * scale) / 2) * 2);
    this.H = Math.max(2, Math.round((h * scale) / 2) * 2);
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.from = this.to = { x: 0, y: 0, w: this.W, h: this.H };
  }

  attach(track: MediaStreamTrack, slot: 'screen' | 'camera') {
    const P = (window as any).MediaStreamTrackProcessor;
    if (P) {
      const reader = new P({ track }).readable.getReader() as ReadableStreamDefaultReader<VideoFrame>;
      let alive = true;
      this.readers.push({ cancel: () => ((alive = false), reader.cancel().catch(() => {})) });
      (async () => {
        while (alive) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          if (!alive) {
            value.close();
            break;
          }
          const prev = this[slot];
          this[slot] = value;
          if (prev && 'close' in prev) prev.close();
        }
      })().catch(() => {});
    } else {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream([track]);
      v.play().catch(() => {});
      this[slot] = v;
    }
    track.addEventListener('ended', () => this.detach(slot));
  }

  detach(slot: 'screen' | 'camera') {
    const s = this[slot];
    if (s && 'close' in s) s.close();
    this[slot] = null;
  }

  dispose() {
    this.readers.forEach((r) => r.cancel());
    this.readers = [];
    this.detach('screen');
    this.detach('camera');
  }

  get hasScreen() {
    return !!this.screen;
  }

  private dims(s: Source) {
    return s instanceof HTMLVideoElement
      ? { w: s.videoWidth || 1, h: s.videoHeight || 1 }
      : { w: s.displayWidth, h: s.displayHeight };
  }

  /** Where the whole source sits in the canvas (letterboxed "contain"). */
  private base(): Rect {
    if (!this.screen) return { x: 0, y: 0, w: this.W, h: this.H };
    const d = this.dims(this.screen);
    const s = Math.min(this.W / d.w, this.H / d.h);
    const w = d.w * s;
    const h = d.h * s;
    return { x: (this.W - w) / 2, y: (this.H - h) / 2, w, h };
  }

  /** Turn a normalized source rect (a Stage Mark) into a canvas-space view rect. */
  viewFor(mark: Rect | null): Rect {
    if (!mark) return { x: 0, y: 0, w: this.W, h: this.H };
    const b = this.base();
    let r = { x: b.x + mark.x * b.w, y: b.y + mark.y * b.h, w: mark.w * b.w, h: mark.h * b.h };
    // breathing room, then match the output aspect around the centre
    const pad = 0.06;
    r = { x: r.x - r.w * pad, y: r.y - r.h * pad, w: r.w * (1 + 2 * pad), h: r.h * (1 + 2 * pad) };
    const aspect = this.W / this.H;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    let w = Math.max(r.w, r.h * aspect);
    w = Math.max(w, this.W / 3.5); // never zoom past 3.5×
    w = Math.min(w, this.W);
    const h = w / aspect;
    const x = Math.min(Math.max(cx - w / 2, 0), this.W - w);
    const y = Math.min(Math.max(cy - h / 2, 0), this.H - h);
    return { x, y, w, h };
  }

  current(now = performance.now()): Rect {
    const t = Math.min(1, (now - this.t0) / this.dur);
    const k = ease(t);
    return {
      x: lerp(this.from.x, this.to.x, k),
      y: lerp(this.from.y, this.to.y, k),
      w: lerp(this.from.w, this.to.w, k),
      h: lerp(this.from.h, this.to.h, k),
    };
  }

  get target() {
    return this.to;
  }

  setView(v: Rect, animate = true) {
    const now = performance.now();
    this.from = animate ? this.current(now) : v;
    this.to = v;
    this.t0 = now;
  }

  draw(now = performance.now()) {
    const { ctx, W, H } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, W, H);
    if (!this.screen) {
      ctx.fillStyle = '#2A2724';
      ctx.font = `500 ${Math.round(H / 28)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('No window shared yet', W / 2, H / 2);
      return;
    }
    const v = this.current(now);
    const s = W / v.w;
    const b = this.base();
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(s, 0, 0, s, -v.x * s, -v.y * s);
    try {
      ctx.drawImage(this.screen as CanvasImageSource, b.x, b.y, b.w, b.h);
    } catch {
      /* frame closed mid-draw */
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.cameraOn && this.camera) this.drawCamera();
  }

  private drawCamera() {
    const { ctx, W, H } = this;
    const c = this.camera!;
    const d = this.dims(c);
    const size = Math.round(H * 0.22);
    const m = Math.round(H * 0.035);
    const x = W - size - m;
    const y = H - size - m;
    const side = Math.min(d.w, d.h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    try {
      // mirror the selfie view
      ctx.translate(x + size, y);
      ctx.scale(-1, 1);
      ctx.drawImage(c as CanvasImageSource, (d.w - side) / 2, (d.h - side) / 2, side, side, 0, 0, size, size);
    } catch {
      /* ignore */
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, H / 360);
    ctx.strokeStyle = 'rgba(242,237,228,0.22)';
    ctx.stroke();
  }

  /** Raw (un-zoomed) source frame as a data URL, for drawing Stage Marks. */
  freezeSource(maxW = 1280): { url: string; aspect: number } | null {
    if (!this.screen) return null;
    const d = this.dims(this.screen);
    const s = Math.min(1, maxW / d.w);
    const c = document.createElement('canvas');
    c.width = Math.round(d.w * s);
    c.height = Math.round(d.h * s);
    c.getContext('2d')!.drawImage(this.screen as CanvasImageSource, 0, 0, c.width, c.height);
    return { url: c.toDataURL('image/jpeg', 0.85), aspect: d.w / d.h };
  }
}

/** 64×36 grayscale signature, used to score how well the live screen matches the splice frame. */
export function signature(src: CanvasImageSource, w = 64, h = 36): Float32Array {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
  return out;
}

export function matchScore(a: Float32Array, b: Float32Array) {
  let mad = 0;
  for (let i = 0; i < a.length; i++) mad += Math.abs(a[i] - b[i]);
  mad /= a.length;
  return Math.max(0, Math.min(1, 1 - mad / 0.18));
}
