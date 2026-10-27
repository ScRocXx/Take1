/// <reference lib="webworker" />
/**
 * Local speech engine, off the main thread so recording never stutters.
 *  - Whisper tiny.en for short commands (fast); base.en for transcripts, and as a
 *    second opinion when tiny wasn't sure what you said.
 *  - MiniLM sentence embeddings for semantic intent matching.
 * Models download once from the Hugging Face hub and are cached by the browser.
 */
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
try {
  (env.backends.onnx as any).wasm.numThreads = 1;
} catch {
  /* older builds */
}

type Kind = 'command' | 'embed' | 'transcript';
type Msg =
  | { id: number; type: 'load'; what: Kind[] }
  | { id: number; type: 'command'; audio: Float32Array; accurate?: boolean }
  | { id: number; type: 'transcribe'; audio: Float32Array }
  | { id: number; type: 'embed'; texts: string[] };

const MODELS: Record<Kind, string> = {
  command: 'Xenova/whisper-tiny.en',
  transcript: 'Xenova/whisper-base.en',
  embed: 'Xenova/all-MiniLM-L6-v2',
};

const cache: Partial<Record<Kind, Promise<any>>> = {};

function load(kind: Kind) {
  if (!cache[kind]) {
    const task = kind === 'embed' ? 'feature-extraction' : 'automatic-speech-recognition';
    const p = (pipeline as any)(task, MODELS[kind], {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (e: any) => {
        if (e?.status === 'progress' && e.total) postMessage({ type: 'progress', kind, loaded: e.loaded, total: e.total, file: e.file });
      },
    }).then((pipe: any) => {
      postMessage({ type: 'ready', kind });
      return pipe;
    });
    p.catch(() => delete cache[kind]);
    cache[kind] = p;
  }
  return cache[kind]!;
}

const SR = 16000;
const clean = (s: string) =>
  s
    .replace(/\[[^\]]*\]|\([^)]*\)|♪/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Raise quiet speech to a healthy level (peak ≈ 0.9, at most 12×). Whisper hears quiet mics badly. */
function level(a: Float32Array) {
  let peak = 0;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
  if (peak < 1e-4) return a;
  const g = Math.min(12, 0.9 / peak);
  if (g <= 1.05) return a;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * g;
  return out;
}

/**
 * Split long audio into phrases at pauses, so each one can be recognised on its own
 * with honest start/end times (no reliance on long-form timestamp decoding).
 */
/** Loudness every 20 ms, and the level that counts as speech. */
function envelope(a: Float32Array) {
  const hop = SR / 50; // 20 ms
  const n = Math.floor(a.length / hop);
  const env = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) e += a[i] * a[i];
    env[k] = Math.sqrt(e / hop);
  }
  const sorted = Array.from(env).sort((x, y) => x - y);
  const floor = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
  const peak = sorted[Math.floor(sorted.length * 0.98)] ?? 0;
  return { env, thr: Math.max(floor * 3, peak * 0.07, 0.0003) };
}

function segments({ env, thr }: { env: Float32Array; thr: number }, length: number) {
  const n = env.length;
  const out: { a: number; b: number }[] = [];
  let start = -1;
  let quiet = 0;
  for (let k = 0; k < n; k++) {
    if (env[k] >= thr) {
      if (start < 0) start = k;
      quiet = 0;
    } else if (start >= 0 && ++quiet >= 30) {
      // 0.6 s of quiet closes a phrase
      out.push({ a: start, b: k - quiet + 1 });
      start = -1;
      quiet = 0;
    }
  }
  if (start >= 0) out.push({ a: start, b: n });
  // merge phrases separated by short gaps into ≤ 20 s segments, drop clicks
  const merged: { a: number; b: number }[] = [];
  for (const s of out) {
    if (s.b - s.a < 8) continue; // < 160 ms
    const last = merged[merged.length - 1];
    if (last && s.a - last.b < 40 && s.b - last.a < 1000) last.b = s.b;
    else merged.push({ ...s });
  }
  return merged.map((s) => ({ start: Math.max(0, s.a * 0.02 - 0.25), end: Math.min(length / SR, s.b * 0.02 + 0.3) }));
}

