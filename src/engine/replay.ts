import { decodeRun, type Chunk } from './video';

/**
 * The replay after a cut: the real last few seconds of video, decoded and
 * downscaled, so you see (and hear) exactly where you'll pick up.
 */
export interface ReplayFrame {
  t: number; // seconds on the output timeline
  bmp: ImageBitmap;
}

export class Replay {
  frames: ReplayFrame[] = [];
  from = 0;
  to = 0;
  private cancelled = false;

  static async build(config: VideoDecoderConfig, chunks: Chunk[], from: number, to: number, width = 480): Promise<Replay> {
    const r = new Replay();
    r.from = from;
    r.to = to;
    const fromUs = from * 1e6;
    const toUs = to * 1e6;
    let start = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].ts > fromUs) break;
      if (chunks[i].key) start = i;
    }
    const run = chunks.slice(start).filter((c) => c.ts < toUs);
    if (!run.length || !run[0].key) return r;
    await decodeRun(config, run, async (f) => {
      if (r.cancelled || f.timestamp < fromUs - 40_000) {
        f.close();
        return;
      }
      const h = Math.round((f.displayHeight / f.displayWidth) * width);
      try {
        const bmp = await createImageBitmap(f, { resizeWidth: width, resizeHeight: h, resizeQuality: 'medium' });
        // disposed while this frame was being made: free it instead of keeping it
        if (r.cancelled) bmp.close();
        else r.frames.push({ t: f.timestamp / 1e6, bmp });
      } catch {
        /* skip */
      }
      f.close();
    });
    return r;
  }

  frameAt(t: number): ImageBitmap | null {
    let best: ReplayFrame | null = null;
    for (const f of this.frames) {
      if (f.t <= t + 0.001) best = f;
      else break;
    }
    return (best ?? this.frames[0])?.bmp ?? null;
  }

  get last() {
    return this.frames[this.frames.length - 1]?.bmp ?? null;
  }

  dispose() {
    this.cancelled = true;
    this.frames.forEach((f) => f.bmp.close());
    this.frames = [];
  }
}
