import type { StageMark } from '../lib/store';
import { wordMatch } from './phonetic';

/**
 * Turns a short spoken command into an action.
 *
 * Take1 only listens while you hold the talk keys, so every utterance is meant as
 * a command, which lets matching be generous:
 *  1. The text is tokenised (numbers like "3x" or "twenty five" become values).
 *  2. Each intent has trigger phrases; tokens match exactly or by sound
 *     (see phonetic.ts), so "rap" still means wrap and "paws" still means pause.
 *  3. Entities come from token positions: the number before "x" is a speed, the
 *     number after "back" is seconds, the words after "chapter" are its name.
 *  4. When the local embedding model is loaded, sentence similarity to example
 *     phrases is blended in, which covers paraphrases the phrase lists don't.
 */

export type Command =
  | { type: 'action' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'cut' }
  | { type: 'cutBack'; seconds: number }
  | { type: 'scratch' }
  | { type: 'hold'; factor?: number }
  | { type: 'zoom'; mark: StageMark | null; name?: string }
  | { type: 'wide' }
  | { type: 'redact' }
  | { type: 'unblur' }
  | { type: 'chapter'; name: string }
  | { type: 'camera'; on: boolean }
  | { type: 'mic'; on: boolean }
  | { type: 'wrap' };

export type Intent = Command['type'];

/** Example sentences for the embedding model. */
export const PROTOTYPES: Record<Intent, string[]> = {
  action: ['start recording', 'begin recording', 'we are live', 'start the recording now'],
  play: ['play', 'continue', 'resume', 'keep going', 'carry on', 'okay go on', 'back to normal speed', 'lets continue'],
  pause: ['pause', 'wait a second', 'hold on', 'hang on', 'give me a moment', 'stop for a moment', 'take a break'],
  cut: ['cut', 'redo that line', 'let me say that again', 'i messed up', 'oops again', 'that was wrong', 'one more time', 'try that again'],
  cutBack: ['go back ten seconds', 'rewind five seconds'],
  scratch: ['undo', 'never mind', 'cancel that', 'forget it', 'that was fine actually'],
  hold: ['speed this up', 'fast forward', 'this will take a while', 'waiting for the build', 'skip the waiting'],
  zoom: ['zoom in', 'zoom in here', 'get closer', 'focus on this part', 'magnify this'],
  wide: ['zoom out', 'show the whole screen', 'full view', 'reset the zoom'],
  redact: ['blur that', 'hide that', 'that was private', 'that was a password', 'cover that up'],
  unblur: ['unblur', 'stop blurring', 'remove the blur'],
  chapter: ['new chapter', 'mark this moment', 'next section', 'moving on to the next part'],
  camera: ['turn the camera off', 'show the camera', 'hide my face'],
  mic: ['mute the microphone', 'unmute', 'turn the mic back on'],
  wrap: ['thats a wrap', 'stop recording', 'we are done', 'that is all', 'finish the recording'],
};

