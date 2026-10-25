/**
 * The video "tape": encoded chunks on an output timeline.
 *
 * Splice rules that keep the stream decodable without re-encoding:
 *  - A Cut truncates at T. Ending a run at any frame is safe: earlier P-frames
 *    only depend on earlier frames.
 *  - The first frame after a punch-in is always a forced keyframe, so the new
 *    take never references frames that were thrown away.
 *  - A keyframe is also forced every 1 s, so outtakes and redactions can be
 *    re-decoded from a nearby keyframe.
 */

export interface Chunk {
  data: Uint8Array;
  ts: number; // µs
  dur: number; // µs
  key: boolean;
}

const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f', 'vp09.00.40.08', 'vp09.00.10.08'];

export class VideoTape {
  chunks: Chunk[] = [];
  codec = '';
  decoderConfig: VideoDecoderConfig | null = null;
  width = 0;
  height = 0;
  private enc: VideoEncoder | null = null;
  private lastKeyTs = -Infinity;
  error: string | null = null;

  constructor(readonly fps = 30, readonly bitrate = 5_000_000) {}

  async configure(width: number, height: number) {
    this.enc?.state !== 'closed' && this.enc?.close();
    this.width = width;
    this.height = height;
    for (const codec of CODECS) {
      const cfg: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate: this.bitrate,
        framerate: this.fps,
        latencyMode: 'realtime',
        ...(codec.startsWith('avc') ? { avc: { format: 'avc' } } : {}),
      } as VideoEncoderConfig;
      try {
        const s = await VideoEncoder.isConfigSupported(cfg);
        if (!s.supported) continue;
        this.enc = new VideoEncoder({
          output: (chunk, meta) => this.onChunk(chunk, meta),
          error: (e) => (this.error = String(e)),
        });
        this.enc.configure(cfg);
        this.codec = codec;
        return codec;
      } catch {
        /* try next */
      }
    }
    throw new Error('This browser cannot encode H.264 or VP9 video. Use Chrome or Edge on desktop.');
  }

  private onChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) {
    if (meta?.decoderConfig) this.decoderConfig = { ...meta.decoderConfig };
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.chunks.push({ data, ts: chunk.timestamp, dur: chunk.duration ?? 0, key: chunk.type === 'key' });
  }

  get busy() {
    return (this.enc?.encodeQueueSize ?? 0) > 4;
  }

  encode(frame: VideoFrame, forceKey = false) {
    if (!this.enc || this.enc.state !== 'configured') return;
    const key = forceKey || frame.timestamp - this.lastKeyTs >= 1_000_000;
    if (key) this.lastKeyTs = frame.timestamp;
    this.enc.encode(frame, { keyFrame: key });
  }

  async flush() {
    if (this.enc?.state === 'configured') await this.enc.flush();
  }

  get lastTs() {
    return this.chunks.length ? this.chunks[this.chunks.length - 1].ts : -1;
  }

  /** Cut at `tsUs`. Returns the removed chunks plus the GOP prefix needed to decode them. */
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

  close() {
    if (this.enc && this.enc.state !== 'closed') this.enc.close();
    this.enc = null;
  }
}

/** Decode a run of chunks (must start at a keyframe), handing each frame to `onFrame` in order. */
export async function decodeRun(
  config: VideoDecoderConfig,
  chunks: Chunk[],
  onFrame: (f: VideoFrame) => Promise<void> | void,
) {
  const q: VideoFrame[] = [];
  let err: unknown = null;
  const dec = new VideoDecoder({ output: (f) => q.push(f), error: (e) => (err = e) });
  dec.configure(config);
  const wait = () => new Promise((r) => setTimeout(r, 1));
  for (const c of chunks) {
    if (err) break;
    dec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, duration: c.dur || undefined, data: c.data }));
    while (!err && (q.length || dec.decodeQueueSize > 6)) {
      if (q.length) await onFrame(q.shift()!);
      else await wait();
    }
  }
  if (!err) await dec.flush();
  while (q.length) await onFrame(q.shift()!);
  if (dec.state !== 'closed') dec.close();
  if (err) throw err;
}
