/**
 * Fallback for when the local engine hasn't loaded yet (browser only):
 * a single short Web Speech session that returns one phrase. Never runs
 * continuously, so there is no session that can silently expire.
 */
export function webSpeechAvailable() {
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) && !(window as any).take1Native;
}

export function listenOnce(timeoutMs = 6000): { promise: Promise<string>; stop: () => void } {
  const R = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const r = new R();
  r.continuous = false;
  r.interimResults = false;
  r.lang = 'en-US';
  r.maxAlternatives = 3;
  let done = false;
  const promise = new Promise<string>((resolve) => {
    const finish = (t: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        r.stop();
      } catch {
        /* ignore */
      }
      resolve(t);
    };
    const timer = setTimeout(() => finish(''), timeoutMs);
    r.onresult = (e: any) => {
      const alts = e.results[0];
      // prefer an alternative that looks like a command word
      let best = alts[0]?.transcript ?? '';
      for (let i = 0; i < alts.length; i++) if (/\b(wrap|cut|hold|action|redact|zoom|wide|undo)\b/i.test(alts[i].transcript)) {
        best = alts[i].transcript;
        break;
      }
      finish(best);
    };
    r.onerror = () => finish('');
    r.onend = () => finish('');
    r.start();
  });
  return { promise, stop: () => r.stop() };
}