/** Trigger phrases per intent, with a weight for how decisive each one is. */
const PHRASES: Record<Intent, [string, number][]> = {
  action: [['action', 1], ['start recording', 1.1], ['start', 0.8], ['record', 0.75], ['begin', 0.8], ['roll', 0.9], ['rolling', 0.95], ['were live', 1], ['we are live', 1]],
  play: [['play', 1.05], ['continue', 1], ['resume', 1], ['keep going', 1], ['go on', 0.95], ['carry on', 1], ['unpause', 1.1], ['back to it', 0.9], ['were back', 0.95], ['normal speed', 1.1], ['regular speed', 1.1], ['ready', 0.75], ['go', 0.6], ['go ahead', 0.85], ['lets go', 0.85], ['proceed', 0.9]],
  pause: [['pause', 1.05], ['wait', 0.9], ['hold on', 1.15], ['hang on', 1.1], ['one sec', 1], ['one second', 1], ['a second', 0.85], ['a moment', 0.9], ['just a sec', 1], ['break', 0.75], ['freeze', 0.9], ['stop for', 1.05]],
  cut: [['cut', 1], ['retake', 1], ['redo', 0.95], ['again', 0.8], ['messed up', 0.95], ['flubbed', 0.95], ['oops', 0.95], ['whoops', 0.95], ['sorry', 0.7], ['wrong', 0.8], ['mistake', 0.9], ['try that', 0.85], ['one more time', 0.95], ['scrap', 0.85], ['from the top', 0.9], ['go back', 0.8], ['restart', 0.85], ['start over', 0.9], ['do over', 0.95], ['say that again', 1], ['rewind', 0.8]],
  cutBack: [],
  scratch: [['undo', 1], ['scratch that', 1], ['scratch', 0.9], ['never mind', 1], ['nevermind', 1], ['cancel', 0.95], ['keep it', 0.95], ['forget it', 0.9], ['revert', 0.9], ['was fine', 0.85]],
  hold: [['hold', 1], ['speed up', 1.1], ['speed', 0.9], ['fast forward', 1.1], ['faster', 0.9], ['skip ahead', 0.95], ['skip', 0.7], ['timelapse', 1], ['time lapse', 1], ['waiting', 0.8], ['loading', 0.7], ['hurry', 0.8]],
  zoom: [['zoom', 0.9], ['zoom in', 1], ['zoom here', 1.05], ['focus', 0.9], ['closer', 0.85], ['magnify', 1], ['enhance', 0.8]],
  wide: [['wide', 1], ['zoom out', 1.15], ['pull back', 1], ['full screen', 1], ['full view', 1], ['whole screen', 1], ['reset the zoom', 1.1], ['reset zoom', 1.1], ['unzoom', 1.1], ['back out', 0.9]],
  redact: [['redact', 1], ['blur', 1], ['blur that', 1.1], ['censor', 1], ['hide that', 0.95], ['hide', 0.75], ['cover', 0.8], ['secret', 0.8], ['password', 0.8], ['api key', 0.85], ['private', 0.75], ['sensitive', 0.8]],
  unblur: [['unblur', 1.2], ['stop blurring', 1.2], ['remove the blur', 1.2], ['no more blur', 1.2], ['end the blur', 1.2], ['stop the blur', 1.2], ['show it again', 1]],
  chapter: [['chapter', 1], ['new chapter', 1.05], ['mark it', 1], ['marker', 0.95], ['bookmark', 0.95], ['section', 0.85], ['next part', 0.95], ['next topic', 0.95], ['moving on to', 0.9], ['mark', 0.7]],
  camera: [['camera', 1], ['webcam', 1], ['my face', 0.85]],
  mic: [['mute', 1], ['unmute', 1], ['mic', 0.95], ['microphone', 1]],
  wrap: [['wrap', 1], ['thats a wrap', 1.2], ['stop recording', 1.15], ['stop', 0.85], ['finish', 0.95], ['finished', 0.95], ['done', 0.85], ['all done', 1], ['were done', 1], ['we are done', 1], ['im done', 1], ['end recording', 1.15], ['end the recording', 1.15], ['end', 0.7], ['thats it', 0.85], ['thats all', 0.9]],
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
};
const MULTIPLIER_WORDS: Record<string, number> = { double: 2, twice: 2, triple: 3, quadruple: 4 };
const TIMES_WORDS = new Set(['x', 'times']);
const BACK_WORDS = new Set(['back', 'rewind']);
const NAME_STOP = new Set(['on', 'to', 'into', 'in', 'the', 'a', 'an', 'as', 'called', 'named', 'for', 'it', 'this', 'that', 'here', 'there', 'now', 'is', 'please']);
const FILLERS = new Set(['uh', 'um', 'umm', 'uhh', 'hmm', 'erm', 'okay', 'ok', 'so', 'please', 'just', 'like']);

/** Lower-case words; digits split from letters ("3x" → "3", "x"); punctuation dropped. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let kind: 'a' | 'd' | null = null;
  const push = () => {
    if (cur) out.push(cur);
    cur = '';
    kind = null;
  };
  for (const ch of text.toLowerCase()) {
    if (ch === '’' || ch === "'") continue;
    const k = ch >= '0' && ch <= '9' ? 'd' : ch >= 'a' && ch <= 'z' ? 'a' : ch === '×' ? 'x' : null;
    if (k === 'x') {
      push();
      out.push('x');
    } else if (!k) push();
    else {
      if (kind && kind !== k) push();
      kind = k;
      cur += ch;
    }
  }
  push();
  return out;
}

/** Numbers in the token list, with where they are ("twenty five" → 25 spanning two tokens). */
function numbers(tokens: string[]) {
  const found: { value: number; start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+$/.test(t)) found.push({ value: parseInt(t, 10), start: i, end: i + 1 });
    else if (t in NUMBER_WORDS) {
      let v = NUMBER_WORDS[t];
      const next = tokens[i + 1];
      // "twenty five" → 25
      const unit = next !== undefined && next in NUMBER_WORDS && NUMBER_WORDS[next] < 10 && v >= 20 ? NUMBER_WORDS[next] : null;
      if (unit !== null) v += unit;
      found.push({ value: v, start: i, end: unit !== null ? i + 2 : i + 1 });
      if (unit !== null) i++;
    }
  }
  return found;
}

