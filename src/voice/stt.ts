import { store } from '../lib/store';
import { PROTOTYPES, type Intent } from './intent';

/**
 * Client for the local speech worker. Everything degrades gracefully: if the
 * models can't load (offline on first run), Take1 falls back to the browser's
 * speech engine for commands, and buttons/hotkeys always work.
 */

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

class Stt {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private protos: { intent: Intent; v: number[] }[] | null = null;
  private progress: Record<string, { loaded: number; total: number }> = {};
  ready = { command: false, embed: false, transcript: false };
  failed = false;

  private ensure() {
    if (this.worker || this.failed) return this.worker;
    try {
      this.worker = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = () => this.fail('Voice engine failed to start');
    } catch {
      this.fail('Voice engine unavailable');
    }
    return this.worker;
  }

  private fail(msg: string) {
    this.failed = true;
    store.set({ engine: { status: 'error', progress: 0, detail: msg } });
    this.pending.forEach((p) => p.reject(new Error(msg)));
    this.pending.clear();
  }

  private onMessage(d: any) {
    if (d.type === 'progress') {
      // models share file names, so progress is tracked per model
      this.progress[`${d.kind}/${d.file}`] = { loaded: d.loaded, total: d.total };
      const frac = (kinds: string[]) => {
        const all = Object.entries(this.progress).filter(([k]) => kinds.some((x) => k.startsWith(x + '/'))).map(([, v]) => v);
        return all.reduce((a, x) => a + x.loaded, 0) / Math.max(1, all.reduce((a, x) => a + x.total, 0));
      };
      if (d.kind === 'transcript') store.set({ captions: { status: 'downloading', progress: frac(['transcript']), detail: null } });
      else if (!this.ready.command) store.set({ engine: { status: 'loading', progress: frac(['command', 'embed']), detail: null } });
      return;
    }
    if (d.type === 'ready') {
      (this.ready as any)[d.kind] = true;
      if (d.kind === 'command') store.set({ engine: { status: 'ready', progress: 1, detail: null } });
      if (d.kind === 'transcript') store.set({ captions: { status: 'transcribing', progress: 0, detail: null } });
      if (d.kind === 'embed') this.buildPrototypes();
      return;
    }
    const p = this.pending.get(d.id);
    if (!p) return;
    this.pending.delete(d.id);
    d.ok ? p.resolve(d) : p.reject(new Error(d.error));
  }

  private call(msg: any, transfer: Transferable[] = []): Promise<any> {
    const w = this.ensure();
    if (!w) return Promise.reject(new Error('Voice engine unavailable'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Warm up the command model and the embedder (call once the mic is on). */
  warm() {
    if (this.ready.command || this.failed) return;
    store.set({ engine: { status: 'loading', progress: 0, detail: null } });
    this.call({ type: 'load', what: ['command', 'embed'] }).catch((e) => this.fail(String(e.message ?? e)));
  }

  async command(pcm16k: Float32Array): Promise<string> {
    const r = await this.call({ type: 'command', audio: pcm16k }, [pcm16k.buffer]);
    return r.text as string;
  }

  async transcribe(pcm16k: Float32Array): Promise<{ text: string; start: number; end: number | null }[]> {
    const r = await this.call({ type: 'transcribe', audio: pcm16k }, [pcm16k.buffer]);
    return r.chunks;
  }

  private async buildPrototypes() {
    const items: { intent: Intent; text: string }[] = [];
    (Object.keys(PROTOTYPES) as Intent[]).forEach((k) => PROTOTYPES[k].forEach((text) => items.push({ intent: k, text })));
    try {
      const r = await this.call({ type: 'embed', texts: items.map((i) => i.text) });
      this.protos = items.map((it, i) => ({ intent: it.intent, v: r.vectors[i] }));
    } catch {
      this.protos = null;
    }
  }

  /** Cosine similarity of an utterance to each intent's closest example (0..1). */
  async intentScores(text: string): Promise<Partial<Record<Intent, number>> | undefined> {
    if (!this.protos || !text.trim()) return undefined;
    try {
      const r = await this.call({ type: 'embed', texts: [text] });
      const v: number[] = r.vectors[0];
      const out: Partial<Record<Intent, number>> = {};
      for (const p of this.protos) {
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += v[i] * p.v[i];
        out[p.intent] = Math.max(out[p.intent] ?? 0, dot);
      }
      return out;
    } catch {
      return undefined;
    }
  }
}

export const stt = new Stt();

/** 48 kHz → 16 kHz with a small low-pass (3-tap average) before decimation. */
export function to16k(pcm: Float32Array, sr: number): Float32Array {
  if (sr === 16000) return pcm.slice();
  const ratio = sr / 16000;
  const n = Math.floor(pcm.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i * ratio);
    out[i] = ((pcm[c - 1] ?? pcm[c]) + pcm[c] + (pcm[c + 1] ?? pcm[c])) / 3;
  }
  return out;
}
