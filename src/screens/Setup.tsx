import { useEffect, useState } from 'react';
import { recorder } from '../engine/recorder';
import { stt } from '../voice/stt';
import { native, type NativeSource } from '../lib/native';
import { phone } from '../lib/device';
import { setFlag, store, toast, useStore, type Rect } from '../lib/store';
import { INTENT_LABEL, type Intent } from '../voice/intent';
import { Bars, Button, Glyph, Icon, Keys, LivePreview, holdToTalk, useDrawBox, Overlay } from '../ui/components';

const TRY: { key: Intent; examples: string }[] = [
  { key: 'action', examples: '“start recording”' },
  { key: 'cut', examples: '“cut” · “oops, again”' },
  { key: 'pause', examples: '“pause” · “hang on”' },
  { key: 'play', examples: '“play” · “continue”' },
  { key: 'wrap', examples: '“stop recording”' },
];

export const support = () => ({
  encoder: 'VideoEncoder' in window,
  capture: !!navigator.mediaDevices?.getDisplayMedia,
});

/**
 * The landing page: what Take1 does, and a place to practise push-to-talk before
 * anything is recorded. Continue goes to Setup.
 */
export function Welcome() {
  if (phone) return <PhoneWelcome />;
  return <ComputerWelcome />;
}

function ComputerWelcome() {
  const accel = useStore((s) => s.talkKey);
  const sup = support();
  const go = () => {
    setFlag('take1.onboarded');
    store.set({ onboarded: true, practice: false, screen: 'setup', listen: { state: 'off', heard: '', intent: null, alternatives: [], id: 0 }, lastAction: null });
  };
  return (
    <main className="setup welcome">
      <section className="setup-grid">
        <div className="wl-hero">
          <p className="overline">Take1 · voice-directed screen recorder</p>
          <h1>
            Mess up <em>out loud.</em>
          </h1>
          <p className="deck">
            Take1 records your screen and lets you direct it by voice. Fluff a line, hold <Keys accel={accel} />, say “cut” and let go: it rewinds to the start of
            your sentence, replays the last five seconds, and puts you back in. The video is finished when you say “that’s a wrap.”
          </p>
          <ul className="facts">
            <li>
              <strong>Push to talk.</strong> Commands are only heard while you hold the keys. The rest of the time your voice is just narration in the video.
            </li>
            <li>
              <strong>Say it your way.</strong> “Redo that line”, “hang on” and “we’re done” work as well as “cut”, “pause” and “stop recording”.
            </li>
            <li>
              <strong>On your device.</strong> Speech is recognised locally. Nothing you say is uploaded.
            </li>
            <li>
              <strong>Finished when you stop.</strong> Cuts, pauses and sped-up waits are already edited in. Add captions and chapters, then send it to a folder,
              YouTube or Drive.
            </li>
          </ul>
          {!(sup.encoder && sup.capture) && <p className="gate">Take1 needs the desktop app, or Chrome / Edge on a computer.</p>}
          <div className="wl-cta">
            <Button kind="primary" onClick={go}>
              Continue
            </Button>
            <span className="muted small">Next: choose the window to record</span>
          </div>
        </div>
        <aside className="side">
          <MicCard />
          <PracticeCard onDone={go} />
        </aside>
      </section>
    </main>
  );
}

const DEMO_URL = 'https://youtu.be/eM0dT7hlP1M';
const SITE_URL = 'https://take1-coral.vercel.app/';

/**
 * Phones: phone browsers can't record a computer screen, so this page explains Take1,
 * hands the link over to a computer, and lets you try the voice commands here.
 */
