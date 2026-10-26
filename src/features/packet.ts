import { clock, srtTime } from '../lib/time';
import type { ChapterInfo } from '../lib/store';

export interface Line { start: number; end: number; text: string }

/** Split long lines into ≤2 rows of ~42 characters, as broadcast captions do. */
function wrapCaption(text: string, max = 42) {
  const words = text.split(/\s+/);
  const rows: string[] = [];
  let row = '';
  for (const w of words) {
    if ((row + ' ' + w).trim().length > max && row) {
      rows.push(row);
      row = w;
    } else row = (row + ' ' + w).trim();
  }
  if (row) rows.push(row);
  return rows;
}

export function toSrt(lines: Line[]) {
  const cues: Line[] = [];
  for (const l of lines) {
    const rows = wrapCaption(l.text);
    // more than two rows → split the line in time proportionally
    const groups: string[][] = [];
    for (let i = 0; i < rows.length; i += 2) groups.push(rows.slice(i, i + 2));
    const total = groups.reduce((a, g) => a + g.join(' ').length, 0) || 1;
    let t = l.start;
    for (const g of groups) {
      const d = ((l.end - l.start) * g.join(' ').length) / total;
      cues.push({ start: t, end: t + d, text: g.join('\n') });
      t += d;
    }
  }
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(Math.max(c.end, c.start + 0.6))}\n${c.text}\n`).join('\n');
}

export function toChapters(chapters: ChapterInfo[], duration: number) {
  const list = [...chapters].filter((c) => c.t < duration).sort((a, b) => a.t - b.t);
  if (!list.length || list[0].t > 1) list.unshift({ id: 'intro', t: 0, name: 'Intro' });
  else list[0] = { ...list[0], t: 0 };
  return list.map((c) => `${clock(c.t).padStart(4, '0')} ${c.name}`).join('\n');
}

function sentences(lines: Line[]) {
  return lines
    .map((l) => l.text.trim())
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .map((s) => (/[.!?]$/.test(s) ? s : s + '.'));
}

export function toMarkdown(o: { title: string; lines: Line[]; chapters: ChapterInfo[]; duration: number; outtakes: number; holds: number; compressed: number }) {
  const s = sentences(o.lines);
  const hook = s.slice(0, 2).join(' ') || 'A voice-directed demo recorded in one take.';
  const body = s.slice(2, 8).join(' ');
  return `# ${o.title}

${hook}

${body ? body + '\n\n' : ''}## Chapters

${toChapters(o.chapters, o.duration)}

## How it was made

- Recorded with **Take1**, a screen recorder you direct with your voice
- ${clock(o.duration)} final cut, ${o.outtakes} fluffed line${o.outtakes === 1 ? '' : 's'} fixed live with “Cut”, zero editing afterwards
${o.holds ? `- ${o.holds} wait${o.holds === 1 ? '' : 's'} compressed with “Hold” (${Math.round(o.compressed)} s of dead air removed)\n` : ''}- Built hands-free with Wispr Flow

#NoHandsChallenge #WisprFlow
`;
}

export function toSocial(o: { title: string; lines: Line[]; duration: number; outtakes: number }) {
  const first = sentences(o.lines)[0] ?? '';
  return `I fluffed ${o.outtakes} line${o.outtakes === 1 ? '' : 's'} recording this and you’ll never find them.

${o.title}${first ? ` — ${first}` : ''}

Recorded in one take with Take1: say “Cut”, it rewinds to the start of your sentence, counts you back in, and splices the retake. The video is done when you say “That’s a wrap.” (${clock(o.duration)})

Built entirely by voice with @WisprFlow. #NoHandsChallenge`;
}

export function guessTitle(lines: Line[]) {
  const first = lines[0]?.text ?? '';
  const m = first.match(/(?:this is|introducing|meet|i built|we built|i made)\s+(.{3,40}?)(?:[,.!?]|$)/i);
  if (m) return m[1].replace(/^\w/, (c) => c.toUpperCase());
  return 'My Take1 demo';
}
