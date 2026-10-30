import { useEffect, useState } from 'react';
import { recorder } from '../engine/recorder';
import { native } from '../lib/native';
import { store, useStore, DEFAULT_SHORTCUTS, TALK_KEYS } from '../lib/store';
import { clock } from '../lib/time';
import { CALL_SHEET } from '../voice/intent';
import { SettingsPanel } from './Settings';
import { Button, Glyph, Icon, Keys, LivePreview, MatchMeter, ReplayView, Timecode, Toggle, holdToTalk, phaseText, useDrawBox } from '../ui/components';

/** Actions that get a full-frame effect on the monitor (quiet ones like zoom or blur don't). */
const FX = new Set(['action', 'play', 'punch', 'pause', 'hold', 'scratch', 'wrap', 'chapter']);

export function Record() {
  const phase = useStore((s) => s.phase);
  const speed = useStore((s) => s.speed);
  const take = useStore((s) => s.take);
  const retakes = useStore((s) => s.outtakes.length);
  const last = useStore((s) => s.lastAction);
  const countdown = useStore((s) => s.countdown);
  const teleprompter = useStore((s) => s.teleprompter);
  const rewind = useStore((s) => s.rewind);
  const holdBadge = useStore((s) => s.holdBadge);
  const drawing = useStore((s) => s.drawing);
  const replaySeconds = useStore((s) => s.settings.replaySeconds);
  const match = useStore((s) => s.matchScore);
  const recordKey = useStore((s) => s.shortcuts.record);
  const talkKey = useStore((s) => s.talkKey);
  const [burst, setBurst] = useState<typeof last>(null);

  useEffect(() => {
    if (!last) return;
    setBurst(last);
    const t = setTimeout(() => setBurst(null), 1300);
    return () => clearTimeout(t);
  }, [last?.id]);

  return (
    <main className={`record ph-${phase}`}>
      <section className="record-main">
        <header className="slate-bar">
          <div className="sb-state">
            <span className={`dot dot-${phase}`} />
            {phaseText(phase, speed)}
          </div>
          <Timecode className="sb-tc" />
          <dl className="sb-meta">
            <div>
              <dt>Take</dt>
              <dd>{take}</dd>
            </div>
            <div>
              <dt>Lines redone</dt>
              <dd>{retakes}</dd>
            </div>
          </dl>
        </header>

        <div className={`monitor tally-${phase}`}>
          {phase === 'preroll' ? (
            <div className="preroll">
              <ReplayView className="preroll-replay" />
              <div className="preroll-side">
                <div className="preroll-count" key={countdown ?? 'r'}>
                  {countdown ?? <Glyph kind="cut" size={64} />}
                </div>
                <p className="preroll-title">{countdown ? 'Recording again in…' : `Replaying the last ${replaySeconds} seconds`}</p>
                {teleprompter && <p className="prompt">You said: “{teleprompter}”</p>}
                <LivePreview className="preroll-live" onion />
                <MatchMeter score={match} />
                <p className="muted small">“Play” to start now · “cut” to go back one more sentence · “undo” to keep what you had</p>
              </div>
            </div>
          ) : (
            <LivePreview />
          )}

          {phase === 'idle' && (
            <div className="overlay ov-idle">
              <p>
                Press <Keys accel={recordKey} /> or hold <Keys accel={talkKey} /> and say <em>“start recording”</em>
              </p>
            </div>
          )}
          {phase === 'paused' && !drawing && (
            <div className="overlay ov-paused">
              <Glyph kind="pause" size={72} />
              <span>
                Paused. Nothing is being recorded. Say <q>play</q> to carry on.
              </span>
            </div>
          )}
          {phase === 'rewinding' && rewind && (
            <div className="overlay ov-rewind">
              <Glyph kind="cut" size={120} />
              <span>Removing the last {(rewind.from - rewind.to).toFixed(1)} s</span>
            </div>
          )}
          {phase === 'hold' && (
            <div className="overlay ov-hold">
              <div className="speed-stream" aria-hidden>
                {Array.from({ length: 6 }, (_, i) => (
                  <Glyph key={i} kind="hold" size={40} />
                ))}
              </div>
              <span>Sped up · this part plays at {speed}×. Say “play” for normal speed.</span>
            </div>
          )}
          {burst && FX.has(burst.kind) && phase !== 'rewinding' && <div className={`fx fx-${burst.kind}`} key={`fx${burst.id}`} />}
          {burst && phase !== 'rewinding' && phase !== 'preroll' && phase !== 'paused' && !drawing && (
            <div className={`burst b-${burst.kind}`} key={burst.id}>
              <Glyph kind={burst.kind} size={56} />
              <span>{burst.label}</span>
            </div>
          )}
          {holdBadge && phase === 'rolling' && <div className="badge-note">{holdBadge}</div>}
          {drawing && <DrawPanel />}
        </div>

        <Dock />

        {!native && <SettingsPanel />}
      </section>

      <Side />
    </main>
  );
}

