import { Fragment, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { recorder, keyHandler, keyUpHandler, releaseKeys } from './engine/recorder';
import { native } from './lib/native';
import { library } from './lib/library';
import { useStore, store, type Screen } from './lib/store';
import { Keys, Wordmark } from './ui/components';
import { FloatingControls } from './ui/FloatingControls';
import { Help } from './ui/Help';
import { Setup, Welcome } from './screens/Setup';
import { Record } from './screens/Record';
import { Review } from './screens/Review';
import { Export } from './screens/Export';
import { Library } from './screens/Library';

const STEPS: { key: Screen; label: string }[] = [
  { key: 'setup', label: 'Setup' },
  { key: 'record', label: 'Record' },
  { key: 'review', label: 'Review' },
  { key: 'export', label: 'Export' },
];

export function App() {
  const screen = useStore((s) => s.screen);
  const floating = useStore((s) => s.pillOpen);
  const toast = useStore((s) => s.toast);
  const phase = useStore((s) => s.phase);
  const accel = useStore((s) => s.talkKey);
  const hasScreen = useStore((s) => s.hasScreen);
  const micOn = useStore((s) => s.micOn);
  const duration = useStore((s) => s.duration);
  const unseen = useStore((s) => s.library.filter((t) => !t.seen).length);
  const helpOpen = useStore((s) => s.helpOpen);

  useEffect(() => {
    window.addEventListener('keydown', keyHandler);
    window.addEventListener('keyup', keyUpHandler);
    window.addEventListener('blur', releaseKeys);
    library.refresh();
    // desktop: the floating controls are there from the start, like Flow's
    if (native) setTimeout(() => recorder.openPill(), 400);
    return () => {
      window.removeEventListener('keydown', keyHandler);
      window.removeEventListener('keyup', keyUpHandler);
      window.removeEventListener('blur', releaseKeys);
    };
  }, []);

  const idx = STEPS.findIndex((s) => s.key === screen);
  const recording = phase !== 'idle' && phase !== 'wrapped';
  const canGo = (k: Screen) =>
    recording ? false : k === 'setup' ? true : k === 'record' ? micOn && hasScreen && phase === 'idle' : phase === 'wrapped' && duration > 0;

  return (
    <div className={`app scr-${screen}`}>
      <nav className="topnav">
        <button className="wm-btn" onClick={() => !recording && store.set({ screen: 'welcome' })} aria-label="Take1 home">
          <Wordmark />
        </button>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 && (
                <li className={`step-arrow ${i === idx + 1 && canGo(s.key) ? 'next' : i <= idx ? 'done' : ''}`} aria-hidden>
                  <svg viewBox="0 0 40 12" width="40" height="12">
                    <path className="sa-line" d="M2 6h32" />
                    <path className="sa-head" d="M30 2l5 4-5 4" />
                  </svg>
                </li>
              )}
              <li className={i === idx ? 'now' : idx >= 0 && i < idx ? 'past' : ''}>
                <button disabled={i === idx || !canGo(s.key)} onClick={() => store.set({ screen: s.key })}>
                  <span className="step-i">{i + 1}</span>
                  {s.label}
                </button>
              </li>
            </Fragment>
          ))}
        </ol>
        <div className="nav-right">
          <button
            className={`nav-link ${screen === 'library' ? 'on' : ''}`}
            disabled={recording}
            onClick={() => store.set({ screen: 'library' })}
            title={unseen ? `${unseen} new recording${unseen === 1 ? '' : 's'}` : undefined}
          >
            Library{unseen ? <span className="count-pill">{unseen} new</span> : null}
          </button>
          <button className="nav-link" onClick={() => store.set({ helpOpen: true })}>
            How it works
          </button>
          <span className="nav-hint">
            Hold <Keys accel={accel} /> to talk
          </span>
          {recording && (
            <span className={`status live ph-${phase}`}>
              <span className={`dot dot-${phase}`} />
              {phase === 'paused' ? 'Paused' : 'Recording'}
            </span>
          )}
        </div>
      </nav>
      {screen === 'welcome' && <Welcome />}
      {screen === 'setup' && <Setup />}
      {screen === 'record' && <Record />}
      {screen === 'review' && <Review />}
      {screen === 'export' && <Export />}
      {screen === 'library' && <Library />}
      {helpOpen && <Help />}
      {toast && (
        <div className={`toast t-${toast.tone}`} key={toast.id}>
          {toast.text}
        </div>
      )}
      {floating && recorder.pillRoot && createPortal(<FloatingControls layout={(window as any).__fcLayout ?? (native ? 'rail' : 'remote')} />, recorder.pillRoot)}
    </div>
  );
}
