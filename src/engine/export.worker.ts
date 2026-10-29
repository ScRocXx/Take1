/// <reference lib="webworker" />
/**
 * Builds MP4 files off the UI thread.
 *  - Copy path: the recorded chunks go straight into the file (no re-encode).
 *  - Render path: decode → draw (blur boxes, burned-in captions, outtake labels) → re-encode.
 *  - Audio: mute spoken commands, level speech to about −16 LUFS, encode AAC (Opus fallback).
 *  - Mux: interleaved MP4 with chapters (mp4.ts).
 */
import { muxMp4, type MuxSample, type MuxChapter } from './mp4';
import { decodeRun, queueBelow, type Chunk } from './video';
import { drawCaptions, type CaptionStyle, type Group } from '../lib/captions';

type Rect = { x: number; y: number; w: number; h: number };

export interface ExportJob {
  id: number;
  width: number;
  height: number;
  codec: string;
  config: VideoDecoderConfig | null;
  clips: { chunks: Chunk[]; from: number; to: number; label?: string }[];
  render: boolean;
  redactions: { start: number; end: number; rect: Rect }[];
  /** styled captions to draw in: what's on screen when, and how it looks */
  captions: Group[];
  captionStyle: CaptionStyle | null;
  /** the caption font file (ships with the app; absolute URL) */
  captionFont: { family: string; weight: number; url: string } | null;
  pcm: Float32Array;
  sampleRate: number;
  scrubs: { start: number; end: number }[];
  level: boolean;
  chapters: MuxChapter[];
}

const progress = (id: number, p: number) => postMessage({ type: 'progress', id, p });

// ───────────────── fonts (caption fonts ship with the app; no network) ─────────────────

const fontsLoaded = new Map<string, Promise<void>>();
function loadFont(f: ExportJob['captionFont']) {
  if (!f) return Promise.resolve();
  let p = fontsLoaded.get(f.url);
  if (!p) {
    p = (async () => {
      try {
        const face = new FontFace(f.family, `url(${f.url})`, { weight: String(f.weight) });
        (self as any).fonts.add(face);
        await face.load();
      } catch {
        /* missing file: the style's fallback family draws instead */
      }
    })();
    fontsLoaded.set(f.url, p);
  }
  return p;
}

// ───────────────── audio ─────────────────

function processAudio(pcm: Float32Array, sr: number, scrubs: { start: number; end: number }[], level: boolean) {
  const out = pcm;
  const fade = Math.round(sr * 0.01);
  for (const s of scrubs) {
    const a = Math.max(0, Math.round(s.start * sr));
    const b = Math.min(out.length, Math.round(s.end * sr));
    for (let i = a; i < b; i++) {
      const k = Math.min(1, (i - a) / fade, (b - i) / fade);
      out[i] *= 1 - Math.max(0, Math.min(1, k));
    }
  }
  if (!level) return out;
  // loudness over speech-active 50 ms windows (approximates gated loudness)
  const win = Math.round(sr * 0.05);
  let sum = 0;
  let n = 0;
  let peak = 0;
  for (let i = 0; i + win <= out.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) {
      e += out[j] * out[j];
      peak = Math.max(peak, Math.abs(out[j]));
    }
    if (Math.sqrt(e / win) > 0.01) {
      sum += e;
      n += win;
    }
  }
  if (n > sr * 0.5) {
    const rms = Math.sqrt(sum / n);
    const target = Math.pow(10, -16 / 20) * 0.75;
    const gain = Math.min(target / rms, (0.89 / Math.max(peak, 1e-6)) * 1.6, 8);
    for (let i = 0; i < out.length; i++) {
      const v = out[i] * gain;
      out[i] = Math.abs(v) < 0.8 ? v : Math.sign(v) * (0.8 + 0.19 * Math.tanh((Math.abs(v) - 0.8) / 0.19));
    }
  }
  return out;
}

async function encodeAudio(pcm: Float32Array, sampleRate: number, onProgress?: (p: number) => void) {
  const tries = [
    { codec: 'aac' as const, cfg: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: 1, bitrate: 128000 } },
    { codec: 'opus' as const, cfg: { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 } },
  ];
  let pick: (typeof tries)[number] | null = null;
  for (const t of tries) {
    try {
      if ((await AudioEncoder.isConfigSupported(t.cfg)).supported) {
        pick = t;
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!pick || !pcm.length) return null;
  const samples: MuxSample[] = [];
  let description: AllowSharedBufferSource | undefined;
  let err: unknown = null;
  const encoder = new AudioEncoder({
    output: (c, meta) => {
      if (meta?.decoderConfig?.description) description = meta.decoderConfig.description;
      const data = new Uint8Array(c.byteLength);
      c.copyTo(data);
      samples.push({ data, ts: c.timestamp, dur: c.duration ?? 0, key: true });
    },
    error: (e) => (err = e),
  });
  encoder.configure(pick.cfg);
  const block = 4800;
  for (let i = 0; i < pcm.length; i += block) {
    const part = pcm.slice(i, Math.min(pcm.length, i + block));
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((i / sampleRate) * 1e6), data: part });
    encoder.encode(ad);
    ad.close();
    await queueBelow(encoder, () => encoder.encodeQueueSize, 20);
    // long recordings take a while to encode: keep reporting so it never looks stuck
    if ((i / block) % 100 === 0) onProgress?.(i / pcm.length);
  }
  await encoder.flush();
  encoder.close();
  if (err) throw err;
  samples.forEach((s, i) => {
    if (!s.dur) s.dur = i + 1 < samples.length ? samples[i + 1].ts - s.ts : 20000;
  });
  return { codec: pick.codec, sampleRate: pick.codec === 'opus' ? 48000 : sampleRate, description, samples };
}

