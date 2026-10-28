/// <reference lib="webworker" />
/**
 * Compositing + encoding, off the UI thread.
 *
 * Frames from the shared window and the camera arrive as transferred
 * ReadableStream<VideoFrame> (MediaStreamTrackProcessor on the page). This worker
 * draws the output picture (zoom, camera bubble) on an OffscreenCanvas, encodes
 * the frames the page asks for, sends a downscaled preview ~30×/s, makes thumbnails
 * on request, and scores how closely the screen matches a reference frame.
 */

type Rect = { x: number; y: number; w: number; h: number };
type Slot = 'screen' | 'camera';
type Mask = { cx: number; cy: number; r: number } | null;

let W = 1920;
let H = 1080;
let canvas = new OffscreenCanvas(W, H);
let ctx = canvas.getContext('2d', { alpha: false })!;
const latestFrame: Record<Slot, VideoFrame | null> = { screen: null, camera: null };
const readers: Partial<Record<Slot, ReadableStreamDefaultReader<VideoFrame>>> = {};
let cameraOn = true;
let from: Rect = { x: 0, y: 0, w: W, h: H };
let to: Rect = from;
let t0 = 0;
const DUR = 700;
let encoder: VideoEncoder | null = null;
let matchRef: Float32Array | null = null;
let matchMask: Mask = null;
let tick = 0;
let previewW = 1280;
let previewBusy = false;
/** how many on-screen previews are showing the picture (0 = don't make previews) */
let viewers = 0;
/** when the canvas was last drawn, and whether that drawing has been sent as a preview */
let lastDraw = 0;
let fresh = false;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function current(now: number): Rect {
  const k = ease(Math.min(1, (now - t0) / DUR));
  return { x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), w: lerp(from.w, to.w, k), h: lerp(from.h, to.h, k) };
}

function base(): Rect {
  const s = latestFrame.screen;
  if (!s) return { x: 0, y: 0, w: W, h: H };
  const k = Math.min(W / s.displayWidth, H / s.displayHeight);
  const w = s.displayWidth * k;
  const h = s.displayHeight * k;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function draw(now = performance.now()) {
  lastDraw = now;
  fresh = true;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0e0d0c';
  ctx.fillRect(0, 0, W, H);
  const s = latestFrame.screen;
  if (!s) return;
  const v = current(now);
  const k = W / v.w;
  const b = base();
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(k, 0, 0, k, -v.x * k, -v.y * k);
  try {
    ctx.drawImage(s, b.x, b.y, b.w, b.h);
  } catch {
    /* frame closed mid-draw */
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const c = latestFrame.camera;
  if (cameraOn && c) {
    const size = Math.round(H * 0.22);
    const m = Math.round(H * 0.035);
    const x = W - size - m;
    const y = H - size - m;
    const side = Math.min(c.displayWidth, c.displayHeight);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    try {
      ctx.translate(x + size, y);
      ctx.scale(-1, 1); // mirror the selfie view
      ctx.drawImage(c, (c.displayWidth - side) / 2, (c.displayHeight - side) / 2, side, side, 0, 0, size, size);
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
}

/** 64×36 grayscale, NaN where the camera bubble is (it moves with you; the screen doesn't). */
function signature(src: CanvasImageSource, mask: Mask, w = 64, h = 36) {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const px = (i % w) / w;
    const py = Math.floor(i / w) / h;
    if (mask && Math.hypot((px - mask.cx) * (w / h), py - mask.cy) < mask.r * 1.15) out[i] = NaN;
    else out[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
  }
  return out;
}

/** Share of 8×6-pixel regions that look the same (0..1). */
function matchScore(a: Float32Array, b: Float32Array, w = 64, h = 36) {
  let cells = 0;
  let same = 0;
  for (let cy = 0; cy < h; cy += 6)
    for (let cx = 0; cx < w; cx += 8) {
      let diff = 0;
      let n = 0;
      for (let y = cy; y < Math.min(h, cy + 6); y++)
        for (let x = cx; x < Math.min(w, cx + 8); x++) {
          const i = y * w + x;
          if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue;
          diff += Math.abs(a[i] - b[i]);
          n++;
        }
      if (n < 8) continue;
      cells++;
      if (diff / n < 0.045) same++;
    }
  return cells ? same / cells : 0;
}

async function attach(slot: Slot, readable: ReadableStream<VideoFrame>) {
  detach(slot);
  const reader = readable.getReader();
  readers[slot] = reader;
  let lastW = 0;
  let lastH = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      if (readers[slot] !== reader) {
        value.close();
        break;
      }
      latestFrame[slot]?.close();
      latestFrame[slot] = value;
      if (slot === 'screen' && (value.displayWidth !== lastW || value.displayHeight !== lastH)) {
        lastW = value.displayWidth;
        lastH = value.displayHeight;
        postMessage({ type: 'source', w: lastW, h: lastH });
      }
    }
  } catch {
    /* stream cancelled */
  }
  if (readers[slot] === reader) {
    latestFrame[slot]?.close();
    latestFrame[slot] = null;
    delete readers[slot];
    if (slot === 'screen') postMessage({ type: 'source', w: 0, h: 0 });
  }
}

function detach(slot: Slot) {
  const r = readers[slot];
  delete readers[slot];
  r?.cancel().catch(() => {});
  latestFrame[slot]?.close();
  latestFrame[slot] = null;
}

const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f', 'vp09.00.40.08', 'vp09.00.10.08'];

async function configure(fps: number, bitrate: number) {
  if (encoder && encoder.state !== 'closed') encoder.close();
  encoder = null;
  for (const codec of CODECS) {
    const cfg = { codec, width: W, height: H, bitrate, framerate: fps, latencyMode: 'realtime', ...(codec.startsWith('avc') ? { avc: { format: 'avc' } } : {}) } as VideoEncoderConfig;
    try {
      if (!(await VideoEncoder.isConfigSupported(cfg)).supported) continue;
      encoder = new VideoEncoder({
        output: (chunk, meta) => {
          const data = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(data);
          let config: VideoDecoderConfig | undefined;
          if (meta?.decoderConfig) {
            const d = meta.decoderConfig.description;
            config = { ...meta.decoderConfig, description: d ? (ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : (d as ArrayBuffer).slice(0)) : undefined };
          }
          postMessage({ type: 'chunk', data, ts: chunk.timestamp, dur: chunk.duration ?? 0, key: chunk.type === 'key', config }, [data]);
        },
        error: (e) => postMessage({ type: 'error', message: String(e) }),
      });
      encoder.configure(cfg);
      return codec;
    } catch {
      /* next */
    }
  }
  throw new Error('This browser cannot encode H.264 or VP9 video. Use Chrome or Edge on a computer.');
}

async function toBlob(src: CanvasImageSource, w: number, h: number, q = 0.8) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d')!.drawImage(src, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/jpeg', quality: q });
}

