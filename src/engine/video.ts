/**
 * Encoded video on the output timeline: a list of H.264/VP9 chunks.
 *
 * Splice rules that keep the stream decodable without re-encoding:
 *  - Removing everything after time T is always safe: earlier frames only depend
 *    on earlier frames.
 *  - The first frame after recording resumes is a forced keyframe, so new frames
 *    never reference frames that were removed.
 *  - A keyframe is also forced every second, so any short range (an outtake, the
 *    replay before a cut) can be decoded from a nearby keyframe.
 */

export interface Chunk {
  data: Uint8Array;
  ts: number; // µs
  dur: number; // µs
  key: boolean;
}

export class EncodedVideo {
  chunks: Chunk[] = [];
  codec = '';
  decoderConfig: VideoDecoderConfig | null = null;
  private lastKeyTs = -Infinity;

  /** Decide whether the frame at `ts` should be a keyframe. */
  wantsKey(ts: number, force: boolean) {
    const key = force || ts - this.lastKeyTs >= 1_000_000;
    if (key) this.lastKeyTs = ts;
    return key;
  }

  add(c: { data: ArrayBuffer; ts: number; dur: number; key: boolean; config?: VideoDecoderConfig }) {
    if (c.config) this.decoderConfig = c.config;
    this.chunks.push({ data: new Uint8Array(c.data), ts: c.ts, dur: c.dur, key: c.key });
  }

  get lastTs() {
    return this.chunks.length ? this.chunks[this.chunks.length - 1].ts : -1;
  }

  clear() {
    this.chunks = [];
    this.lastKeyTs = -Infinity;
  }

  /** Remove from `tsUs` on. Returns the removed chunks plus the keyframe run needed to decode them. */
  truncate(tsUs: number) {
    let idx = this.chunks.length;
    while (idx > 0 && this.chunks[idx - 1].ts >= tsUs) idx--;
    const removed = this.chunks.splice(idx);
    let k = idx - 1;
    while (k > 0 && !this.chunks[k].key) k--;
    const prefix = removed.length && removed[0].key ? [] : this.chunks.slice(Math.max(0, k), idx);
    this.lastKeyTs = -Infinity;
    return { removed, prefix };
  }

  restore(removed: Chunk[]) {
    this.chunks.push(...removed);
  }
}

/**
 * Backpressure without polling: resolve once a WebCodecs encoder/decoder has at most
 * `max` items queued, woken by its 'dequeue' event. A slow re-check guards against a
 * codec that errors or closes and never fires again.
 */
export function queueBelow(codec: EventTarget & { readonly state: string }, size: () => number, max: number): Promise<void> {
  if (size() <= max || codec.state !== 'configured') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (size() > max && codec.state === 'configured') return;
      codec.removeEventListener('dequeue', check);
      clearInterval(guard);
      resolve();
    };
    const guard = setInterval(check, 250);
    codec.addEventListener('dequeue', check);
  });
}

/** Decode a run of chunks (must start at a keyframe), handing each frame to `onFrame` in order. */
export async function decodeRun(config: VideoDecoderConfig, chunks: Chunk[], onFrame: (f: VideoFrame) => Promise<void> | void) {
  const q: VideoFrame[] = [];
  let err: unknown = null;
  const dec = new VideoDecoder({ output: (f) => q.push(f), error: (e) => (err = e) });
  dec.configure(config);
  for (const c of chunks) {
    if (err) break;
    dec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, duration: c.dur || undefined, data: c.data }));
    while (!err && (q.length || dec.decodeQueueSize > 6)) {
      if (q.length) await onFrame(q.shift()!);
      else await queueBelow(dec, () => dec.decodeQueueSize, 6);
    }
  }
  if (!err) await dec.flush();
  while (q.length) await onFrame(q.shift()!);
  if (dec.state !== 'closed') dec.close();
  if (err) throw err;
}