type Word = { text: string; start: number; end: number };
const syllables = (w: string) => Math.max(1, (w.toLowerCase().replace(/[^a-z]/g, '').replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length);

/**
 * Word times from the loudness of the phrase: words are spread over the frames where
 * someone is actually speaking, in proportion to their syllables, so pauses inside a
 * phrase don't drag the words out of sync.
 */
function alignByEnergy(text: string, start: number, end: number, { env, thr }: { env: Float32Array; thr: number }): Word[] {
  const toks = text.split(' ').filter(Boolean);
  if (!toks.length) return [];
  const a = Math.max(0, Math.floor(start / 0.02));
  const b = Math.min(env.length, Math.ceil(end / 0.02));
  let frames: number[] = [];
  for (let k = a; k < b; k++) if (env[k] >= thr * 0.8) frames.push(k);
  if (frames.length < toks.length * 3) frames = Array.from({ length: Math.max(1, b - a) }, (_, i) => a + i);
  const weight = toks.map((t) => syllables(t));
  const total = weight.reduce((x, y) => x + y, 0);
  const at = (f: number) => frames[Math.min(frames.length - 1, Math.max(0, Math.round(f * (frames.length - 1))))] * 0.02;
  let acc = 0;
  return toks.map((t, i) => {
    const s0 = acc / total;
    acc += weight[i];
    const s1 = acc / total;
    const ws = at(s0);
    return { text: t, start: ws, end: Math.max(ws + 0.08, at(s1) + 0.02) };
  });
}

let wordTimestamps = true;

/** Text and, when this model build can align them, Whisper's own word times (one pass). */
async function recognise(asr: any, part: Float32Array, offset: number): Promise<{ text: string; words: Word[] | null }> {
  if (wordTimestamps) {
    try {
      const out = await asr(part, { return_timestamps: 'word' });
      const text = clean(String(out?.text ?? ''));
      return { text, words: parseWords(out?.chunks ?? [], offset, text) };
    } catch {
      wordTimestamps = false; // no alignment heads in this build: use loudness from now on
    }
  }
  const out = await asr(part);
  return { text: clean(String(out?.text ?? '')), words: null };
}

function parseWords(chunks: any[], offset: number, text: string): Word[] | null {
  const words: Word[] = [];
  for (const c of chunks) {
    for (const t of clean(String(c.text ?? '')).split(' ').filter(Boolean)) {
      const s = Number(c.timestamp?.[0]);
      const e = Number(c.timestamp?.[1] ?? s);
      if (!Number.isFinite(s)) return null;
      words.push({ text: t, start: offset + s, end: offset + (Number.isFinite(e) ? e : s + 0.2) });
    }
  }
  const toks = text.split(' ').filter(Boolean);
  if (!toks.length || words.length !== toks.length) return null;
  for (let i = 1; i < words.length; i++) if (words[i].start < words[i - 1].start - 0.05) return null;
  if (words.filter((w) => w.end - w.start < 0.02).length > words.length / 2) return null;
  return words.map((w, i) => ({ ...w, text: toks[i] }));
}


self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      for (const w of m.what) await load(w);
      postMessage({ id: m.id, ok: true });
    } else if (m.type === 'command') {
      const asr = await load(m.accurate ? 'transcript' : 'command');
      const out = await asr(m.audio);
      postMessage({ id: m.id, ok: true, text: clean(String(out?.text ?? '')) });
    } else if (m.type === 'transcribe') {
      const asr = await load('transcript');
      const env = envelope(m.audio);
      const segs = segments(env, m.audio.length);
      const lines: { text: string; start: number; end: number; words?: Word[] }[] = [];
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const part = level(m.audio.subarray(Math.round(s.start * SR), Math.round(s.end * SR)));
        const r = await recognise(asr, part, s.start);
        const text = r.text;
        if (text && !/^(you|thank you\.?|thanks for watching\.?|\.+)$/i.test(text)) {
          lines.push({ text, start: s.start, end: s.end, words: r.words ?? alignByEnergy(text, s.start, s.end, env) });
        }
        postMessage({ type: 'tprogress', id: m.id, p: (i + 1) / segs.length });
      }
      // nothing segmented (very quiet or very noisy audio): fall back to Whisper's own long-form mode
      if (!lines.length && m.audio.length > SR) {
        const out = await asr(level(m.audio), { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
        for (const c of out?.chunks ?? []) {
          const text = clean(String(c.text ?? ''));
          const start = c.timestamp?.[0] ?? 0;
          const end = c.timestamp?.[1] ?? start + 3;
          if (text) lines.push({ text, start, end, words: alignByEnergy(text, start, end, env) });
        }
        const all = clean(String(out?.text ?? ''));
        if (!lines.length && all) lines.push({ text: all, start: 0, end: m.audio.length / SR });
      }
      postMessage({ id: m.id, ok: true, chunks: lines });
    } else if (m.type === 'embed') {
      const fe = await load('embed');
      const out = await fe(m.texts, { pooling: 'mean', normalize: true });
      postMessage({ id: m.id, ok: true, vectors: out.tolist() });
    }
  } catch (err) {
    postMessage({ id: (m as any).id, ok: false, error: String((err as any)?.message ?? err) });
  }
};