function PhoneWelcome() {
  return (
    <main className="setup welcome phone-welcome">
      <section className="pw-hero">
        <p className="overline">Take1 · voice-directed screen recorder</p>
        <h1>
          Mess up <em>out loud.</em>
        </h1>
        <p className="deck">
          Take1 records your computer screen and lets you direct it by voice. Fluff a line, say “cut”: it rewinds to the start of your sentence, replays the
          last five seconds and puts you back in. The video is finished when you say “that’s a wrap.”
        </p>
      </section>
      <HandoffCard />
      <section className="pw-try">
        <h2>Try it here</h2>
        <p className="muted">Turn on the mic, hold the button and say a command to see what Take1 understands.</p>
        <MicCard phone />
        <PracticeCard phone onDone={() => {}} />
      </section>
      <section className="pw-facts">
        <ul className="facts">
          <li>
            <strong>Push to talk.</strong> Commands are only heard while you hold the keys. The rest of the time your voice is just narration in the video.
          </li>
          <li>
            <strong>Say it your way.</strong> “Redo that line”, “hang on” and “we’re done” work as well as “cut”, “pause” and “stop recording”.
          </li>
          <li>
            <strong>On your device.</strong> Speech is recognised locally. Nothing you say is uploaded.
          </li>
          <li>
            <strong>Finished when you stop.</strong> Cuts, pauses and sped-up waits are already edited in. Add captions and chapters, then send it to a folder,
            YouTube or Drive.
          </li>
        </ul>
      </section>
    </main>
  );
}

/** Recording happens on a computer: send this page there. */
function HandoffCard() {
  const url = SITE_URL;
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === 'function';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast(`Copy this link: ${url}`, 'muted');
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Take1', text: 'Open Take1 on my computer', url });
    } catch {
      /* closed the share sheet */
    }
  };
  return (
    <section className="card handoff">
      <h3>Record on your computer</h3>
      <p>Phones can’t record a computer screen, so recording happens on a computer, in Chrome or Edge. Send yourself the link:</p>
      <a className="handoff-url" href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
      <div className="handoff-btns">
        {canShare && (
          <Button kind="primary" onClick={share}>
            Send link
          </Button>
        )}
        <Button kind={canShare ? 'ghost' : 'primary'} onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <a className="handoff-demo" href={DEMO_URL} target="_blank" rel="noreferrer">
        {Icon.play} Watch the demo video
      </a>
    </section>
  );
}

/** Microphone, the window to record, camera and optional zoom spots. */
export function Setup() {
  const micOn = useStore((s) => s.micOn);
  const hasScreen = useStore((s) => s.hasScreen);
  const pillAuto = useStore((s) => s.settings.pill);
  const picking = useStore((s) => s.pickingSource);
  const sup = support();

  const ready = micOn && hasScreen;
  const goRecord = async () => {
    setFlag('take1.onboarded');
    store.set({ onboarded: true, practice: false, log: [], lastAction: null, listen: { state: 'off', heard: '', intent: null, alternatives: [], id: 0 } });
    recorder.zoomTo(null, false);
    if (store.get().settings.pill || native) await recorder.openPill();
    store.set({ screen: 'record', phase: 'idle' });
    if (native) native.hideMain();
  };

  return (
    <main className="setup">
      <header className="setup-head">
        <div>
          <p className="overline">Setup</p>
          <h1>Get ready to record</h1>
        </div>
        {!(sup.encoder && sup.capture) && <p className="gate">Take1 needs the desktop app, or Chrome / Edge on a computer.</p>}
      </header>

      <section className="setup-grid">
        <div className="setup-main">
          <WindowCard />
        </div>
        <aside className="side">
          <MicCard />
          <div className={`card card-fathom ready-card ${ready ? 'on' : ''}`}>
            <h3>{ready ? 'Ready' : 'Before you start'}</h3>
            <ul className="checklist">
              <li className={micOn ? 'ok' : ''}>{micOn ? Icon.check : <i />}Microphone on</li>
              <li className={hasScreen ? 'ok' : ''}>{hasScreen ? Icon.check : <i />}Window chosen</li>
            </ul>
            <Button kind="primary" disabled={!ready} onClick={goRecord}>
              {native ? 'Go to recording' : 'Continue to Record'}
            </Button>
            <p className="small">{native ? 'Take1 steps aside; the floating controls stay on the right of your screen and are never recorded.' : (pillAuto ? 'A small floating control window opens so you can direct from any window.' : 'Open the floating controls from Record whenever you need them.')}</p>
          </div>
        </aside>
      </section>
      {picking && <SourcePicker />}
    </main>
  );
}

