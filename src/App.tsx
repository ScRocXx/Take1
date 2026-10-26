import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { director } from './engine/director';
import { store, useStore, type Screen } from './lib/store';
import { Wordmark } from './ui/components';
import { Hud } from './ui/Hud';
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

const KEYS: Record<string, string> = { a: 'action', c: 'cut', h: 'hold', z: 'scratch that', w: 'that’s a wrap', r: 'redact that' };

export function App() {
  const screen = useStore((s) => s.screen);
  const hudOpen = useStore((s) => s.hudOpen);
  const toast = useStore((s) => s.toast);
  const phase = useStore((s) => s.phase);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !KEYS[e.key.toLowerCase()]) return;
      if (store.get().screen !== 'console') return;
      e.preventDefault();
      director.say(KEYS[e.key.toLowerCase()]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const idx = STEPS.findIndex((s) => s.key === screen);
  const recording = phase !== 'idle' && phase !== 'wrapped';

  return (
    <div className={`app scr-${screen}`}>
      <nav className="topnav">
        <Wordmark />
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i === idx ? 'now' : i < idx ? 'past' : ''}>
              <span>{i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>
        <span className={`rec-pill ${recording ? 'live' : ''}`}>{recording ? 'REC' : 'STANDBY'}</span>
      </nav>
      {screen === 'greenroom' && <GreenRoom />}
      {screen === 'stage' && <Stage />}
      {screen === 'console' && <Console />}
      {screen === 'dailies' && <Dailies />}
      {screen === 'wrap' && <Wrap />}
      {toast && (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.text}
        </div>
      )}
      {hudOpen && director.hudRoot && createPortal(<Hud />, director.hudRoot)}
    </div>
  );
}
