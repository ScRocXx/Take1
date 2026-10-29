import { clock, srtTime } from './time';

/** Captions, chapters and a title from the transcript of a recording. */

export interface Line {
  start: number;
  end: number;
  text: string;
}

export interface Chapter {
  t: number;
  name: string;
}

/** Split long lines into rows of ~42 characters, as broadcast captions do. */
function rows(text: string, max = 42) {
  const out: string[] = [];
  let row = '';
  for (const w of text.split(/\s+/)) {
    if ((row + ' ' + w).trim().length > max && row) {
      out.push(row);
      row = w;
    } else row = (row + ' ' + w).trim();
  }
  if (row) out.push(row);
  return out;
}

/** Readable caption cues: at most two rows each, timed in proportion to their length. */
export function toCues(lines: Line[]): Line[] {
  const cues: Line[] = [];
  for (const l of lines) {
    const r = rows(l.text);
    const groups: string[][] = [];
    for (let i = 0; i < r.length; i += 2) groups.push(r.slice(i, i + 2));
    const total = groups.reduce((a, g) => a + g.join(' ').length, 0) || 1;
    let t = l.start;
    for (const g of groups) {
      const d = ((l.end - l.start) * g.join(' ').length) / total;
      cues.push({ start: t, end: Math.max(t + d, t + 0.6), text: g.join('\n') });
      t += d;
    }
  }
  return cues;
}

export function toSrt(lines: Line[]) {
  return toCues(lines)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(lines: Line[]) {
  const t = (s: number) => srtTime(s).replace(',', '.');
  return 'WEBVTT\n\n' + toCues(lines).map((c) => `${t(c.start)} --> ${t(c.end)}\n${c.text}\n`).join('\n');
}

/** Chapters in time order, the first one moved to 0:00 (players and YouTube expect that). */
export function normalizeChapters(chapters: Chapter[], duration: number): Chapter[] {
  const list = [...chapters].filter((c) => c.t < duration).sort((a, b) => a.t - b.t);
  if (!list.length) return [];
  if (list[0].t > 0.5) list.unshift({ t: 0, name: 'Start' });
  else list[0] = { ...list[0], t: 0 };
  return list;
}

/** "0:00 Intro" lines, ready to paste into a YouTube description. */
export function chapterList(chapters: Chapter[], duration: number) {
  return normalizeChapters(chapters, duration)
    .map((c) => `${clock(c.t)} ${c.name || 'Chapter'}`)
    .join('\n');
}

/**
 * Why YouTube wouldn't show these as chapters, or null if it will.
 * YouTube needs at least three timestamps, starting at 0:00, each at least 10 s long.
 */
export function youtubeChapterProblem(chapters: Chapter[], duration: number): string | null {
  const list = normalizeChapters(chapters, duration);
  if (list.length < 3) return `YouTube shows chapters when there are at least 3. You have ${list.length}.`;
  for (let i = 0; i < list.length; i++) {
    const end = list[i + 1]?.t ?? duration;
    if (end - list[i].t < 10) return `“${list[i].name}” is shorter than 10 s. YouTube needs each chapter to be at least 10 s.`;
  }
  return null;
}

const FILLER = new Set(['so', 'and', 'now', 'okay', 'ok', 'alright', 'right', 'um', 'uh', 'well', 'then', 'next', 'also', 'here', 'lets', 'let', 'us', 'i', 'ill', 'we', 'well', 'just']);

/** First words of the first sentence of a line, without the "so, um, now…" lead-in. */
function headline(text: string, maxWords: number) {
  const sentence = text.split(/(?<=[.!?])\s/)[0];
  const words = sentence.replace(/[.!?,;:]+/g, '').split(/\s+/).filter(Boolean);
  while (words.length && FILLER.has(words[0].toLowerCase().replace(/[’']/g, ''))) words.shift();
  if (words.length < 2) return '';
  const s = words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '…' : '');
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Suggested chapters: split the transcript at its longest pauses so each chapter is
 * at least 10 s, named after its opening words. The first one starts at 0:00.
 */
export function suggestChapters(lines: Line[], duration: number): Chapter[] {
  if (!lines.length || duration < 20) return [];
  // YouTube needs at least three chapters of 10 s or more, so aim for three when there's room
  const want = Math.max(duration >= 30 ? 3 : 2, Math.min(8, Math.round(duration / 40)));
  const gaps = lines
    .map((l, i) => ({ i, gap: i ? l.start - lines[i - 1].end : -1 }))
    .filter((g) => g.i > 0)
    .sort((a, b) => b.gap - a.gap);
  const picked: number[] = [0];
  for (const g of gaps) {
    if (picked.length >= want) break;
    const t = lines[g.i].start;
    if (t < 10 || duration - t < 10) continue;
    if (picked.some((p) => Math.abs((p === 0 ? 0 : lines[p].start) - t) < 10)) continue;
    picked.push(g.i);
  }
  return picked
    .sort((a, b) => a - b)
    .map((i, k) => ({ t: k === 0 ? 0 : Math.round(lines[i].start * 10) / 10, name: headline(lines[i].text, 5) || (k === 0 ? 'Intro' : `Part ${k + 1}`) }));
}

/** A starting title: the opening words of what you said first. */
export function guessTitle(lines: Line[]) {
  return (lines[0] && headline(lines[0].text, 7)) || '';
}
