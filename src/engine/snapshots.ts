import type { Rect } from '../lib/store';

export interface Snap {
  t: number; // tape seconds
  url: string;
  blob: Blob;
  view: Rect; // compositor view at that moment, restored after a Cut
}

/** Small JPEG frames every 0.5 s of tape: filmstrip, Match Frame, outtake thumbnails. */
export class Snapshots {
  list: Snap[] = [];
  private gen = 0;
  private small: HTMLCanvasElement;

  constructor() {
    this.small = document.createElement('canvas');
  }

  async capture(src: HTMLCanvasElement, t: number, view: Rect) {
    const gen = this.gen;
    const w = 480;
    const h = Math.round((src.height / src.width) * w);
    this.small.width = w;
    this.small.height = h;
    this.small.getContext('2d')!.drawImage(src, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => this.small.toBlob(r, 'image/jpeg', 0.72));
    if (!blob || gen !== this.gen) return; // a Cut happened while we were encoding
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
}
