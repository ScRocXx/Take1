import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { director, keyHandler, keyUpHandler, releaseKeys } from './engine/director';
import { native } from './lib/native';
import { library } from './lib/library';
import { useStore, store, type Screen } from './lib/store';
import { Keys, Wordmark } from './ui/components';
import { Pill } from './ui/Pill';
import { Help } from './ui/Help';
import { GreenRoom } from './screens/GreenRoom';
import { Stage } from './screens/Stage';
import { Console } from './screens/Console';
import { Dailies } from './screens/Dailies';
import { Wrap } from './screens/Wrap';
import { Library } from './screens/Library';

const STEPS: { key: Screen; label: string }[] = [
  { key: 'greenroom', label: 'Setup' },
  { key: 'stage', label: 'Window' },
  { key: 'console', label: 'Record' },
  { key: 'dailies', label: 'Review' },
  { key: 'wrap', label: 'Export' },
];

export function App() {
  const screen = useStore((s) => s.screen);
  const pillOpen = useStore((s) => s.pillOpen);
  const toast = useStore((s) => s.toast);
  const phase = useStore((s) => s.phase);
  const accel = useStore((s) => s.talkKey);
  const hasScreen = useStore((s) => s.hasScreen);
  const micOn = useStore((s) => s.micOn);
  const duration = useStore((s) => s.duration);
  const takes = useStore((s) => s.library.length);
  const helpOpen = useStore((s) => s.helpOpen);

  useEffect(() => {
    window.addEventListener('keydown', keyHandler);
    window.addEventListener('keyup', keyUpHandler);
    window.addEventListener('blur', releaseKeys);
    library.refresh();
    // desktop: the pill is the app's front door, so it's there from the start
    if (native) setTimeout(() => director.openPill(), 400);
    return () => {
      window.removeEventListener('keydown', keyHandler);
      window.removeEventListener('keyup', keyUpHandler);
      window.removeEventListener('blur', releaseKeys);
    };
  }, []);

  const idx = STEPS.findIndex((s) => s.key === screen);
  const recording = phase !== 'idle' && phase !== 'wrapped';
  const canGo = (k: Screen) =>
    recording
      ? false
      : k === 'greenroom'
        ? true
        : k === 'stage'
          ? micOn
          : k === 'console'
            ? hasScreen && phase === 'idle'
            : k === 'dailies' || k === 'wrap'
              ? phase === 'wrapped' && duration > 0
              : false;

  return (
    <div className={`app scr-${screen}`}>
      <nav className="topnav">
        <button className="wm-btn" onClick={() => !recording && store.set({ screen: 'greenroom' })} aria-label="Take1 home">
          <Wordmark />
        </button>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i === idx ? 'now' : idx >= 0 && i < idx ? 'past' : ''}>
              <button disabled={i === idx || !canGo(s.key)} onClick={() => store.set({ screen: s.key })}>
                <span className="step-i">{i + 1}</span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="nav-right">
          <button className={`nav-link ${screen === 'library' ? 'on' : ''}`} disabled={recording} onClick={() => store.set({ screen: 'library' })}>
            Library{takes ? <span className="count-pill">{takes}</span> : null}
          </button>
          <button className="nav-link" onClick={() => store.set({ helpOpen: true })}>
            How it works
          </button>
          <span className="nav-hint">
            Hold <Keys accel={accel} /> to talk
          </span>
          <span className={`status ${recording ? 'live' : ''}`}>
            <span className={`dot dot-${phase}`} />
            {recording ? 'Recording' : 'Standby'}
          </span>
        </div>
      </nav>
      {screen === 'greenroom' && <GreenRoom />}
      {screen === 'stage' && <Stage />}
      {screen === 'console' && <Console />}
      {screen === 'dailies' && <Dailies />}
      {screen === 'wrap' && <Wrap />}
      {screen === 'library' && <Library />}
      {helpOpen && <Help />}
      {toast && (
        <div className={`toast t-${toast.tone}`} key={toast.id}>
          {toast.text}
        </div>
      )}
      {pillOpen && director.pillRoot && createPortal(<Pill docked={!native && !(window as any).__pillFloat} />, director.pillRoot)}
    </div>
  );
}