interface PhraseHit {
  score: number;
  start: number;
  end: number;
}

/** Best place a phrase appears in the tokens, matching word by word (exactly or by sound). */
function findPhrase(tokens: string[], phrase: string): PhraseHit | null {
  const want = phrase.split(' ');
  let best: PhraseHit | null = null;
  for (let i = 0; i + want.length <= tokens.length; i++) {
    let q = 0;
    for (let j = 0; j < want.length; j++) {
      const m = wordMatch(tokens[i + j], want[j]);
      if (!m) {
        q = 0;
        break;
      }
      q += m;
    }
    q /= want.length;
    if (q && (!best || q > best.score)) best = { score: q, start: i, end: i + want.length };
  }
  return best;
}

export function findMark(text: string, marks: StageMark[]): StageMark | null {
  const tokens = tokenize(text);
  let best: StageMark | null = null;
  let bestQ = 0;
  for (const m of marks) {
    const name = tokenize(m.name).join(' ');
    if (!name) continue;
    const hit = findPhrase(tokens, name);
    if (hit && hit.score > bestQ) {
      bestQ = hit.score;
      best = m;
    }
  }
  return bestQ >= 0.7 ? best : null;
}

/** Words after a trigger phrase, minus connecting words: "chapter called live demo" → "Live Demo". */
function nameAfter(tokens: string[], from: number) {
  const rest = tokens.slice(from).filter((t) => !FILLERS.has(t));
  while (rest.length && NAME_STOP.has(rest[0])) rest.shift();
  return rest.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export interface Interpretation {
  command: Command | null;
  intent: Intent | null;
  confidence: number;
  heard: string;
  alternatives: Intent[];
}

/**
 * @param embedScores optional cosine similarity per intent from the embedding model (0..1)
 */
export function interpret(raw: string, marks: StageMark[], embedScores?: Partial<Record<Intent, number>>): Interpretation {
  const heard = raw.trim();
  const all = tokenize(raw);
  const tokens = all.filter((t) => !FILLERS.has(t));
  const empty: Interpretation = { command: null, intent: null, confidence: 0, heard, alternatives: [] };
  if (!tokens.length) return empty;

  // entities
  const nums = numbers(tokens);
  let factor: number | null = null;
  let seconds: number | null = null;
  // "back"/"rewind" anywhere makes a number a duration ("go back ten", "ten seconds back"),
  // so "one sec" on its own stays a pause
  const goingBack = tokens.some((t) => BACK_WORDS.has(t));
  for (const n of nums) {
    const after = tokens[n.end];
    if (after && TIMES_WORDS.has(after)) factor = n.value;
    else if (goingBack) seconds = n.value;
  }
  for (const t of tokens) if (t in MULTIPLIER_WORDS) factor = MULTIPLIER_WORDS[t];
  if (factor !== null && (factor < 2 || factor > 16)) factor = factor === 1 ? null : Math.min(16, Math.max(2, factor));
  if (seconds !== null && seconds > 0 && seconds <= 120 && factor === null) {
    return { command: { type: 'cutBack', seconds }, intent: 'cutBack', confidence: 1, heard, alternatives: [] };
  }

  // phrase scores
  const shortness = tokens.length <= 3 ? 1 : tokens.length <= 6 ? 0.93 : 0.85;
  const scores = {} as Record<Intent, number>;
  const spans = {} as Record<Intent, PhraseHit | null>;
  (Object.keys(PHRASES) as Intent[]).forEach((k) => {
    let s = 0;
    let span: PhraseHit | null = null;
    for (const [p, w] of PHRASES[k]) {
      const hit = findPhrase(tokens, p);
      if (hit && hit.score * w > s) {
        s = hit.score * w;
        span = hit;
      }
    }
    scores[k] = s * shortness;
    spans[k] = span;
  });

  if (factor) scores.hold = Math.max(scores.hold, 1.05);
  const mark = findMark(tokens.join(' '), marks);
  if (mark) scores.zoom = Math.max(scores.zoom, tokens.includes('out') ? 0 : 0.95);
  if (scores.wide >= 1) scores.zoom = 0;
  if (scores.unblur >= 1) scores.redact = 0;
  if (scores.camera > 0 && scores.mic > 0) scores.mic *= 0.6;
  // "hold on" is a pause, "hold 3x" is a speed-up
  if (findPhrase(tokens, 'hold on') && !factor) scores.hold *= 0.5;

  if (embedScores) {
    (Object.keys(scores) as Intent[]).forEach((k) => {
      const e = embedScores[k] ?? 0;
      scores[k] = Math.max(scores[k], scores[k] * 0.6 + e * 0.55, e > 0.62 ? e : 0);
    });
  }

  const ranked = (Object.keys(scores) as Intent[]).filter((k) => k !== 'cutBack').sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0];
  const conf = scores[best];
  const alternatives = ranked.slice(0, 3).filter((k) => scores[k] > 0.25);
  if (conf < 0.42) return { ...empty, alternatives: alternatives.length ? alternatives : ['cut', 'pause', 'wrap'] };

  const span = spans[best];
  let command: Command;
  switch (best) {
    case 'zoom': {
      const name = span ? nameAfter(tokens, span.end) : '';
      const spot = mark ?? (marks.length === 1 && !name ? marks[0] : null);
      command = { type: 'zoom', mark: spot, name: spot ? undefined : name || undefined };
      break;
    }
    case 'hold':
      command = { type: 'hold', factor: factor ?? undefined };
      break;
    case 'chapter':
      command = { type: 'chapter', name: span ? nameAfter(tokens, span.end) : '' };
      break;
    case 'camera':
      command = { type: 'camera', on: !tokens.some((t) => ['off', 'hide', 'disable', 'no'].includes(t)) };
      break;
    case 'mic':
      command = { type: 'mic', on: tokens.includes('unmute') || tokens.includes('on') || tokens.includes('back') };
      break;
    default:
      command = { type: best } as Command;
  }
  return { command, intent: best, confidence: Math.min(1, conf), heard, alternatives };
}