function MicCard({ phone: onPhone = false }: { phone?: boolean }) {
  const micOn = useStore((s) => s.micOn);
  const devices = useStore((s) => s.micDevices);
  const device = useStore((s) => s.micDevice);
  const engine = useStore((s) => s.engine);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await recorder.micOn();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`card mic-card ${micOn ? 'done' : 'current'}`}>
      <header className="card-head">
        <h3>Microphone</h3>
        {micOn && (
          <button className="link-btn" onClick={() => recorder.micOff()}>
            Turn off
          </button>
        )}
      </header>
      {micOn ? (
        <>
          <div className="mic-test">
            <Bars count={28} />
          </div>
          <select value={device ?? ''} onChange={(e) => recorder.micOn(e.target.value)} aria-label="Microphone">
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <span className="engine">
            {engine.status === 'ready' ? (
              <>
                <i className="ok" /> Voice commands ready
              </>
            ) : engine.status === 'loading' ? (
              <>
                <span className="engine-bar">
                  <i style={{ transform: `scaleX(${engine.progress})` }} />
                </span>
                Downloading speech model · {Math.round(engine.progress * 100)}% · first time only
              </>
            ) : engine.status === 'error' ? (
              <>
                <i className="warn" /> {engine.detail ?? 'The speech model couldn’t load.'} Buttons and shortcuts still work.{' '}
                <button className="link-btn" onClick={() => stt.retry()}>
                  Try again
                </button>
              </>
            ) : (
              'Preparing…'
            )}
          </span>
        </>
      ) : (
        <>
          <p className="muted small">
            {onPhone ? 'Turn it on to try the voice commands. The speech model (about 60 MB) downloads once, so Wi-Fi is best.' : 'Speak normally once it’s on: the bars should move.'}
          </p>
          <Button kind="primary" icon={Icon.mic} onClick={start} disabled={busy}>
            {busy ? 'Waiting for permission…' : 'Turn on microphone'}
          </Button>
        </>
      )}
    </div>
  );
}

function PracticeCard({ onDone, phone: onPhone = false }: { onDone: () => void; phone?: boolean }) {
  const micOn = useStore((s) => s.micOn);
  const tried = useStore((s) => s.tried);
  const listen = useStore((s) => s.listen);
  const last = useStore((s) => s.lastAction);
  const count = TRY.filter((t) => tried[t.key]).length;
  useEffect(() => {
    store.set({ trying: true });
    return () => store.set({ trying: false });
  }, []);
  return (
    <div className={`card practice ${!micOn ? 'dim' : ''}`}>
      <header className="practice-head">
        <h3>{onPhone ? 'Try the commands' : 'Practise push-to-talk'}</h3>
        <span className="count">{count}/5</span>
      </header>
      {!onPhone && <KeyMeter />}
      <div className="try-grid">
        {TRY.map((t) => (
          <div key={t.key} className={`try ${tried[t.key] ? 'hit' : ''}`}>
            <span className="try-glyph" key={last?.kind === t.key ? last.id : 'still'}>
              <Glyph kind={t.key} size={26} />
            </span>
            <strong>{INTENT_LABEL[t.key]}</strong>
            <span>{t.examples}</span>
          </div>
        ))}
      </div>
      <div className="row">
        <button className={`btn btn-ink ${onPhone ? `phone-talk ls-${listen.state}` : ''}`} {...holdToTalk} disabled={!micOn}>
          {listen.state === 'listening' ? <Bars count={5} /> : Icon.voice}
          {listen.state === 'listening' ? (onPhone ? 'Listening… let go to send' : 'Listening… release to send') : onPhone ? 'Hold, say a command, let go' : 'Hold to talk'}
        </button>
        {listen.heard && listen.state !== 'listening' && (
          <span className="heard">
            Heard <q>{listen.heard}</q>
            {listen.intent ? <> → {INTENT_LABEL[listen.intent as Intent]}</> : listen.state === 'thinking' ? ' …' : ' → not a command'}
          </span>
        )}
      </div>
      {onPhone ? (
        <p className="muted small">Nothing is recorded here. On a computer you hold Ctrl + Shift instead of this button.</p>
      ) : (
        <p className="muted small">
          {native ? 'The keys work in any app.' : 'In the browser, the keys work while this window is focused.'} Nothing is recorded here.{' '}
          <button className="link-btn" onClick={onDone}>
            {count >= 3 ? 'Done, continue' : 'Skip and continue'}
          </button>
        </p>
      )}
    </div>
  );
}

