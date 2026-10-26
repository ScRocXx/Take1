import type { StageMark } from '../lib/store';

/**
 * Semantic command understanding.
 *
 * Take1 only interprets speech after you activate it (hotkey or a click on the
 * pill), so every utterance it hears is meant as a command. That lets it be
 * generous: plain-language paraphrases ("go back", "redo that line", "we're done")
 * and common mishearings ("rap" → wrap, "cot" → cut) all resolve to an intent.
 *
 * Three layers, strongest first:
 *  1. Phonetic repair of words speech engines confuse.
 *  2. A weighted lexicon of phrases per intent + entity extraction (seconds, mark names).
 *  3. Sentence embeddings (MiniLM, local) against example phrases, when the engine has loaded.
 */

export type Command =
  | { type: 'action' }
  | { type: 'cut' }
  | { type: 'cutBack'; seconds: number }
  | { type: 'scratch' }
  | { type: 'hold' }
  | { type: 'zoom'; mark: StageMark }
  | { type: 'wide' }
  | { type: 'redact' }
  | { type: 'chapter'; name: string }
  | { type: 'camera'; on: boolean }
  | { type: 'mic'; on: boolean }
  | { type: 'wrap' };

export type Intent = Command['type'];

/** Example phrases. Used for the call sheet, the lexicon and the embedding prototypes. */
export const PROTOTYPES: Record<Intent, string[]> = {
  action: ['action', 'start recording', 'roll', 'rolling', 'we are live', 'resume', 'continue', 'keep going', 'go ahead', 'back to it', 'lets go', 'start the tape', 'unpause'],
  cut: ['cut', 'retake', 'redo that', 'redo that line', 'do that again', 'take that again', 'try that again', 'i messed up', 'i flubbed that', 'start that sentence over', 'from the top of that line', 'scrap that line', 'one more time', 'let me say that again', 'go back'],
  cutBack: ['go back ten seconds', 'rewind five seconds', 'back up twenty seconds', 'cut back ten'],
  scratch: ['undo', 'scratch that', 'never mind', 'cancel', 'keep it', 'forget it', 'undo that', 'revert that', 'that was fine actually'],
  hold: ['hold', 'pause', 'hold the tape', 'speed this up', 'skip the waiting', 'fast forward', 'this will take a while', 'waiting for the build', 'pause the timer', 'let it load'],
  zoom: ['zoom in', 'zoom in on the terminal', 'focus on the preview', 'show me the code', 'get closer', 'look at the editor'],
  wide: ['zoom out', 'wide', 'go wide', 'full screen', 'pull back', 'show everything', 'whole screen', 'reset the zoom'],
  redact: ['redact that', 'blur that', 'hide that', 'censor that', 'that was a secret', 'blur the key', 'hide the password', 'blur the last bit'],
  chapter: ['mark it', 'new chapter', 'chapter', 'add a marker', 'bookmark this', 'new section', 'mark this moment'],
  camera: ['camera off', 'hide the camera', 'show the camera', 'camera on', 'turn off the camera', 'show my face'],
  mic: ['mute', 'unmute', 'mute the mic', 'turn off the microphone', 'mic on', 'turn the mic back on'],
  wrap: ['thats a wrap', 'wrap it', 'wrap it up', 'stop recording', 'finish', 'we are done', 'end it', 'im done', 'that is it', 'stop', 'end the recording', 'print it'],
};