// ───────────────── video render ─────────────────

const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f', 'vp09.00.40.08', 'vp09.00.10.08'];

async function makeEncoder(width: number, height: number, out: Chunk[]) {
  let config: VideoDecoderConfig | null = null;
  for (const codec of CODECS) {
    const cfg = { codec, width, height, bitrate: 6_000_000, framerate: 30, ...(codec.startsWith('avc') ? { avc: { format: 'avc' } } : {}) } as VideoEncoderConfig;
    if (!(await VideoEncoder.isConfigSupported(cfg)).supported) continue;
    const enc = new VideoEncoder({
      output: (c, meta) => {
        if (meta?.decoderConfig) config = meta.decoderConfig;
        const data = new Uint8Array(c.byteLength);
        c.copyTo(data);
        out.push({ data, ts: c.timestamp, dur: c.duration ?? 0, key: c.type === 'key' });
      },
      error: () => {},
    });
    enc.configure(cfg);
    return { enc, codec, config: () => config };
  }
  throw new Error('This browser cannot encode video.');
}

function drawLabel(ctx: OffscreenCanvasRenderingContext2D, label: string, H: number) {
  const s = H / 1080;
  ctx.save();
  ctx.font = `600 ${Math.round(30 * s)}px Figtree, system-ui, sans-serif`;
  const w = ctx.measureText(label).width + 56 * s;
  ctx.fillStyle = 'rgba(14,13,12,0.82)';
  ctx.beginPath();
  ctx.roundRect(40 * s, 40 * s, w, 64 * s, 32 * s);
  ctx.fill();
  ctx.fillStyle = '#c8362c';
  ctx.beginPath();
  ctx.arc(64 * s, 72 * s, 9 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffeb';
  ctx.fillText(label, 84 * s, 82 * s);
  ctx.restore();
}

async function render(job: ExportJob) {
  if (job.captions.length) await loadFont(job.captionFont);
  const { width: W, height: H } = job;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const out: Chunk[] = [];
  const { enc, codec, config } = await makeEncoder(W, H, out);
  const total = job.clips.reduce((a, c) => a + (c.to - c.from), 0) || 1;
  let offset = 0;
  let lastOut = -1;
  for (const clip of job.clips) {
    let first = true;
    await decodeRun(job.config!, clip.chunks, async (f) => {
      const ts = f.timestamp;
      if (ts < clip.from || ts >= clip.to) return f.close();
      ctx.drawImage(f, 0, 0, W, H);
      const sec = (offset + ts - clip.from) / 1e6;
      for (const r of job.redactions) {
        if (sec < r.start || sec > r.end) continue;
        const x = r.rect.x * W;
        const y = r.rect.y * H;
        const w = r.rect.w * W;
        const h = r.rect.h * H;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.filter = `blur(${Math.round(H / 40)}px)`;
        ctx.drawImage(f, 0, 0, W, H);
        ctx.filter = 'none';
        ctx.restore();
      }
      if (clip.label && ts - clip.from < 1_200_000) drawLabel(ctx, clip.label, H);
      if (job.captionStyle && job.captions.length) drawCaptions(ctx, W, H, sec, job.captions, job.captionStyle);
      f.close();
      let outTs = Math.round(offset + ts - clip.from);
      if (outTs <= lastOut) outTs = lastOut + 1;
      lastOut = outTs;
      const vf = new VideoFrame(canvas, { timestamp: outTs, duration: 33333 });
      await queueBelow(enc, () => enc.encodeQueueSize, 4);
      enc.encode(vf, { keyFrame: first });
      vf.close();
      first = false;
      progress(job.id, Math.min(0.85, ((offset + ts - clip.from) / total) * 0.85));
    });
    offset += clip.to - clip.from;
  }
  await enc.flush();
  enc.close();
  return { codec, chunks: out, description: config()?.description };
}

self.onmessage = async (e: MessageEvent<ExportJob>) => {
  const job = e.data;
  try {
    progress(job.id, 0.02);
    let video: { codec: string; chunks: Chunk[]; description?: AllowSharedBufferSource } | null = null;
    if (job.render && job.config) video = await render(job);
    else if (job.clips[0]) video = { codec: job.codec, chunks: job.clips[0].chunks, description: job.config?.description };
    progress(job.id, 0.88);
    const audio = await encodeAudio(processAudio(job.pcm, job.sampleRate, job.scrubs, job.level), job.sampleRate, (p) => progress(job.id, 0.88 + p * 0.08));
    progress(job.id, 0.96);
    const t0 = video?.chunks[0]?.ts ?? 0;
    const blob = muxMp4(
      video ? { codec: video.codec, width: job.width, height: job.height, description: video.description, samples: video.chunks.map((c) => ({ data: c.data, ts: c.ts - t0, dur: c.dur, key: c.key })) } : null,
      audio ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: 1, description: audio.description, samples: audio.samples } : null,
      job.chapters,
    );
    postMessage({ type: 'done', id: job.id, blob });
  } catch (err) {
    postMessage({ type: 'error', id: job.id, message: String((err as Error)?.message ?? err) });
  }
};
