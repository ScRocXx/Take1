import type { Rect } from '../lib/store';

/**
 * Page-side handle for the compositor worker (compositor.worker.ts). The page only
 * keeps the view geometry and the latest preview bitmap; drawing, zooming, the
 * camera bubble, encoding, thumbnails and screen matching all run in the worker.
 */

export type Mask = { cx: number; cy: number; r: number } | null;

export interface EncodedChunkMsg {
  data: ArrayBuffer;
  ts: number;
  dur: number;
  key: boolean;
  config?: VideoDecoderConfig;
}

export class Compositor {
  W = 1920;
  H = 1080;
  cameraOn = true;
  /** latest downscaled frame of the output picture, for on-screen previews */
  latest: ImageBitmap | null = null;
  onChunk: ((c: EncodedChunkMsg) => void) | null = null;
  onMatch: ((score: number) => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  private worker: Worker;
  private src = { w: 0, h: 0 };
  private hasCamera = false;
  private to: Rect = { x: 0, y: 0, w: 1920, h: 1080 };
  private seq = 0;
  private pending = new Map<number, (d: any) => void>();

  constructor() {
    this.worker = new Worker(new URL('./compositor.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.setSize(1920, 1080);
  }

  private onMessage(d: any) {
    switch (d.type) {
      case 'preview':
        this.latest?.close();
        this.latest = d.bmp;
        break;
      case 'chunk':
        this.onChunk?.(d);
        break;
      case 'source':
        this.src = { w: d.w, h: d.h };
        break;
      case 'match':
        this.onMatch?.(d.score);
        break;
      case 'error':
        this.onError?.(d.message);
        break;
      case 'reply': {
        const r = this.pending.get(d.id);
        this.pending.delete(d.id);
        r?.(d);
        break;
      }
    }
  }

  private ask<T = any>(msg: any): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (d) => (d.error ? reject(new Error(d.error)) : resolve(d)));
      this.worker.postMessage({ ...msg, id });
    });
  }

  setSize(w: number, h: number) {
    const k = Math.min(1, 1920 / w, 1080 / h);
    this.W = Math.max(2, Math.round((w * k) / 2) * 2);
    this.H = Math.max(2, Math.round((h * k) / 2) * 2);
    this.to = { x: 0, y: 0, w: this.W, h: this.H };
    this.worker.postMessage({ type: 'size', w: this.W, h: this.H });
  }

  attach(track: MediaStreamTrack, slot: 'screen' | 'camera') {
    const P = (window as any).MediaStreamTrackProcessor;
    if (!P) throw new Error('This browser can’t process video frames. Use Chrome or Edge.');
    const readable = new P({ track }).readable as ReadableStream<VideoFrame>;
    this.worker.postMessage({ type: 'attach', slot, readable }, [readable as unknown as Transferable]);
    if (slot === 'camera') this.hasCamera = true;
    else {
      const s = track.getSettings();
      this.src = { w: s.width ?? 0, h: s.height ?? 0 };
    }
    track.addEventListener('ended', () => this.detach(slot));
  }

  detach(slot: 'screen' | 'camera') {
    this.worker.postMessage({ type: 'detach', slot });
    if (slot === 'camera') this.hasCamera = false;
    else this.src = { w: 0, h: 0 };
  }

  get hasScreen() {
    return this.src.w > 0;
  }

  setCamera(on: boolean) {
    this.cameraOn = on;
    this.worker.postMessage({ type: 'camera', on });
  }

  /** Where the whole window sits in the output frame (letterboxed). */
  private base(): Rect {
    if (!this.src.w) return { x: 0, y: 0, w: this.W, h: this.H };
    const k = Math.min(this.W / this.src.w, this.H / this.src.h);
    const w = this.src.w * k;
    const h = this.src.h * k;
    return { x: (this.W - w) / 2, y: (this.H - h) / 2, w, h };
  }

  /** Turn a normalised box on the window into the output-space view that frames it. */
  viewFor(box: Rect | null): Rect {
    if (!box) return { x: 0, y: 0, w: this.W, h: this.H };
    const b = this.base();
    let r = { x: b.x + box.x * b.w, y: b.y + box.y * b.h, w: box.w * b.w, h: box.h * b.h };
    const pad = 0.06;
    r = { x: r.x - r.w * pad, y: r.y - r.h * pad, w: r.w * (1 + 2 * pad), h: r.h * (1 + 2 * pad) };
    const aspect = this.W / this.H;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    let w = Math.max(r.w, r.h * aspect);
    w = Math.max(w, this.W / 3.5); // never zoom past 3.5×
    w = Math.min(w, this.W);
    const h = w / aspect;
    return { x: Math.min(Math.max(cx - w / 2, 0), this.W - w), y: Math.min(Math.max(cy - h / 2, 0), this.H - h), w, h };
  }

  get target() {
    return this.to;
  }

  setView(v: Rect, animate = true) {
    this.to = v;
    this.worker.postMessage({ type: 'view', rect: v, animate });
  }

  /** Where the camera bubble sits, normalised, so screen matching can ignore it. */
  cameraMask(): Mask {
    if (!this.cameraOn || !this.hasCamera) return null;
    const size = this.H * 0.22;
    const m = this.H * 0.035;
    return { cx: (this.W - m - size / 2) / this.W, cy: (this.H - m - size / 2) / this.H, r: size / 2 / this.H };
  }

  async configure(fps: number, bitrate: number): Promise<string> {
    return (await this.ask({ type: 'configure', fps, bitrate })).codec;
  }

  encode(ts: number, dur: number, key: boolean) {
    this.worker.postMessage({ type: 'encode', ts, dur, key });
  }

  private viewers = 0;
  /** A preview on screen started showing the picture; returns the matching "stopped". */
  watch() {
    this.worker.postMessage({ type: 'viewers', count: ++this.viewers });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.worker.postMessage({ type: 'viewers', count: --this.viewers });
    };
  }

  /** Close the encoder once a recording is finished (sharing a window configures a new one). */
  async release() {
    await this.ask({ type: 'release' });
  }

  /** Resolves after every chunk encoded so far has been delivered to onChunk. */

  async flush() {
    await this.ask({ type: 'flush' });
  }

  async snapshot(width = 480): Promise<Blob | null> {
    try {
      return (await this.ask({ type: 'snapshot', width })).blob;
    } catch {
      return null;
    }
  }

  /** A still of the raw window ('source') or of the recorded picture ('output'). */
  async freeze(which: 'source' | 'output'): Promise<{ url: string; aspect: number } | null> {
    const d = await this.ask({ type: 'freeze', which });
    if (!d.blob) return null;
    return { url: URL.createObjectURL(d.blob), aspect: d.aspect };
  }

  /** Start (or stop, with null) scoring the live picture against a reference frame. */
  async setMatchRef(src: ImageBitmap | Blob | null) {
    if (!src) return this.worker.postMessage({ type: 'matchRef', bitmap: null, mask: null });
    const bitmap = await createImageBitmap(src);
    this.worker.postMessage({ type: 'matchRef', bitmap, mask: this.cameraMask() }, [bitmap]);
  }
}