/** The talk keys light up as you press them, so you can see they're arriving. */
function KeyMeter() {
  const accel = useStore((s) => s.talkKey);
  const keys = useStore((s) => s.keysDown);
  const listen = useStore((s) => s.listen.state);
  const parts = accel === 'RightCtrl' ? ['Right Ctrl'] : accel.split('+');
  const isDown = (p: string) => (p === 'Ctrl' || p === 'Right Ctrl' ? keys.ctrl : p === 'Shift' ? keys.shift : p === 'Alt' ? keys.alt : p === 'Win' ? keys.meta : false);
  const msg =
    listen === 'listening' ? 'Listening. Say a command, then let go.' : listen === 'thinking' ? 'Working out what you said…' : parts.some(isDown) ? 'Keep holding both…' : 'Hold these keys together, speak, then let go.';
  return (
    <div className={`key-meter ${listen === 'listening' ? 'live' : ''}`}>
      <div className="km-keys">
        {parts.map((p, i) => (
          <span key={p} className="km-wrap">
            {i > 0 && <span className="km-plus">+</span>}
            <kbd className={isDown(p) || listen === 'listening' ? 'down' : ''}>{p}</kbd>
          </span>
        ))}
      </div>
      <p>{msg}</p>
    </div>
  );
}

function WindowCard() {
  const hasScreen = useStore((s) => s.hasScreen);
  const surface = useStore((s) => s.surface);
  const sourceName = useStore((s) => s.sourceName);
  const hasCamera = useStore((s) => s.hasCamera);
  const marks = useStore((s) => s.marks);
  const active = useStore((s) => s.activeMark);
  const [editing, setEditing] = useState<{ url: string; aspect: number } | null>(null);
  const [spots, setSpots] = useState(marks.length > 0);

  const share = async () => {
    try {
      await recorder.shareScreen();
    } catch {
      /* cancelled */
    }
  };

  return (
    <div className="window-card">
      <div className="monitor">
        {hasScreen ? (
          <LivePreview />
        ) : (
          <button className="monitor-empty" onClick={share}>
            <span className="me-icon">{Icon.screen}</span>
            <strong>Choose the window you’ll show</strong>
            <span>One window keeps notifications and other apps out of the video.</span>
          </button>
        )}
        {editing && <SpotEditor image={editing} onClose={() => setEditing(null)} />}
      </div>

      <div className="src-bar">
        <div className="src-item">
          <span className="src-ico">{Icon.screen}</span>
          <div className="src-text">
            <strong>Window</strong>
            <small title={sourceName ?? undefined}>{hasScreen ? sourceName || 'Shared' : 'Not chosen'}</small>
          </div>
          {hasScreen && (
            <Button kind="quiet" onClick={() => recorder.removeScreen()}>
              Remove
            </Button>
          )}
          <Button kind="ghost" onClick={share}>
            {hasScreen ? 'Change' : 'Choose'}
          </Button>
        </div>
        <div className="src-item">
          <span className="src-ico">{Icon.camera}</span>
          <div className="src-text">
            <strong>Camera bubble</strong>
            <small>{hasCamera ? 'Bottom-right corner' : 'Off'}</small>
          </div>
          <Button kind="ghost" onClick={() => recorder.toggleCamera()}>
            {hasCamera ? 'Turn off' : 'Turn on'}
          </Button>
        </div>
      </div>

      {surface === 'monitor' && !native && (
        <div className="note note-warn">
          You’re sharing a whole screen, so the floating controls will be in the video. Choose a single window, or use the desktop app, which hides them from
          recordings.
          <Button kind="quiet" onClick={share}>
            Choose a window
          </Button>
        </div>
      )}

      <details className="spots" open={spots} onToggle={(e) => setSpots((e.target as HTMLDetailsElement).open)}>
        <summary>
          <span>
            <strong>Zoom spots</strong> <small>optional</small>
          </span>
          <small>You can also say “zoom in” while recording and draw the area then.</small>
        </summary>
        <div className="marks">
          {marks.map((m) => (
            <span key={m.id} className={`mark ${active === m.id ? 'active' : ''}`}>
              <button onClick={() => recorder.zoomTo(active === m.id ? null : m, false)}>{m.name}</button>
              <button className="x" onClick={() => recorder.removeMark(m.id)} aria-label={`Remove ${m.name}`}>
                {Icon.x}
              </button>
            </span>
          ))}
          <Button
            kind="ghost"
            icon={Icon.plus}
            disabled={!hasScreen}
            onClick={async () => {
              recorder.zoomTo(null, false);
              setEditing(await recorder.comp.freeze('source'));
            }}
          >
            Add a zoom spot
          </Button>
        </div>
        {marks[0] && <p className="muted small">While recording, say “zoom {marks[0].name.toLowerCase()}”.</p>}
      </details>
    </div>
  );
}

