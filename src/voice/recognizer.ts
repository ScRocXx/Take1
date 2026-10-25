/**
 * Streaming speech recognition (Web Speech API, Chrome/Edge).
 * Emits interim + final text per utterance, with the AudioContext time the
 * utterance was first heard so the director can find its true onset.
 */

export interface SpeechEvent {
  type: 'interim' | 'final';
  key: string;
  text: string;
  firstHeard: number;
}

export class Recognizer {
  private rec: any = null;
  private active = false;
  private session = 0;
  private seen = new Map<number, number>();

  constructor(
    private now: () => number,
    private onSpeech: (e: SpeechEvent) => void,
    private onStatus: (s: 'on' | 'off' | 'error', detail?: string) => void,
  ) {}

  static get supported() {
    return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.spawn();
  }

  private spawn() {
    const R = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!R) return this.onStatus('error', 'unsupported');
    const r = new R();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-US';
    r.maxAlternatives = 1;
    const session = ++this.session;
    this.seen = new Map();
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = String(res[0]?.transcript ?? '').trim();
        if (!text) continue;
        if (!this.seen.has(i)) this.seen.set(i, this.now());
        this.onSpeech({ type: res.isFinal ? 'final' : 'interim', key: `${session}:${i}`, text, firstHeard: this.seen.get(i)! });
      }
    };
    r.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        this.active = false;
        this.onStatus('error', e.error);
      }
    };
    r.onend = () => {
      if (this.active && session === this.session) {
        try {
          this.spawn();
        } catch {
          setTimeout(() => this.spawn(), 250);
        }
      } else if (!this.active) this.onStatus('off');
    };
    this.rec = r;
    try {
      r.start();
      this.onStatus('on');
    } catch (err) {
      this.onStatus('error', String(err));
    }
  }

  stop() {
    this.active = false;
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
  }
}
