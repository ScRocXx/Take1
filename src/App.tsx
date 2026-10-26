import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { director, keyHandler } from './engine/director';
import { native } from './lib/native';
import { useStore, store, type Screen } from './lib/store';
import { Keys, Wordmark } from './ui/components';
import { Pill } from './ui/Pill';
import { GreenRoom } from './screens/GreenRoom';
import { Stage } from './screens/Stage';
import { Console } from './screens/Console';
import { Dailies } from './screens/Dailies';
import { Wrap } from './screens/Wrap';

const STEPS: { key: Screen; label: string }[] = [
  { key: 'greenroom', label: 'Green room' },
  { key: 'stage', label: 'Stage' },
  { key: 'console', label: 'Console' },
  { key: 'dailies', label: 'Dailies' },
  { key: 'wrap', label: 'Wrap' },
];

export function App() {
  const screen = useStore((s) => s.screen);
  const pillOpen = useStore((s) => s.pillOpen);
  const toast = useStore((s) => s.toast);
  const phase = useStore((s) => s.phase);
  const accel = useStore((s) => s.shortcuts.command);
  const hasScreen = useStore((s) => s.hasScreen);
  const micOn = useStore((s) => s.micOn);

  useEffect(() => {
    window.addEventListener('keydown', keyHandler);
    // desktop: the pill is the app's front door, so it's there from the start
    if (native) setTimeout(() => director.openPill(), 400);
    return () => window.removeEventListener('keydown', keyHandler);
  }, []);

  const idx = STEPS.findIndex((s) => s.key === screen);
  const recording = phase !== 'idle' && phase !== 'wrapped';
  const canGo = (k: Screen) => (k === 'greenroom' ? !recording : k === 'stage' ? micOn && !recording : k === 'console' ? hasScreen : false);

  return (
    <div className={`app scr-${screen}`}>
      <nav className="topnav">
        <Wordmark />
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i === idx ? 'now' : i < idx ? 'past' : ''}>
              <button disabled={i === idx || !canGo(s.key)} onClick={() => store.set({ screen: s.key })}>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="nav-right">
          <span className="nav-hint">
            Command <Keys accel={accel} />
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
      {toast && (
        <div className={`toast t-${toast.tone}`} key={toast.id}>
          {toast.text}
        </div>
      )}
      {pillOpen && director.pillRoot && createPortal(<Pill docked={!native && !(window as any).__pillFloat} />, director.pillRoot)}
    </div>
  );
}