/**
 * One drawing per frame. While recording, the page's 'encode' requests draw the
 * frame and the preview reuses that exact picture. When nothing is being encoded
 * (before recording, paused, replay), this timer draws instead, but only if
 * someone is looking at a preview or the screen match is running.
 */
setInterval(async () => {
  const now = performance.now();
  const needed = viewers > 0 || matchRef !== null;
  if (needed && now - lastDraw > 30) draw(now);
  if (!fresh) return;
  tick++;
  if (matchRef && tick % 6 === 0) postMessage({ type: 'match', score: matchScore(matchRef, signature(canvas, matchMask)) });
  if (viewers === 0 || previewBusy) return;
  fresh = false;
  previewBusy = true;
  try {
    const pw = Math.min(previewW, W);
    const bmp = await createImageBitmap(canvas, { resizeWidth: pw, resizeHeight: Math.round((pw * H) / W), resizeQuality: 'medium' });
    postMessage({ type: 'preview', bmp }, [bmp]);
  } catch {
    /* canvas not ready */
  }
  previewBusy = false;
}, 33);

/** Make sure the canvas shows the current picture before reading it (stills, thumbnails). */
function ensureDrawn() {
  if (performance.now() - lastDraw > 30) draw();
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'size':
        W = m.w;
        H = m.h;
        canvas = new OffscreenCanvas(W, H);
        ctx = canvas.getContext('2d', { alpha: false })!;
        from = to = { x: 0, y: 0, w: W, h: H };
        break;
      case 'attach':
        attach(m.slot, m.readable);
        break;
      case 'detach':
        detach(m.slot);
        break;
      case 'view': {
        const now = performance.now();
        from = m.animate ? current(now) : m.rect;
        to = m.rect;
        t0 = now;
        break;
      }
      case 'camera':
        cameraOn = m.on;
        break;
      case 'preview':
        previewW = m.width;
        break;
      case 'viewers':
        viewers = Math.max(0, m.count);
        break;
      case 'configure':
        postMessage({ type: 'reply', id: m.id, codec: await configure(m.fps, m.bitrate) });
        break;
      case 'encode': {
        if (!encoder || encoder.state !== 'configured') break;
        if (encoder.encodeQueueSize > 6) {
          postMessage({ type: 'dropped', ts: m.ts });
          break;
        }
        draw();
        const vf = new VideoFrame(canvas, { timestamp: m.ts, duration: m.dur });
        encoder.encode(vf, { keyFrame: m.key });
        vf.close();
        break;
      }
      case 'flush':
        if (encoder?.state === 'configured') await encoder.flush();
        postMessage({ type: 'reply', id: m.id });
        break;
      case 'release':
        // recording finished: free the (often hardware) encoder so exports can use one
        if (encoder?.state === 'configured') await encoder.flush();
        if (encoder && encoder.state !== 'closed') encoder.close();
        encoder = null;
        postMessage({ type: 'reply', id: m.id });
        break;
      case 'snapshot': {
        ensureDrawn();
        const w = m.width;
        const blob = await toBlob(canvas, w, Math.round((w * H) / W), 0.72);
        postMessage({ type: 'reply', id: m.id, blob });
        break;
      }
      case 'freeze': {
        // 'source': the raw window (for zoom boxes); 'output': what's being recorded (for blur boxes)
        if (m.which !== 'source') ensureDrawn();
        const src = m.which === 'source' ? latestFrame.screen : canvas;
        if (!src) {
          postMessage({ type: 'reply', id: m.id, blob: null });
          break;
        }
        const sw: number = src instanceof VideoFrame ? src.displayWidth : src.width;
        const sh: number = src instanceof VideoFrame ? src.displayHeight : src.height;
        const k = Math.min(1, 1600 / sw);
        const blob = await toBlob(src, Math.round(sw * k), Math.round(sh * k), 0.85);
        postMessage({ type: 'reply', id: m.id, blob, aspect: sw / sh });
        break;
      }
      case 'matchRef':
        matchMask = m.mask;
        matchRef = m.bitmap ? signature(m.bitmap, m.mask) : null;
        m.bitmap?.close();
        break;
    }
  } catch (err) {
    if (m.id) postMessage({ type: 'reply', id: m.id, error: String((err as Error)?.message ?? err) });
  }
};