/** Words speech engines commonly hear instead of our command words. */
const REPAIRS: [RegExp, string][] = [
  [/\b(rap|raps|rapped|wrapped|wrapt|rapt|wrapping|rapping|wrep)\b/g, 'wrap'],
  [/\b(cot|cutt|kut|cud|cuts|cutting|caught it|cat)\b/g, 'cut'],
  [/\b(hole|holed|whole it|hold it|holt|hoad|old)\b/g, 'hold'],
  [/\b(axion|axon|actions|fraction|ackshun|acton)\b/g, 'action'],
  [/\b(reduct|redacted|red act|read act|redux|retract)\b/g, 'redact'],
  [/\b(re take|retaking|retakes|re-take)\b/g, 'retake'],
  [/\b(mike|mic's|my can)\b/g, 'mic'],
  [/\b(scratched|scratching|scratch it)\b/g, 'scratch that'],
  [/\b(zoo|zoomed|zooming)\b/g, 'zoom'],
  [/\b(why'd|wyde|white)\b/g, 'wide'],
  [/\b(take one|take 1|take won|okay take one)\b/g, ''],
];

const NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, a: 1,
};

export function normalize(text: string) {
  let t = text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, to] of REPAIRS) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').trim();
}

function lev(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function findMark(text: string, marks: StageMark[]): StageMark | null {
  const t = ` ${normalize(text)} `;
  let best: StageMark | null = null;
  let bestD = 9;
  for (const m of marks) {
    const n = normalize(m.name);
    if (!n) continue;
    if (t.includes(` ${n} `)) return m;
    for (const w of t.trim().split(' ')) {
      for (const part of n.split(' ')) {
        if (part.length < 3) continue;
        const d = lev(w, part);
        if (d < bestD && d <= (part.length > 5 ? 2 : 1)) {
          bestD = d;
          best = m;
        }
      }
    }
  }
  return best;
}

function parseSeconds(t: string): number | null {
  const m = t.match(/\b(back|rewind|go back|cut back|back up)\b.*?\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty)\b(?: (seconds?|secs?|s))?/);
  if (!m) return null;
  const n = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : NUM[m[2]];
  return n && n <= 120 ? n : null;
}

/** Weighted lexicon: phrase → weight. Matching uses whole words. */
const LEX: Record<Intent, [string, number][]> = {
  action: [['action', 1], ['roll', 0.9], ['rolling', 1], ['resume', 1], ['continue', 0.9], ['keep going', 0.95], ['go ahead', 0.8], ['were live', 1], ['we are live', 1], ['start', 0.75], ['record', 0.7], ['begin', 0.75], ['unpause', 1], ['lets go', 0.8], ['back to it', 0.9]],
  cut: [['cut', 1], ['retake', 1], ['redo', 0.95], ['again', 0.8], ['messed up', 0.95], ['flubbed', 0.95], ['mess', 0.6], ['over', 0.4], ['try that', 0.8], ['one more time', 0.95], ['scrap', 0.85], ['from the top', 0.9], ['go back', 0.75], ['restart', 0.85], ['mistake', 0.85]],
  cutBack: [],
  scratch: [['undo', 1], ['scratch that', 1], ['scratch', 0.9], ['never mind', 1], ['nevermind', 1], ['cancel', 0.95], ['keep it', 0.95], ['forget it', 0.9], ['revert', 0.9]],
  hold: [['hold', 1], ['pause', 0.95], ['wait', 0.75], ['speed', 0.85], ['fast forward', 1], ['skip', 0.7], ['waiting', 0.8], ['loading', 0.7], ['build', 0.45], ['while', 0.35]],
  zoom: [['zoom', 0.9], ['zoom in', 1], ['focus', 0.9], ['closer', 0.85], ['show me', 0.6], ['look at', 0.6], ['go to', 0.5], ['enhance', 0.8]],
  wide: [['wide', 1], ['zoom out', 1.1], ['pull back', 1], ['pull out', 1], ['full screen', 1], ['whole screen', 1], ['everything', 0.7], ['reset the zoom', 1], ['unzoom', 1]],
  redact: [['redact', 1], ['blur', 1], ['censor', 1], ['hide that', 0.95], ['secret', 0.8], ['password', 0.8], ['api key', 0.85], ['key', 0.4], ['private', 0.7]],
  chapter: [['mark it', 1], ['chapter', 1], ['marker', 0.95], ['bookmark', 0.95], ['section', 0.85], ['mark', 0.7]],
  camera: [['camera', 1], ['my face', 0.85], ['webcam', 1], ['bubble', 0.6]],
  mic: [['mute', 1], ['unmute', 1], ['mic', 0.95], ['microphone', 1]],
  wrap: [['wrap', 1], ['thats a wrap', 1.2], ['stop recording', 1.1], ['stop', 0.85], ['finish', 0.95], ['done', 0.85], ['end it', 0.95], ['end the recording', 1.1], ['that is it', 0.85], ['thats it', 0.85], ['print it', 0.9], ['we are done', 1], ['were done', 1]],
};

const has = (t: string, phrase: string) => ` ${t} `.includes(` ${phrase} `);

export interface Interpretation {
  command: Command | null;
  intent: Intent | null;
  confidence: number;
  heard: string;
  alternatives: Intent[];
}

function lexScores(t: string): Record<Intent, number> {
  const words = t.split(' ');
  const out = {} as Record<Intent, number>;
  (Object.keys(LEX) as Intent[]).forEach((k) => {
    let s = 0;
    for (const [p, w] of LEX[k]) {
      if (has(t, p)) s = Math.max(s, w);
      else if (!p.includes(' ') && p.length >= 4 && words.some((x) => x.length >= 4 && lev(x, p) === 1)) s = Math.max(s, w * 0.7);
    }
    // shorter utterances are more decisive
    out[k] = s * (words.length <= 3 ? 1 : words.length <= 6 ? 0.92 : 0.85);
  });
  return out;
}

/**
 * @param embedScores optional cosine scores per intent from the embedding model (0..1)
 */
export function interpret(raw: string, marks: StageMark[], embedScores?: Partial<Record<Intent, number>>): Interpretation {
  const heard = raw.trim();
  const t = normalize(raw);
  const empty: Interpretation = { command: null, intent: null, confidence: 0, heard, alternatives: [] };
  if (!t) return empty;

  // entities first
  const secs = parseSeconds(t);
  if (secs) return { command: { type: 'cutBack', seconds: secs }, intent: 'cutBack', confidence: 1, heard, alternatives: [] };

  const scores = lexScores(t);
  // on/off flavours
  const off = /\b(off|hide|mute|disable|stop showing|no)\b/.test(t) && !/\bunmute\b/.test(t);
  // zoom needs a target; "zoom out" style beats zoom
  const mark = findMark(t, marks);
  if (mark) scores.zoom = Math.max(scores.zoom, has(t, 'out') ? 0 : 0.95);
  if (scores.wide >= 1) scores.zoom = 0;
  if (scores.camera > 0 && scores.mic > 0) scores.mic *= 0.6;

  if (embedScores) {
    (Object.keys(scores) as Intent[]).forEach((k) => {
      const e = embedScores[k] ?? 0;
      // blend: lexicon is precise, embeddings generalize
      scores[k] = Math.max(scores[k], scores[k] * 0.6 + e * 0.55, e > 0.62 ? e : 0);
    });
  }

  const ranked = (Object.keys(scores) as Intent[]).filter((k) => k !== 'cutBack').sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0];
  const conf = scores[best];
  const alternatives = ranked.slice(0, 3).filter((k) => scores[k] > 0.25);
  if (conf < 0.42) return { ...empty, alternatives: alternatives.length ? alternatives : ['cut', 'wrap', 'hold'] };

  let command: Command | null = null;
  switch (best) {
    case 'zoom':
      command = mark ? { type: 'zoom', mark } : marks.length === 1 ? { type: 'zoom', mark: marks[0] } : null;
      break;
    case 'chapter': {
      const m = t.match(/\b(?:mark it|mark|chapter|section|bookmark|marker)\b(?: (?:as|called|named|for))? ?(.*)$/);
      const name = (m?.[1] ?? '').replace(/^(this|here|now|it)\b ?/, '').trim();
      command = { type: 'chapter', name: name.replace(/\b\w/g, (c) => c.toUpperCase()) };
      break;
    }
    case 'camera':
      command = { type: 'camera', on: !off };
      break;
    case 'mic':
      command = { type: 'mic', on: has(t, 'unmute') || /\b(on|back)\b/.test(t) };
      break;
    default:
      command = { type: best } as Command;
  }
  if (!command) return { ...empty, intent: best, confidence: conf, alternatives: ['wide', ...alternatives] };
  return { command, intent: best, confidence: Math.min(1, conf), heard, alternatives };
}