export const INTENT_LABEL: Record<Intent, string> = {
  action: 'Start',
  play: 'Play',
  pause: 'Pause',
  cut: 'Cut',
  cutBack: 'Go back',
  scratch: 'Undo',
  hold: 'Speed up',
  zoom: 'Zoom in',
  wide: 'Zoom out',
  redact: 'Blur',
  unblur: 'Unblur',
  chapter: 'Chapter',
  camera: 'Camera',
  mic: 'Mic',
  wrap: 'Finish',
};

/** What you can say, with plain-language alternatives. */
export const CALL_SHEET: { key: Intent; say: string; also: string; does: string }[] = [
  { key: 'action', say: 'Start recording', also: '“action”, “we’re live”', does: 'Start recording' },
  { key: 'pause', say: 'Pause', also: '“hang on”, “one sec”, “wait”', does: 'Stop recording until you say Play' },
  { key: 'play', say: 'Play', also: '“continue”, “carry on”, “normal speed”', does: 'Carry on after Pause or Speed up, or skip the countdown' },
  { key: 'cut', say: 'Cut', also: '“oops, again”, “redo that line”', does: 'Remove the sentence you just said, replay 5 s, then record again' },
  { key: 'cutBack', say: 'Back ten seconds', also: '“rewind five”', does: 'Remove an exact number of seconds' },
  { key: 'hold', say: 'Speed up', also: '“hold 3x”, “fast forward 8x”', does: 'Waiting plays at 4× (or what you say) until Play' },
  { key: 'zoom', say: 'Zoom in', also: '“zoom terminal”, “zoom here”', does: 'Zoom into a named spot, or pause and draw one' },
  { key: 'wide', say: 'Zoom out', also: '“full screen”', does: 'Back to the whole window' },
  { key: 'redact', say: 'Blur that', also: '“hide that”, “that’s private”', does: 'Pause and drag over what to blur' },
  { key: 'unblur', say: 'Unblur', also: '“stop blurring”', does: 'End a blur you left running' },
  { key: 'chapter', say: 'Chapter: live demo', also: '“new chapter setup”, “next part”', does: 'Add a named chapter' },
  { key: 'scratch', say: 'Undo', also: '“never mind”, “cancel”', does: 'Undo the last thing, or cancel a Cut during its replay' },
  { key: 'wrap', say: 'Stop recording', also: '“that’s a wrap”, “we’re done”', does: 'Finish and open Review' },
];