function Dock() {
  const phase = useStore((s) => s.phase);
  const speed = useStore((s) => s.speed);
  const defSpeed = useStore((s) => s.settings.speed);
  const micMuted = useStore((s) => s.micMuted);
  const listen = useStore((s) => s.listen.state);
  const talkKey = useStore((s) => s.talkKey);
  const floating = useStore((s) => s.pillOpen);
  const live = phase === 'rolling' || phase === 'hold';
  const rew = phase === 'rewinding' || phase === 'preroll';
  const paused = phase === 'paused';
  return (
    <div className="dock">
      <button className={`dock-btn ${micMuted ? 'off' : ''}`} onClick={() => recorder.toggleMic()} title={micMuted ? 'Unmute' : 'Mute'}>
        {micMuted ? Icon.micOff : Icon.mic}
        <span>{micMuted ? 'Muted' : 'Mic'}</span>
      </button>
      <button className={`dock-rec ${live || rew || paused ? 'on' : ''}`} onClick={() => recorder.record()}>
        {live || rew || paused ? Icon.stop : Icon.rec}
        <span>{phase === 'idle' ? 'Record' : 'Stop'}</span>
      </button>
      <button className={`dock-btn ${paused ? 'on-play' : ''}`} disabled={!live && !rew && !paused} onClick={() => recorder.pauseToggle()}>
        {paused ? Icon.resume : Icon.pause}
        <span>{paused ? 'Play' : 'Pause'}</span>
      </button>
      <button className="dock-btn" disabled={!live && !rew && !paused} onClick={() => recorder.run({ type: 'cut' })} title="Remove the sentence you just said">
        {Icon.cut}
        <span>Cut</span>
      </button>
      <button className={`dock-btn ${phase === 'hold' ? 'on' : ''}`} disabled={!live} onClick={() => recorder.holdToggle()} title="Waiting plays faster">
        {Icon.hold}
        <span>{phase === 'hold' ? `${speed}× · Normal` : `Speed ${defSpeed}×`}</span>
      </button>
      <span className="dock-sep" />
      <button className={`dock-voice ls-${listen}`} {...holdToTalk}>
        {Icon.voice}
        <span>{listen === 'listening' ? 'Listening… release to send' : 'Hold to talk'}</span>
        <Keys accel={talkKey} />
      </button>
      {!floating && (
        <Button kind="quiet" icon={Icon.pop} onClick={() => recorder.openPill()}>
          Floating controls
        </Button>
      )}
    </div>
  );
}

/** "Blur that" / "zoom in" while recording: recording is paused; drag the box here. */
function DrawPanel() {
  const d = useStore((s) => s.drawing)!;
  const { rect, handlers } = useDrawBox();
  const [keep, setKeep] = useState(false);
  const [name, setName] = useState(d.name ?? '');
  const redact = d.kind === 'redact';
  const done = () => recorder.finishDrawing(rect, { keep, name });
  return (
    <div className="draw-panel">
      <p className="dp-title">
        {redact ? 'Drag over what should be blurred' : 'Drag around the area to zoom into'}
        <small>Recording is paused. Nothing is being recorded.</small>
      </p>
      <div className="draw" style={{ aspectRatio: String(d.aspect) }} {...handlers}>
        <img src={d.image} alt="" draggable={false} />
        {rect && (
          <div className={`draw-rect ${redact ? 'redact' : ''}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}>
          </div>
        )}
      </div>
      <div className="draw-bar">
        {redact ? (
          <label className="keep">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            Keep blurring after I continue, until I say “unblur”
          </label>
        ) : (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this spot to reuse it (optional)" onKeyDown={(e) => e.key === 'Enter' && rect && done()} />
        )}
        <Button kind="quiet" onClick={() => recorder.finishDrawing(null)}>
          Skip
        </Button>
        <Button kind="primary" disabled={!rect || rect.w < 0.01} onClick={done}>
          {redact ? 'Blur this' : 'Zoom here'}
        </Button>
      </div>
    </div>
  );
}

function Side() {
  const talkKey = useStore((s) => s.talkKey);
  const marks = useStore((s) => s.marks);
  const lit = useStore((s) => s.lastAction?.kind);
  return (
    <aside className="side side-sticky">
      <div className="card card-fathom howto">
        <h3>How to direct</h3>
        <ol>
          <li>
            Press <strong>Record</strong> and talk through your demo.
          </li>
          <li>
            Fluffed a sentence? Hold <Keys accel={talkKey} dark />, say <q>cut</q>, let go. Listen to the 5-second replay, then say it again after 3, 2, 1.
          </li>
          <li>
            Need a moment? Say <q>pause</q>, then <q>play</q>. Waiting for something slow? <q>Speed up</q> (or <q>hold 3x</q>).
          </li>
          <li>
            Done? Press <strong>Stop</strong>, or say <q>stop recording</q>.
          </li>
        </ol>
        <button className="link-btn" onClick={() => store.set({ helpOpen: true })}>
          Full guide
        </button>
      </div>
      <Log />
      {!native && (
        <div className="note note-warn small">
          <span>
            <strong>Browser:</strong> the talk keys work while this tab or the floating controls window is focused. While you show another window, press
            and hold the voice button in the floating controls instead. The desktop app (<code>npm run app</code>) makes the keys work everywhere.
          </span>
        </div>
      )}
      <div className="card">
        <h3>What you can say</h3>
        <ul className="callsheet">
          {CALL_SHEET.map((c) => (
            <li key={c.key} className={lit === c.key ? 'lit' : ''}>
              <span className="cs-glyph">
                <Glyph kind={c.key} size={22} />
              </span>
              <div>
                <q>{c.key === 'zoom' && marks[0] ? `Zoom ${marks[0].name.toLowerCase()}` : c.say}</q>
                <small>{c.also}</small>
              </div>
            </li>
          ))}
        </ul>
      </div>

    </aside>
  );
}

function Log() {
  const log = useStore((s) => s.log);
  return (
    <div className="card log-card">
      <h3>What happened</h3>
      {log.length ? (
        <ol className="takelog">
          {[...log]
            .reverse()
            .slice(0, 10)
            .map((l) => (
              <li key={l.id}>
                <Glyph kind={l.kind} size={18} />
                <span>{l.label}</span>
                <time>{clock(l.at)}</time>
              </li>
            ))}
        </ol>
      ) : (
        <p className="muted small">Every command you give, and when, shows up here while you record.</p>
      )}
    </div>
  );
}
