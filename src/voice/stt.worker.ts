/// <reference lib="webworker" />
/**
 * Local speech engine, off the main thread so recording never stutters.
 *  - Whisper tiny.en for short commands (fast), base.en for the final transcript.
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

type Msg =
  | { id: number; type: 'load'; what: ('command' | 'embed' | 'transcript')[] }
  | { id: number; type: 'command'; audio: Float32Array }
  | { id: number; type: 'transcribe'; audio: Float32Array }
  | { id: number; type: 'embed'; texts: string[] };

const MODELS = {
  command: 'Xenova/whisper-tiny.en',
  transcript: 'Xenova/whisper-base.en',
  embed: 'Xenova/all-MiniLM-L6-v2',
};

const cache: Record<string, Promise<any>> = {};

function load(kind: keyof typeof MODELS) {
  if (!cache[kind]) {
    const task = kind === 'embed' ? 'feature-extraction' : 'automatic-speech-recognition';
    cache[kind] = (pipeline as any)(task, MODELS[kind], {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p: any) => {
        if (p?.status === 'progress' && p.total) postMessage({ type: 'progress', kind, loaded: p.loaded, total: p.total, file: p.file });
      },
    }).then((pipe: any) => {
      postMessage({ type: 'ready', kind });
      return pipe;
    });
    cache[kind].catch(() => delete cache[kind]);
  }
  return cache[kind];
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      for (const w of m.what) await load(w);
      postMessage({ id: m.id, ok: true });
    } else if (m.type === 'command') {
      const asr = await load('command');
      const out = await asr(m.audio);
      postMessage({ id: m.id, ok: true, text: String(out?.text ?? '').trim() });
    } else if (m.type === 'transcribe') {
      const asr = await load('transcript');
      const out = await asr(m.audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
      const chunks = (out?.chunks ?? []).map((c: any) => ({ text: String(c.text).trim(), start: c.timestamp?.[0] ?? 0, end: c.timestamp?.[1] ?? null }));
      postMessage({ id: m.id, ok: true, text: String(out?.text ?? '').trim(), chunks });
    } else if (m.type === 'embed') {
      const fe = await load('embed');
      const out = await fe(m.texts, { pooling: 'mean', normalize: true });
      postMessage({ id: m.id, ok: true, vectors: out.tolist() });
    }
  } catch (err) {
    postMessage({ id: (m as any).id, ok: false, error: String((err as any)?.message ?? err) });
  }
};
