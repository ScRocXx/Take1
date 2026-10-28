import type { Rect } from '../lib/store';

export interface Snap {
  t: number; // seconds on the output timeline
  url: string;
  blob: Blob;
  view: Rect; // zoom at that moment, restored after a Cut
}

/** Small JPEG frames every 0.5 s: timeline strip, outtake thumbnails, the resume frame. */
export class Snapshots {
  list: Snap[] = [];
  private gen = 0;

  /** `make` produces the thumbnail (the compositor worker does the drawing). */
  async capture(make: () => Promise<Blob | null>, t: number, view: Rect) {
    const gen = this.gen;
    const blob = await make();
    if (!blob || gen !== this.gen) return; // a cut happened while it was being made
    this.list.push({ t, blob, url: URL.createObjectURL(blob), view });
  }

  at(t: number): Snap | null {
    let best: Snap | null = null;
    for (const s of this.list) if (s.t <= t + 0.02) best = s;
    return best ?? this.list[0] ?? null;
  }

  truncate(t: number) {
    this.gen++;
    const removed = this.list.filter((s) => s.t >= t);
    this.list = this.list.filter((s) => s.t < t);
    return removed;
  }

  restore(removed: Snap[]) {
    this.list.push(...removed);
    this.list.sort((a, b) => a.t - b.t);
  }

  /** Release every thumbnail (a new recording starts). */
  dispose() {
    this.gen++;
    releaseSnaps(this.list);
    this.list = [];
  }
}

/** Free the object URLs of thumbnails nothing will show again. */
export function releaseSnaps(list: Snap[]) {
  for (const s of list) URL.revokeObjectURL(s.url);
}
