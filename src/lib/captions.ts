/**
 * Styled captions, drawn the same way in the Export preview and in the exported video
 * (export.worker.ts imports this file, so what you see is what gets drawn in).
 *
 *  - Word timing: each transcript line carries per-word times (Whisper word timestamps, or
 *    the speech energy of that phrase when those aren't available). wordsOf() falls back to
 *    spreading words by syllable count if a line has none.
 *  - Track: words grouped into what's on screen at once (1, 2, 3 words or a full line).
 *  - Style: font, size, position, colours, how the spoken word stands out, entry animation.
 */

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface TimedLine {
  start: number;
  end: number;
  text: string;
  words?: Word[];
}

export interface Group {
  start: number;
  end: number;
  words: Word[];
}

export type FontId = 'figtree' | 'montserrat' | 'anton' | 'bebas' | 'poppins' | 'marker' | 'serif' | 'mono';
export type Anim = 'none' | 'pop' | 'rise' | 'fade' | 'bounce' | 'type';
export type Highlight = 'none' | 'color' | 'box' | 'fill' | 'scale' | 'marker';
export type Backing = 'none' | 'rows' | 'block';

export interface CaptionStyle {
  preset: string;
  font: FontId;
  /** text height as a fraction of the picture's shorter side */
  size: number;
  upper: boolean;
  /** words on screen at once; 0 = a full line */
  words: 0 | 1 | 2 | 3 | 4;
  /** centre of the caption, 0–1 across and down the picture */
  x: number;
  y: number;
  color: string;
  accent: string;
  highlight: Highlight;
  outline: boolean;
  shadow: boolean;
  glow: boolean;
  backing: Backing;
  back: string;
  /** "difference" blending: the text inverts whatever is behind it */
  blend: boolean;
  anim: Anim;
}

export const FONTS: Record<FontId, { label: string; family: string; weight: number }> = {
  figtree: { label: 'Figtree', family: '"Take1 Figtree", "Segoe UI", system-ui, sans-serif', weight: 700 },
  poppins: { label: 'Poppins', family: '"Take1 Poppins", "Segoe UI", system-ui, sans-serif', weight: 800 },
  montserrat: { label: 'Montserrat Black', family: '"Take1 Montserrat", "Arial Black", "Segoe UI Black", sans-serif', weight: 900 },
  anton: { label: 'Anton', family: '"Take1 Anton", Impact, "Arial Narrow", sans-serif', weight: 400 },
  bebas: { label: 'Bebas Neue', family: '"Take1 Bebas", Impact, "Arial Narrow", sans-serif', weight: 400 },
  marker: { label: 'Marker', family: '"Take1 Marker", "Segoe Print", "Comic Sans MS", cursive', weight: 400 },
  serif: { label: 'Serif', family: 'Georgia, "Times New Roman", serif', weight: 700 },
  mono: { label: 'Mono', family: 'Consolas, "Cascadia Mono", ui-monospace, monospace', weight: 700 },
};

const base: Omit<CaptionStyle, 'preset'> = {
  font: 'figtree',
  size: 0.055,
  upper: false,
  words: 0,
  x: 0.5,
  y: 0.86,
  color: '#ffffff',
  accent: '#ffd23f',
  highlight: 'none',
  outline: false,
  shadow: false,
  glow: false,
  backing: 'rows',
  back: 'rgba(17,17,17,0.78)',
  blend: false,
  anim: 'none',
};

export const PRESETS: { id: string; label: string; style: CaptionStyle }[] = [
  { id: 'classic', label: 'Classic', style: { ...base, preset: 'classic' } },
  {
    id: 'pop',
    label: 'Bold pop',
    style: { ...base, preset: 'pop', font: 'montserrat', size: 0.075, upper: true, words: 3, y: 0.74, highlight: 'color', outline: true, shadow: true, backing: 'none', anim: 'pop' },
  },
  {
    id: 'word',
    label: 'One word',
    style: { ...base, preset: 'word', font: 'poppins', size: 0.07, words: 1, y: 0.5, shadow: true, backing: 'none', anim: 'pop' },
  },
  {
    id: 'box',
    label: 'Highlight',
    style: { ...base, preset: 'box', font: 'poppins', size: 0.065, upper: true, words: 3, y: 0.76, accent: '#7b3fe4', highlight: 'box', shadow: true, backing: 'none', anim: 'rise' },
  },
  {
    id: 'karaoke',
    label: 'Karaoke',
    style: { ...base, preset: 'karaoke', font: 'montserrat', size: 0.055, y: 0.84, accent: '#3ee08f', highlight: 'fill', outline: true, backing: 'none', anim: 'fade' },
  },
  {
    id: 'blend',
    label: 'Blend',
    style: { ...base, preset: 'blend', font: 'anton', size: 0.16, upper: false, words: 2, y: 0.5, highlight: 'none', backing: 'none', blend: true, anim: 'pop' },
  },
  {
    id: 'neon',
    label: 'Neon',
    style: { ...base, preset: 'neon', font: 'bebas', size: 0.1, upper: true, words: 3, y: 0.72, color: '#e9fbff', accent: '#ff3fa4', highlight: 'color', glow: true, backing: 'none', anim: 'fade' },
  },
  {
    id: 'marker',
    label: 'Marker',
    style: { ...base, preset: 'marker', font: 'marker', size: 0.07, words: 3, y: 0.76, color: '#111111', accent: '#ffe14d', highlight: 'marker', backing: 'none', anim: 'bounce' },
  },
];