function SourcePicker() {
  const [list, setList] = useState<NativeSource[] | null>(null);
  const [tab, setTab] = useState<'window' | 'screen'>('window');
  useEffect(() => {
    native?.getSources().then(setList);
  }, []);
  const close = () => store.set({ pickingSource: false });
  const shown = (list ?? []).filter((s) => s.kind === tab);
  return (
    <Overlay onClose={close}>
      <div className="modal-card picker" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>What are you showing?</h2>
          <div className="seg">
            <button className={tab === 'window' ? 'on' : ''} onClick={() => setTab('window')}>
              Windows
            </button>
            <button className={tab === 'screen' ? 'on' : ''} onClick={() => setTab('screen')}>
              Screens
            </button>
          </div>
        </header>
        <div className="picker-grid">
          {list === null && <p className="muted">Looking for windows…</p>}
          {shown.map((s) => (
            <button key={s.id} className="src-tile" onClick={() => recorder.useSource(s.id, s.name)}>
              <img src={s.thumbnail} alt="" />
              <span>
                {s.icon && <img className="ico" src={s.icon} alt="" />}
                {s.name}
              </span>
            </button>
          ))}
        </div>
        <footer>
          <Button kind="quiet" onClick={close}>
            Cancel
          </Button>
        </footer>
      </div>
    </Overlay>
  );
}

function SpotEditor({ image, onClose }: { image: { url: string; aspect: number }; onClose: () => void }) {
  const { rect, handlers } = useDrawBox();
  const [name, setName] = useState('');
  const save = () => {
    if (!rect) return;
    recorder.addMark(name || 'Spot', rect as Rect);
    onClose();
  };
  return (
    <div className="mark-editor">
      <div className="draw" style={{ aspectRatio: String(image.aspect) }} {...handlers}>
        <img src={image.url} alt="" draggable={false} />
        {rect && <div className="draw-rect" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />}
        {!rect && <span className="draw-hint">Drag a box around the area to zoom into</span>}
      </div>
      <div className="draw-bar">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it, e.g. terminal" autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} />
        <Button kind="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button kind="primary" disabled={!rect || rect.w < 0.02} onClick={save}>
          Save spot
        </Button>
      </div>
    </div>
  );
}
