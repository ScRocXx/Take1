import { useState } from 'react';
import { director } from '../engine/director';
import { store, useStore } from '../lib/store';
import { Button, Icon, MicMeter, Ticker, Wordmark } from '../ui/components';

const DRILLS: { key: string; say: string; note: string }[] = [
  { key: 'action', say: 'Action', note: 'Starts the tape' },
  { key: 'cut', say: 'Cut', note: 'Rewinds to the start of your sentence' },
  { key: 'hold', say: 'Hold', note: 'Squeezes a slow build 8×' },
  { key: 'scratch', say: 'Scratch that', note: 'Undo, or cancel a Cut' },
  { key: 'wrap', say: 'That’s a wrap', note: 'Finishes the video' },
];

export const support = () => ({
  encoder: 'VideoEncoder' in window,
  speech: !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
  pip: 'documentPictureInPicture' in window,
  capture: !!navigator.mediaDevices?.getDisplayMedia,
});

export function GreenRoom() {
  const micOn = useStore((s) => s.micOn);
  const level = useStore((s) => s.micLevel);
  const listening = useStore((s) => s.listening);
  const ticker = useStore((s) => s.ticker);
  const interim = useStore((s) => s.interim);
  const done = useStore((s) => s.rehearsal);
  const last = useStore((s) => s.lastCommand);
  const [busy, setBusy] = useState(false);
  const sup = support();
  const count = DRILLS.filter((d) => done[d.key]).length;

  const start = async () => {
    setBusy(true);
    try {
      await director.micOn();
      store.set({ rehearsing: true });
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    store.set({ rehearsing: false, screen: 'stage', ticker: [] });
  };

  return (
    <main className="greenroom">
      <section className="gr-hero">
        <p className="eyebrow">The green room</p>
        <h1>
          Mess up <em>out loud.</em>
        </h1>
        <p className="lede">
          <Wordmark size="sm" /> is a screen recorder you direct with your voice. Fluff a line, say <q>Cut</q>, and it rewinds to the start of
          your sentence, counts you back in and splices the retake. The video is finished when you say <q>That’s a wrap.</q>
        </p>
        <ul className="support">
          <li className={sup.encoder ? 'yes' : 'no'}>{sup.encoder ? Icon.check : Icon.x} Video encoding</li>
          <li className={sup.speech ? 'yes' : 'no'}>{sup.speech ? Icon.check : Icon.x} Speech recognition</li>
          <li className={sup.capture ? 'yes' : 'no'}>{sup.capture ? Icon.check : Icon.x} Screen capture</li>
          <li className={sup.pip ? 'yes' : 'warn'}>{sup.pip ? Icon.check : Icon.x} Floating console</li>
        </ul>
        {!(sup.encoder && sup.speech && sup.capture) && (
          <p className="gate">Take1 needs Chrome or Edge on a desktop. Open this page there to record.</p>
        )}
      </section>

      <section className="gr-panel">
        <div className="card mic-card">
          <header>
            <span className="step">1</span>
            <h2>Mic check</h2>
            <span className={`listen-pill lp-${micOn ? listening : 'off'}`}>
              {!micOn ? 'Mic off' : listening === 'on' ? 'Listening' : listening === 'unsupported' ? 'No speech engine' : listening === 'error' ? 'Speech blocked' : 'Starting…'}
            </span>
          </header>
          {micOn ? (
            <>
              <MicMeter level={level} bars={28} />
              <Ticker items={ticker} interim={interim} max={6} />
              <p className="fine">Headphones recommended: the pre-roll plays your last two seconds back to you before each punch-in.</p>
            </>
          ) : (
            <div className="mic-empty">
              <p>Take1 listens for a handful of film-set words. Everything else you say is your narration.</p>
              <Button kind="primary" onClick={start} disabled={busy || !sup.speech} icon={Icon.mic}>
                {busy ? 'Asking for the mic…' : 'Turn on the mic'}
              </Button>
            </div>
          )}
        </div>

        <div className={`card drills ${micOn ? '' : 'dim'}`}>
          <header>
            <span className="step">2</span>
            <h2>Rehearsal</h2>
            <span className="drill-count">{count}/5</span>
          </header>
          <p className="fine">Nothing is recorded. Say each one on its own, with a short pause before it.</p>
          <ol>
            {DRILLS.map((d) => (
              <li key={d.key} className={`${done[d.key] ? 'done' : ''} ${last === d.key ? 'pulse' : ''}`}>
                <span className="drill-check">{done[d.key] ? Icon.check : ''}</span>
                <q>{d.say}</q>
                <span className="drill-note">{d.note}</span>
              </li>
            ))}
          </ol>
          {count === 5 && <p className="fluent">You’re fluent. Let’s set the stage.</p>}
        </div>

        <div className="gr-cta">
          <Button kind={count >= 2 ? 'primary' : 'ghost'} onClick={next} disabled={!micOn}>
            Set the stage →
          </Button>
        </div>
      </section>
    </main>
  );
}