export const DEFAULT_STYLE = PRESETS[1].style;

// ───────────────────────── word timing ─────────────────────────

const syllables = (w: string) => Math.max(1, (w.toLowerCase().replace(/[^a-z]/g, '').replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length);

/** Per-word times for a line: its own if they match the text, otherwise spread by syllables. */
export function wordsOf(l: TimedLine): Word[] {
  const toks = l.text.split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  if (l.words && l.words.length === toks.length) return l.words.map((w, i) => ({ text: toks[i], start: w.start, end: Math.max(w.end, w.start + 0.05) }));
  // a little extra after punctuation, where people pause
  const weight = toks.map((t) => syllables(t) + (/[,;:]$/.test(t) ? 0.7 : /[.!?]$/.test(t) ? 1 : 0));
  const total = weight.reduce((a, b) => a + b, 0);
  const span = Math.max(0.2, l.end - l.start);
  let t = l.start;
  return toks.map((text, i) => {
    const d = (span * weight[i]) / total;
    const w = { text, start: t, end: t + d };
    t += d;
    return w;
  });
}

const chars = (ws: Word[]) => ws.reduce((a, w) => a + w.text.length + 1, 0);

/** What's on screen when: words grouped per the style, each group held until the next one. */
export function buildTrack(lines: TimedLine[], style: Pick<CaptionStyle, 'words'>): Group[] {
  const max = style.words || 99;
  const out: Group[] = [];
  for (const l of lines) {
    let cur: Word[] = [];
    const flush = () => {
      if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
      cur = [];
    };
    for (const w of wordsOf(l)) {
      const prev = cur[cur.length - 1];
      if (
        prev &&
        (cur.length >= max ||
          w.start - prev.end > 0.45 || // a pause starts a new caption
          (max > 1 && /[.!?]$/.test(prev.text)) ||
          (style.words === 0 && chars(cur) + w.text.length > 64))
      )
        flush();
      cur.push(w);
    }
    flush();
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    const hold = out[i].end + (style.words === 0 ? 0.6 : 0.35);
    out[i].end = Math.max(out[i].start + 0.12, next ? Math.min(hold, next.start) : hold);
  }
  return out;
}

/** The group on screen at time t (track is sorted by start). */
export function groupAt(track: Group[], t: number): Group | null {
  let lo = 0;
  let hi = track.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].start <= t) lo = mid + 1;
    else hi = mid - 1;
  }
  const g = track[hi];
  return g && t < g.end ? g : null;
}

// ───────────────────────── drawing ─────────────────────────

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (v: number) => 1 - Math.pow(1 - v, 3);
const backOut = (v: number) => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(v - 1, 3) + c * Math.pow(v - 1, 2);
};

/** Draws whatever caption is on screen at time t. */
export function drawCaptions(ctx: Ctx, W: number, H: number, t: number, track: Group[], style: CaptionStyle) {
  const g = groupAt(track, t);
  if (g) drawGroup(ctx, W, H, t, g, style);
}