export const INTENT_LABEL: Record<Intent, string> = {
  action: 'Action',
  cut: 'Cut',
  cutBack: 'Cut back',
  scratch: 'Scratch that',
  hold: 'Hold',
  zoom: 'Zoom',
  wide: 'Wide',
  redact: 'Redact',
  chapter: 'Chapter',
  camera: 'Camera',
  mic: 'Mic',
  wrap: 'That’s a wrap',
};

/** The call sheet: what to say, with a plain-language example. */
export const CALL_SHEET: { key: Intent; say: string; also: string; does: string }[] = [
  { key: 'action', say: 'Action', also: '“we’re live”, “keep going”', does: 'Start rolling, or resume from Hold' },
  { key: 'cut', say: 'Cut', also: '“redo that line”, “I messed up”', does: 'Rewind to the start of your sentence, replay 5 s, punch in' },
  { key: 'cutBack', say: 'Back ten seconds', also: '“rewind five”', does: 'Rewind a number of seconds' },
  { key: 'hold', say: 'Hold', also: '“speed this up”, “waiting for the build”', does: 'Squeeze dead air 8× until you say Action' },
  { key: 'zoom', say: 'Zoom terminal', also: '“focus on the preview”', does: 'Ease into a Stage Mark' },
  { key: 'wide', say: 'Wide', also: '“zoom out”, “full screen”', does: 'Back to the whole window' },
  { key: 'redact', say: 'Redact that', also: '“blur that”, “that was a secret”', does: 'Blur the last 5 s on export' },
  { key: 'chapter', say: 'Mark it, live demo', also: '“new chapter: setup”', does: 'Drop a named chapter' },
  { key: 'scratch', say: 'Scratch that', also: '“never mind”, “undo”', does: 'Undo, or cancel a Cut while it replays' },
  { key: 'wrap', say: 'That’s a wrap', also: '“we’re done”, “stop recording”', does: 'Finish and open Review' },
];
