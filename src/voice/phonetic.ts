/**
 * Sound-alike matching for transcribed command words.
 *
 * Speech recognisers often return a word that sounds like the one you said ("rap"
 * for "wrap", "paws" for "pause", "axion" for "action"). Instead of keeping a list
 * of known mistakes, every word is reduced to a phonetic key (a compact Metaphone)
 * and compared by key, so mishearings we never saw still match.
 */

const VOWEL = new Set(['a', 'e', 'i', 'o', 'u']);

/** Compact Metaphone: consonant skeleton of how an English word sounds. */
export function metaphone(input: string): string {
  let w = input.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  const two = w.slice(0, 2);
  if (['kn', 'gn', 'pn', 'ae', 'wr'].includes(two)) w = w.slice(1);
  if (w[0] === 'x') w = 's' + w.slice(1);
  if (two === 'wh') w = 'w' + w.slice(2);

  let out = '';
  const at = (i: number) => w[i] ?? '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const prev = at(i - 1);
    const next = at(i + 1);
    const next2 = at(i + 2);
    if (c === prev && c !== 'c') continue;
    switch (c) {
      case 'a':
      case 'e':
      case 'i':
      case 'o':
      case 'u':
        if (i === 0) out += 'A';
        break;
      case 'b':
        if (!(prev === 'm' && i === w.length - 1)) out += 'B';
        break;
      case 'c':
        if (next === 'i' && next2 === 'a') out += 'X';
        else if (next === 'h') out += prev === 's' ? 'K' : 'X';
        else if ('iey'.includes(next) && next) out += prev === 's' ? '' : 'S';
        else out += 'K';
        break;
      case 'd':
        out += next === 'g' && 'eiy'.includes(next2) && next2 ? 'J' : 'T';
        break;
      case 'g':
        if (next === 'h' && !(i + 2 < w.length && VOWEL.has(next2))) break;
        if (next === 'n' && (i + 2 === w.length || (next2 === 'e' && at(i + 3) === 'd'))) break;
        out += 'iey'.includes(next) && next && prev !== 'g' ? 'J' : 'K';
        break;
      case 'h':
        if (VOWEL.has(next) && !'csptg'.includes(prev)) out += 'H';
        break;
      case 'k':
        if (prev !== 'c') out += 'K';
        break;
      case 'p':
        out += next === 'h' ? 'F' : 'P';
        break;
      case 'q':
        out += 'K';
        break;
      case 's':
        if (next === 'h' || (next === 'i' && (next2 === 'o' || next2 === 'a'))) out += 'X';
        else out += 'S';
        break;
      case 't':
        if (next === 'i' && (next2 === 'o' || next2 === 'a')) out += 'X';
        else if (next === 'h') out += '0';
        else if (!(next === 'c' && next2 === 'h')) out += 'T';
        break;
      case 'v':
        out += 'F';
        break;
      case 'w':
      case 'y':
        if (VOWEL.has(next)) out += c.toUpperCase();
        break;
      case 'x':
        out += 'KS';
        break;
      case 'z':
        out += 'S';
        break;
      default:
        out += c.toUpperCase();
    }
  }
  // collapse doubles produced by the rules (e.g. "ck" → KK)
  return out.replace(/(.)\1+/g, '$1');
}

export function lev(a: string, b: string, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const keyCache = new Map<string, string>();
const key = (w: string) => {
  let k = keyCache.get(w);
  if (k === undefined) keyCache.set(w, (k = metaphone(w)));
  return k;
};

/**
 * How well a heard word matches an expected word (0..1).
 * 1 exact · 0.85 sounds the same · 0.7 one sound off (longer words) or a one-letter typo.
 */
export function wordMatch(heard: string, want: string): number {
  if (heard === want) return 1;
  // "plays", "paused", "zooming" → the base word
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (heard.length > suffix.length + 2 && heard.endsWith(suffix)) {
      const m = wordMatch(heard.slice(0, -suffix.length), want);
      if (m) return Math.min(0.8, m);
    }
  }
  if (/^\d+$/.test(heard) || /^\d+$/.test(want)) return 0;
  const kh = key(heard);
  const kw = key(want);
  if (kh.length >= 2 && kh === kw) return 0.85;
  if (kw.length >= 3 && kh.length >= 2 && lev(kh, kw, 1) <= 1) return 0.7;
  if (want.length >= 5 && lev(heard, want, 1) <= 1) return 0.7;
  return 0;
}