export function drawGroup(ctx: Ctx, W: number, H: number, t: number, g: Group, s: CaptionStyle) {
  const unit = Math.min(W, H);
  const size = Math.max(10, Math.round(s.size * unit));
  const f = FONTS[s.font] ?? FONTS.figtree;
  ctx.save();
  ctx.font = `${f.weight} ${size}px ${f.family}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // layout: wrap words into rows that fit the picture
  const words = g.words.map((w) => ({ ...w, text: s.upper ? w.text.toUpperCase() : w.text }));
  // a touch wider than a plain space: outlines and the spoken word's pop need room
  const space = Math.max(ctx.measureText(' ').width, size * 0.3);
  const maxW = W * 0.86;
  const widths = words.map((w) => ctx.measureText(w.text).width);
  const rows: number[][] = [[]];
  let rowW = 0;
  words.forEach((_, i) => {
    const row = rows[rows.length - 1];
    const add = (row.length ? space : 0) + widths[i];
    if (row.length && rowW + add > maxW) {
      rows.push([i]);
      rowW = widths[i];
    } else {
      row.push(i);
      rowW += add;
    }
  });
  const lh = size * (s.font === 'anton' || s.font === 'bebas' ? 1.02 : 1.2);
  const padX = size * 0.45;
  const padY = size * 0.22;
  const blockH = rows.length * lh;
  const rowWidths = rows.map((r) => r.reduce((a, i, k) => a + widths[i] + (k ? space : 0), 0));
  const blockW = Math.max(...rowWidths);
  const margin = unit * 0.04;
  const cx = Math.min(W - margin - blockW / 2, Math.max(margin + blockW / 2, s.x * W));
  const top = Math.min(H - margin - blockH, Math.max(margin, s.y * H - blockH / 2));

  // entry animation for the whole caption
  const e = clamp01((t - g.start) / (s.anim === 'fade' ? 0.25 : 0.2));
  let alpha = 1;
  let scale = 1;
  let dy = 0;
  if (s.anim === 'pop') scale = 0.72 + 0.28 * backOut(e);
  else if (s.anim === 'rise') {
    dy = (1 - easeOut(e)) * size * 0.6;
    alpha = easeOut(e);
  } else if (s.anim === 'fade') alpha = e;
  const out = clamp01((g.end - t) / 0.12);
  if (s.anim !== 'none') alpha *= s.anim === 'pop' ? 1 : out;

  ctx.globalAlpha = alpha;
  const midY = top + blockH / 2;
  ctx.translate(cx, midY + dy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -midY);

  // the spoken word: the last one that has started
  let active = -1;
  words.forEach((w, i) => {
    if (w.start <= t) active = i;
  });

  if (s.backing === 'block') {
    ctx.fillStyle = s.back;
    ctx.beginPath();
    ctx.roundRect(cx - blockW / 2 - padX, top - padY, blockW + padX * 2, blockH + padY * 2, size * 0.35);
    ctx.fill();
  }

  if (s.blend) ctx.globalCompositeOperation = 'difference';

  rows.forEach((row, r) => {
    const y = top + lh * (r + 0.5);
    let x = cx - rowWidths[r] / 2;
    if (s.backing === 'rows') {
      ctx.fillStyle = s.back;
      ctx.beginPath();
      ctx.roundRect(x - padX, y - lh / 2 - padY * 0.5, rowWidths[r] + padX * 2, lh + padY, size * 0.3);
      ctx.fill();
    }
    for (const i of row) {
      const w = words[i];
      const wx = x + widths[i] / 2;
      drawWord(ctx, s, w, i, active, t, wx, y, widths[i], size);
      x += widths[i] + space;
    }
  });
  ctx.restore();
}

function drawWord(ctx: Ctx, s: CaptionStyle, w: Word, i: number, active: number, t: number, wx: number, y: number, ww: number, size: number) {
  const spoken = i <= active;
  const isActive = i === active;
  if (s.anim === 'type' && !spoken) return;
  ctx.save();
  let sc = 1;
  let dy = 0;
  const since = t - w.start;
  if (s.anim === 'bounce' && spoken && since < 0.3) dy = -Math.sin(clamp01(since / 0.3) * Math.PI) * size * 0.28;
  if (s.anim === 'type' && since < 0.12) ctx.globalAlpha *= clamp01(since / 0.12);
  if (isActive && s.anim === 'pop' && since < 0.18) sc *= 1 + 0.14 * (1 - since / 0.18);
  if (isActive && s.highlight === 'scale') sc *= 1.18;
  ctx.translate(wx, y + dy);
  ctx.scale(sc, sc);

  let fill = s.color;
  if ((s.highlight === 'color' || s.highlight === 'scale') && isActive) fill = s.accent;
  if (s.highlight === 'fill') fill = spoken ? s.accent : s.color;
  if (s.blend) fill = '#ffffff';

  // backgrounds for the spoken word
  if (isActive && (s.highlight === 'box' || s.highlight === 'marker')) {
    ctx.save();
    ctx.fillStyle = s.accent;
    ctx.beginPath();
    if (s.highlight === 'box') ctx.roundRect(-ww / 2 - size * 0.18, -size * 0.62, ww + size * 0.36, size * 1.2, size * 0.22);
    else {
      ctx.rotate(-0.025);
      ctx.roundRect(-ww / 2 - size * 0.12, -size * 0.18, ww + size * 0.24, size * 0.62, size * 0.08);
    }
    ctx.fill();
    ctx.restore();
  }

  const x0 = -ww / 2;
  if (s.glow && !s.blend) {
    ctx.shadowColor = isActive ? s.accent : s.color;
    ctx.shadowBlur = size * 0.55;
    ctx.fillStyle = fill;
    ctx.fillText(w.text, x0, 0);
    ctx.fillText(w.text, x0, 0);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }
  if (s.shadow && !s.blend) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = size * 0.3;
    ctx.shadowOffsetY = size * 0.07;
    ctx.fillStyle = fill;
    ctx.fillText(w.text, x0, 0);
    ctx.restore();
  }
  if (s.outline && !s.blend) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(2, size * 0.16);
    ctx.strokeStyle = '#000000';
    ctx.strokeText(w.text, x0, 0);
  }
  ctx.fillStyle = fill;
  ctx.fillText(w.text, x0, 0);
  ctx.restore();
}

// ───────────────────────── saved choice ─────────────────────────

const KEY = 'take1.captionStyle';

export function loadStyle(): CaptionStyle {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_STYLE, ...JSON.parse(raw) };
  } catch {
    /* private mode or bad JSON */
  }
  return DEFAULT_STYLE;
}

export function saveStyle(s: CaptionStyle) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
