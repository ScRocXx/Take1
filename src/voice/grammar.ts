import type { StageMark } from '../lib/store';

export type Command =
  | { type: 'action' }
  | { type: 'cut'; trailing?: boolean }
  | { type: 'cutBack'; seconds: number }
  | { type: 'scratch' }
  | { type: 'hold' }
  | { type: 'zoom'; mark: StageMark }
  | { type: 'wide' }
  | { type: 'redact' }
  | { type: 'chapter'; name: string }
  | { type: 'camera'; on: boolean }
  | { type: 'wrap' };

export const GRAMMAR: { say: string; does: string; also: string; key: Command['type']; tone: string }[] = [
  { say: 'Action', does: 'Start rolling, or resume from Hold', also: 'Rolling · We’re live', key: 'action', tone: 'tally' },
  { say: 'Cut', does: 'Rewind to the start of this sentence and punch back in', also: 'Retake · Cut that', key: 'cut', tone: 'cue' },
  { say: 'Cut back ten', does: 'Rewind a number of seconds', also: 'Back five', key: 'cutBack', tone: 'cue' },
  { say: 'Scratch that', does: 'Undo the last command, or cancel a Cut during pre-roll', also: 'Undo · Keep it', key: 'scratch', tone: 'muted' },
  { say: 'Hold', does: 'Compress dead air 8× until you say Action', also: 'Hold tape · Pause timer', key: 'hold', tone: 'hold' },
  { say: 'Zoom terminal', does: 'Ease into a Stage Mark by name', also: 'Focus preview · Zoom in on…', key: 'zoom', tone: 'ok' },
  { say: 'Wide', does: 'Back to the full frame', also: 'Pull out · Zoom out', key: 'wide', tone: 'ok' },
  { say: 'Redact that', does: 'Blur the last 5 seconds on export', also: 'Blur that', key: 'redact', tone: 'redact' },
  { say: 'Mark it, live demo', does: 'Drop a named chapter', also: 'Chapter …', key: 'chapter', tone: 'ok' },
  { say: 'Camera off', does: 'Hide or show the camera bubble', also: 'Camera on · Hide camera', key: 'camera', tone: 'muted' },
  { say: 'That’s a wrap', does: 'Stop and open Dailies', also: 'Wrap it', key: 'wrap', tone: 'tally' },
];

const NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, a: 1,
};

export function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(words: string[]): number | null {
  let total = 0;
  let seen = false;
  for (const w of words) {
    if (/^\d+$/.test(w)) {
      total += parseInt(w, 10);
      seen = true;
    } else if (w in NUM && !(w === 'a' && seen)) {
      total += NUM[w];
      seen = true;
    } else if (seen) break;
  }
  return seen ? total : null;
}

function lev(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function findMark(name: string, marks: StageMark[]): StageMark | null {
  const n = normalize(name).replace(/^(the|my|on|to|into|in on|in to) /, '').replace(/ (window|panel|pane)$/, '');
  if (!n) return null;
  let best: StageMark | null = null;
  let bestD = Infinity;
  for (const m of marks) {
    const mn = normalize(m.name);
    if (mn === n || n.includes(mn) || mn.includes(n)) return m;
    const d = lev(mn, n);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best && bestD <= Math.max(1, Math.floor(normalize(best.name).length / 4)) ? best : null;
}

const exact = (t: string, list: string[]) => list.includes(t);

/**
 * Parse one utterance. Commands must be the whole utterance (said after a pause),
 * which is what keeps "a short cut" or "hold on" in narration from firing.
 * Only Cut may end a sentence ("…the server is ru— cut cut").
 */
export function parse(raw: string, marks: StageMark[], strict = false): Command | null {
  let t = normalize(raw);
  const prefixed = /^(take ?one|take ?1|take one|okay take one)\b/.test(t);
  if (prefixed) t = t.replace(/^(okay )?take ?(one|1)\b ?/, '');
  if (strict && !prefixed) return null;
  if (!t) return null;

  if (exact(t, ['action', 'rolling', 'were live', 'and were live', 'we are live', 'and we are live', 'resume', 'roll', 'roll it', 'and action'])) return { type: 'action' };
  if (exact(t, ['cut', 'cut cut', 'retake', 'cut that', 'take it again', 'redo', 'redo that', 'again', 'one more time'])) return { type: 'cut' };
  if (/ (cut cut|retake|cut that)$/.test(t) && t.split(' ').length > 2) return { type: 'cut', trailing: true };
  let m = t.match(/^(?:cut )?(?:go )?back (.+?)(?: seconds?| secs?)?$/);
  if (m) {
    const n = parseNumber(m[1].split(' '));
    if (n && n <= 120) return { type: 'cutBack', seconds: n };
  }
  if (exact(t, ['scratch that', 'scratch', 'undo', 'undo that', 'keep it', 'never mind', 'nevermind'])) return { type: 'scratch' };
  if (exact(t, ['hold', 'hold tape', 'hold it', 'pause timer', 'hold the tape', 'speed up'])) return { type: 'hold' };
  if (exact(t, ['wide', 'pull out', 'zoom out', 'full frame', 'full screen', 'go wide', 'wide shot'])) return { type: 'wide' };
  if (exact(t, ['redact that', 'redact', 'blur that', 'blur it', 'censor that', 'blur coordinates'])) return { type: 'redact' };
  if (exact(t, ['camera off', 'hide camera', 'hide the camera', 'no camera'])) return { type: 'camera', on: false };
  if (exact(t, ['camera on', 'show camera', 'show the camera', 'picture in picture'])) return { type: 'camera', on: true };
  if (exact(t, ['thats a wrap', 'that is a wrap', 'its a wrap', 'wrap it', 'wrap', 'wrap recording', 'and thats a wrap', 'cut and wrap'])) return { type: 'wrap' };
  m = t.match(/^(?:zoom(?: in)?(?: on| to| into)?|focus(?: on)?|show(?: me)?(?: the)?) (.+)$/);
  if (m) {
    const mark = findMark(m[1], marks);
    if (mark) return { type: 'zoom', mark };
  }
  m = t.match(/^(?:mark it|mark|chapter|new chapter)(?: as| called)? ?(.*)$/);
  if (m && (t.startsWith('mark it') || t.startsWith('chapter') || t.startsWith('new chapter') || m[1])) {
    const name = m[1].trim();
    return { type: 'chapter', name: name ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : '' };
  }
  return null;
}
