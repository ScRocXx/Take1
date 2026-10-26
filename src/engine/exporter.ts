import { muxMp4, type MuxSample } from './mp4';
import { decodeRun, VideoTape, type Chunk } from './videoTape';
import type { Rect } from '../lib/store';

export interface AudioPrep {
  pcm: Float32Array;
  sampleRate: number;
  scrubs: { start: number; end: number }[]; // seconds, muted with 10 ms fades
}

/** Mute spoken commands, then normalize speech loudness to ≈ -16 LUFS with a peak ceiling. */
export function processAudio({ pcm, sampleRate, scrubs }: AudioPrep): Float32Array {
  const out = pcm.slice();
  const fade = Math.round(sampleRate * 0.01);
  for (const s of scrubs) {
    const a = Math.max(0, Math.round(s.start * sampleRate));
    const b = Math.min(out.length, Math.round(s.end * sampleRate));
    for (let i = a; i < b; i++) {
      const k = Math.min(1, (i - a) / fade, (b - i) / fade);
      out[i] *= 1 - Math.max(0, Math.min(1, k));
    }
  }
  // loudness: RMS over speech-active 50 ms windows (approximates gated loudness)
  const win = Math.round(sampleRate * 0.05);
  let sum = 0;
  let n = 0;
  let peak = 0;
  for (let i = 0; i + win <= out.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) {
      e += out[j] * out[j];
      peak = Math.max(peak, Math.abs(out[j]));
    }
    const r = Math.sqrt(e / win);
    if (r > 0.01) {
      sum += e;
      n += win;
    }
  }
  if (n > sampleRate * 0.5) {
    const rms = Math.sqrt(sum / n);
    const target = Math.pow(10, -16 / 20) * 0.75; // speech RMS ≈ LUFS - ~2.5 dB
    let gain = target / rms;
    gain = Math.min(gain, 0.89 / Math.max(peak, 1e-6) * 1.6, 8); // allow soft-limited peaks
    for (let i = 0; i < out.length; i++) {
      const v = out[i] * gain;
      out[i] = Math.abs(v) < 0.8 ? v : Math.sign(v) * (0.8 + 0.19 * Math.tanh((Math.abs(v) - 0.8) / 0.19));
    }
  }
  return out;
}

async function pickAudioCodec(sampleRate: number) {
  const tries: { codec: 'aac' | 'opus'; cfg: AudioEncoderConfig }[] = [
    { codec: 'aac', cfg: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: 1, bitrate: 128000 } },
    { codec: 'opus', cfg: { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 } },
  ];
  for (const t of tries) {
    try {
      if ((await AudioEncoder.isConfigSupported(t.cfg)).supported) return t;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function encodeAudio(pcm: Float32Array, sampleRate: number) {
  const pick = await pickAudioCodec(sampleRate);
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
    const part = pcm.subarray(i, Math.min(pcm.length, i + block));
    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: part.length,
      numberOfChannels: 1,
      timestamp: Math.round((i / sampleRate) * 1e6),
      data: part.slice(),
    });
    encoder.encode(ad);
    ad.close();
    if (encoder.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 1));
  }
  await encoder.flush();
  encoder.close();
  if (err) throw err;
  // fill missing durations from timestamps
  samples.forEach((s, i) => {
    if (!s.dur) s.dur = i + 1 < samples.length ? samples[i + 1].ts - s.ts : 20000;
  });
  return { codec: pick.codec, sampleRate: pick.codec === 'opus' ? 48000 : sampleRate, description, samples };
}

export interface Clip {
  chunks: Chunk[]; // starts at a keyframe
  from: number; // µs, first visible frame
  to: number; // µs, end (exclusive)
  label?: string;
}

export interface RenderOptions {
  config: VideoDecoderConfig;
  width: number;
  height: number;
  clips: Clip[];
  redactions?: { start: number; end: number; rect: Rect }[]; // seconds on the output timeline
  onProgress?: (p: number) => void;
}

/** Decode → draw (blur redactions, outtake badges) → re-encode. Used for redaction and the blooper reel. */
export async function renderClips(o: RenderOptions) {
  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const ctx = canvas.getContext('2d')!;
  const tape = new VideoTape(30, 5_000_000);
  await tape.configure(o.width, o.height);
  const total = o.clips.reduce((a, c) => a + (c.to - c.from), 0) || 1;
  let offset = 0;
  let done = 0;
  let lastOut = -1;
  for (const clip of o.clips) {
    let first = true;
    await decodeRun(o.config, clip.chunks, async (f) => {
      const ts = f.timestamp;
      if (ts < clip.from || ts >= clip.to) {
        f.close();
        return;
      }
      ctx.drawImage(f, 0, 0, o.width, o.height);
      const outSec = (offset + ts - clip.from) / 1e6;
      for (const r of o.redactions ?? []) {
        if (outSec < r.start || outSec > r.end) continue;
        const x = r.rect.x * o.width;
        const y = r.rect.y * o.height;
        const w = r.rect.w * o.width;
        const h = r.rect.h * o.height;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.filter = `blur(${Math.round(o.height / 40)}px)`;
        ctx.drawImage(f, 0, 0, o.width, o.height);
        ctx.filter = 'none';
        ctx.fillStyle = 'rgba(14,13,12,0.25)';
        ctx.fillRect(x, y, w, h);
        ctx.restore();
      }
      if (clip.label && ts - clip.from < 1_200_000) drawBadge(ctx, clip.label, o.height);
      f.close();
      let outTs = Math.round(offset + ts - clip.from);
      if (outTs <= lastOut) outTs = lastOut + 1;
      lastOut = outTs;
      const vf = new VideoFrame(canvas, { timestamp: outTs, duration: 33333 });
      while (tape.busy) await new Promise((r) => setTimeout(r, 1));
      tape.encode(vf, first);
      vf.close();
      first = false;
      done = offset + ts - clip.from;
      o.onProgress?.(Math.min(0.99, done / total));
    });
    offset += clip.to - clip.from;
  }
  await tape.flush();
  tape.close();
  return { chunks: tape.chunks, codec: tape.codec, description: tape.decoderConfig?.description, duration: offset };
}

function drawBadge(ctx: CanvasRenderingContext2D, label: string, H: number) {
  const s = H / 1080;
  ctx.save();
  ctx.font = `600 ${Math.round(30 * s)}px "JetBrains Mono", monospace`;
  const w = ctx.measureText(label).width + 56 * s;
  ctx.fillStyle = 'rgba(14,13,12,0.82)';
  ctx.beginPath();
  ctx.roundRect(40 * s, 40 * s, w, 64 * s, 32 * s);
  ctx.fill();
  ctx.fillStyle = '#FF3B30';
  ctx.beginPath();
  ctx.arc(64 * s, 72 * s, 9 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#F2EDE4';
  ctx.fillText(label, 84 * s, 82 * s);
  ctx.restore();
}

export function buildMp4(
  video: { codec: string; width: number; height: number; description?: AllowSharedBufferSource; chunks: Chunk[] },
  audio: Awaited<ReturnType<typeof encodeAudio>>,
) {
  const t0 = video.chunks[0]?.ts ?? 0;
  return muxMp4(
    {
      codec: video.codec,
      width: video.width,
      height: video.height,
      description: video.description,
      samples: video.chunks.map((c) => ({ data: c.data, ts: c.ts - t0, dur: c.dur, key: c.key })),
    },
    audio ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: 1, description: audio.description, samples: audio.samples } : null,
  );
}
