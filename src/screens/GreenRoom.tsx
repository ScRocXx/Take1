import { useEffect, useState } from 'react';
import { director } from '../engine/director';
import { native } from '../lib/native';
import { store, useStore } from '../lib/store';
import { INTENT_LABEL, type Intent } from '../voice/intent';
import { Bars, Button, Glyph, Icon, Keys, holdToTalk } from '../ui/components';

const TRY: { key: Intent; examples: string }[] = [
  { key: 'action', examples: '“action” · “we’re live”' },
  { key: 'cut', examples: '“cut” · “redo that line”' },
  { key: 'hold', examples: '“hold” · “speed this up”' },
  { key: 'scratch', examples: '“never mind” · “undo”' },
  { key: 'wrap', examples: '“that’s a wrap” · “we’re done”' },
];

export const support = () => ({
  encoder: 'VideoEncoder' in window,
  capture: !!navigator.mediaDevices?.getDisplayMedia,
  worker: 'Worker' in window,
});

export function GreenRoom() {
  const micOn = useStore((s) => s.micOn);
  const devices = useStore((s) => s.micDevices);
  const device = useStore((s) => s.micDevice);
  const engine = useStore((s) => s.engine);
  const tried = useStore((s) => s.tried);
  const listen = useStore((s) => s.listen);
  const accel = useStore((s) => s.talkKey);
  const last = useStore((s) => s.lastAction);
  const [busy, setBusy] = useState(false);
  const sup = support();
  const count = TRY.filter((t) => tried[t.key]).length;

  useEffect(() => {
    store.set({ trying: true });
    return () => store.set({ trying: false });
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      await director.micOn();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="greenroom">
      <section className="gr-hero">
        <p className="overline">Before the first take</p>
        <h1>
          Mess up <em>out loud.</em>
        </h1>
        <p className="deck">
          Take1 records your screen and lets you direct it by voice. Fluff a line, hold <Keys accel={accel} />, say “cut” and let go: it rewinds to the
          start of your sentence, replays the last five seconds, and punches you back in. The video is finished when you say “that’s a wrap.”
        </p>
        <ul className="facts">
          <li>
            <strong>Push to talk.</strong> Commands are only heard while you hold the keys. The rest of the time your voice is just narration on the tape.
          </li>
          <li>
            <strong>Say it your way.</strong> “Redo that line” and “we’re done” work as well as the film words.
          </li>
          <li>
            <strong>On your device.</strong> Speech is recognised locally. Nothing is uploaded.
          </li>
        </ul>
        {!(sup.encoder && sup.capture) && <p className="gate">Take1 needs the desktop app, or Chrome / Edge on a computer.</p>}
      </section>

      <section className="gr-steps">
        <article className={`step-card ${micOn ? 'done' : 'current'}`}>
          <header>
            <span className="step-n">{micOn ? Icon.check : '1'}</span>
            <h2>Microphone</h2>
          </header>
          {micOn ? (
            <>
              <div className="mic-test">
                <Bars count={28} />
              </div>
              <div className="row">
                <select value={device ?? ''} onChange={(e) => director.micOn(e.target.value)}>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <span className="engine">
                  {engine.status === 'ready' ? (
                    <>
                      <i className="ok" /> Voice engine ready
                    </>
                  ) : engine.status === 'loading' ? (
                    <>
                      <span className="engine-bar">
                        <i style={{ transform: `scaleX(${engine.progress})` }} />
                      </span>
                      Downloading voice engine · {Math.round(engine.progress * 100)}% · first run only
                    </>
                  ) : engine.status === 'error' ? (
                    <>
                      <i className="warn" /> Local engine unavailable{native ? '' : ', using the browser’s'}
                    </>
                  ) : (
                    'Preparing…'
                  )}
                </span>
              </div>
            </>
          ) : (
            <div className="row">
              <p className="muted">Speak normally. The bars should move.</p>
              <Button kind="primary" icon={Icon.mic} onClick={start} disabled={busy}>
                {busy ? 'Waiting for permission…' : 'Turn on microphone'}
              </Button>
            </div>
          )}
        </article>

        <article className={`step-card ${!micOn ? 'dim' : count >= 3 ? 'done' : 'current'}`}>
          <header>
            <span className="step-n">{count >= 3 ? Icon.check : '2'}</span>
            <h2>Try a command</h2>
            <span className="count">{count}/5</span>
          </header>
          <p className="muted">
            Hold <Keys accel={accel} /> {native ? 'in any app' : 'in this window'} (or hold the button), say one of these, then let go. Nothing is
            recorded yet.
          </p>
          <div className="try-grid">
            {TRY.map((t) => (
              <div key={t.key} className={`try ${tried[t.key] ? 'hit' : ''}`}>
                <span className="try-glyph" key={last?.kind === t.key ? last.id : 'still'}>
                  <Glyph kind={t.key} size={30} />
                </span>
                <strong>{INTENT_LABEL[t.key]}</strong>
                <span>{t.examples}</span>
              </div>
            ))}
          </div>
          <div className="row">
            <button className="btn btn-ink" {...holdToTalk} disabled={!micOn}>
              {Icon.voice}
              {listen.state === 'listening' ? 'Listening… release to send' : 'Hold to talk'}
            </button>
            {listen.heard && listen.state !== 'listening' && (
              <span className="heard">
                Heard <q>{listen.heard}</q>
                {listen.state === 'done' && listen.intent ? <> → {INTENT_LABEL[listen.intent as Intent]}</> : ' → no match'}
              </span>
            )}
          </div>
        </article>

        <div className="gr-cta">
          <Button kind="primary" onClick={() => store.set({ screen: 'stage', log: [], lastAction: null, listen: { state: 'off', heard: '', intent: null, alternatives: [], id: 0 } })} disabled={!micOn}>
            Set the stage
          </Button>
        </div>
      </section>
    </main>
  );
}
