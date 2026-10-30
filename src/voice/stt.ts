import { phone } from '../lib/device';
import { store } from '../lib/store';
import { PROTOTYPES, type Intent } from './intent';

/**
 * Client for the local speech worker. Speech never leaves this computer: if the
 * models can't load (offline on first run), voice commands are unavailable and
 * buttons and shortcuts still work.
 */

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

/** Plain words for what went wrong loading the speech models. */
function friendly(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed') || m.includes('could not locate file'))
    return 'Couldn’t download the speech model (no connection to huggingface.co). Check your internet connection; it’s only needed the first time.';
  if (m.includes('quota') || m.includes('storage')) return 'Not enough disk space to keep the speech model. Free some space and try again.';
  if (m.includes('webassembly') || m.includes('wasm') || m.includes('out of memory')) return `The speech model couldn’t run in this browser (${msg}). Try Chrome or Edge, or close some tabs.`;
  return /[.!?)]$/.test(msg) ? msg : `${msg}.`;
}

class Stt {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private protos: { intent: Intent; v: number[] }[] | null = null;
  private progress: Record<string, { loaded: number; total: number }> = {};
  private onT = new Map<number, (p: number) => void>();
  ready = { command: false, embed: false, transcript: false };
  failed = false;

  private ensure() {
    if (this.worker || this.failed) return this.worker;
    try {
      this.worker = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        e.preventDefault?.();
        this.fail(`The voice engine stopped${e.message ? `: ${e.message}` : ''}`);
      };
    } catch (e) {
      this.fail(`The voice engine couldn’t start: ${(e as Error)?.message ?? e}`);
    }
    return this.worker;
  }

  /** Something went wrong: say what, and let the next attempt start from scratch. */
  private fail(msg: string) {
    this.failed = true;
    this.failedAt = performance.now();
    this.worker?.terminate();
    this.worker = null;
    this.ready = { command: false, embed: false, transcript: false };
    this.protos = null;
    this.warmingAccurate = false;
    store.set({ engine: { status: 'error', progress: 0, detail: friendly(msg) } });
    this.pending.forEach((p) => p.reject(new Error(friendly(msg))));
    this.pending.clear();
  }
  private failedAt = 0;

  /** Try loading again (after a failure, e.g. the connection came back). */
  retry() {
    if (!this.failed) return this.warm();
    this.failed = false;
    this.progress = {};
    this.warm();
  }

  private onMessage(d: any) {
    if (d.type === 'progress') {
      // models share file names, so progress is tracked per model
      this.progress[`${d.kind}/${d.file}`] = { loaded: d.loaded, total: d.total };
      const frac = (kinds: string[]) => {
        const all = Object.entries(this.progress).filter(([k]) => kinds.some((x) => k.startsWith(x + '/'))).map(([, v]) => v);
        return all.reduce((a, x) => a + x.loaded, 0) / Math.max(1, all.reduce((a, x) => a + x.total, 0));
      };
      if (d.kind === 'transcript') {
        if (store.get().transcribing) store.set({ captions: { status: 'downloading', progress: frac(['transcript']), detail: null } });
      }
      else if (!this.ready.command) store.set({ engine: { status: 'loading', progress: frac(['command', 'embed']), detail: null } });
      return;
    }
    if (d.type === 'tprogress') {
      this.onT.get(d.id)?.(d.p);
      return;
    }
    if (d.type === 'ready') {
      (this.ready as any)[d.kind] = true;
      if (d.kind === 'command') {
        store.set({ engine: { status: 'ready', progress: 1, detail: null } });
        // phones only try commands, so they skip the second, bigger download
        if (!phone) setTimeout(() => this.warmAccurate(), 8000);
      }
      if (d.kind === 'transcript' && store.get().transcribing) store.set({ captions: { status: 'transcribing', progress: 0, detail: null } });
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
    if (this.ready.command) return;
    // after a failure, try again (but not in a tight loop)
    if (this.failed) {
      if (performance.now() - this.failedAt < 4000) return;
      this.failed = false;
      this.progress = {};
    }
    if (store.get().engine.status === 'loading' && this.worker) return;
    store.set({ engine: { status: 'loading', progress: 0, detail: null } });
    this.call({ type: 'load', what: ['command', 'embed'] }).catch((e) => this.fail(String(e.message ?? e)));
  }

  /**
   * Fetch the bigger model in the background once the command model is up. It makes
   * captions start faster, and gives unclear commands a second, more accurate listen.
   */
  warmAccurate() {
    if (this.ready.transcript || this.failed || this.warmingAccurate) return;
    this.warmingAccurate = true;
    this.call({ type: 'load', what: ['transcript'] }).catch(() => (this.warmingAccurate = false));
  }
  private warmingAccurate = false;

  async command(pcm16k: Float32Array, accurate = false): Promise<string> {
    const r = await this.call({ type: 'command', audio: pcm16k, accurate }, [pcm16k.buffer]);
    return r.text as string;
  }

  async transcribe(pcm16k: Float32Array, onProgress?: (p: number) => void): Promise<{ text: string; start: number; end: number | null; words?: { text: string; start: number; end: number }[] }[]> {
    const id = this.seq + 1;
    if (onProgress) this.onT.set(id, onProgress);
    try {
      const r = await this.call({ type: 'transcribe', audio: pcm16k }, [pcm16k.buffer]);
      return r.chunks;
    } finally {
      this.onT.delete(id);
    }
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

/**
 * Get a spoken command ready for Whisper: trim the silence around it (keeping a
 * little margin), bring quiet speech up to a healthy level, and pad the edges.
 * Short words like "cut" are recognised far more reliably this way.
 */
export function prepCommand(pcm16: Float32Array, thr: number): Float32Array {
  const SR = 16000;
  const win = 320; // 20 ms
  let first = -1;
  let last = -1;
  for (let k = 0; k + win <= pcm16.length; k += win) {
    let e = 0;
    for (let i = k; i < k + win; i++) e += pcm16[i] * pcm16[i];
    if (Math.sqrt(e / win) >= thr) {
      if (first < 0) first = k;
      last = k + win;
    }
  }
  const a = first < 0 ? 0 : Math.max(0, first - Math.round(SR * 0.2));
  const b = first < 0 ? pcm16.length : Math.min(pcm16.length, last + Math.round(SR * 0.25));
  const core = pcm16.subarray(a, b);
  let peak = 0;
  for (let i = 0; i < core.length; i++) peak = Math.max(peak, Math.abs(core[i]));
  const g = peak > 1e-4 ? Math.min(10, 0.9 / peak) : 1;
  const pad = Math.round(SR * 0.25);
  const out = new Float32Array(core.length + pad * 2);
  for (let i = 0; i < core.length; i++) out[pad + i] = core[i] * g;
  return out;
}

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
