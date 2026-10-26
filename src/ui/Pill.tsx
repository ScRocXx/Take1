import { useEffect, useState } from 'react';
import { director } from '../engine/director';
import { native } from '../lib/native';
import { useStore } from '../lib/store';
import { INTENT_LABEL, type Command, type Intent } from '../voice/intent';
import { Bars, Glyph, Icon, Keys, MatchMeter, ReplayView, Timecode } from './components';

/**
 * The Flow-style capsule. Lives in a transparent, capture-proof window on the
 * desktop (or a Picture-in-Picture window in the browser). At rest it's a small
 * dark bar; hover opens the controls; a command session turns it into white
 * bars; every action plays its own glyph.
 */
export function Pill({ docked = false }: { docked?: boolean }) {
  const phase = useStore((s) => s.phase);
  const listen = useStore((s) => s.listen);
  const last = useStore((s) => s.lastAction);
  const micMuted = useStore((s) => s.micMuted);
  const take = useStore((s) => s.take);
  const countdown = useStore((s) => s.countdown);
  const match = useStore((s) => s.matchScore);
  const prompt = useStore((s) => s.teleprompter);
  const rewind = useStore((s) => s.rewind);
  const holdBadge = useStore((s) => s.holdBadge);
  const accel = useStore((s) => s.shortcuts.command);
  const marks = useStore((s) => s.marks);
  const [hover, setHover] = useState(false);
  const [burst, setBurst] = useState<typeof last>(null);

  useEffect(() => {
    if (!last) return;
    setBurst(last);
    const t = setTimeout(() => setBurst((b) => (b?.id === last.id ? null : b)), 1400);
    return () => clearTimeout(t);
  }, [last?.id]);

  const live = phase === 'rolling' || phase === 'hold';
  const rew = phase === 'rewinding' || phase === 'preroll';
  const toast = useStore((s) => s.toast);
  const asking = listen.state === 'listening' || listen.state === 'thinking' || listen.state === 'unsure';
  const mode = asking ? 'listen' : rew ? 'rewind' : listen.state === 'done' ? 'listen' : burst ? 'burst' : hover || docked ? 'open' : 'rest';

  const enter = () => {
    setHover(true);
    native?.pillInteractive(true);
  };
  const leave = () => {
    setHover(false);
    native?.pillInteractive(false);
  };

  const alt = (k: string): Command | null => {
    if (k === 'zoom') return marks[0] ? { type: 'zoom', mark: marks[0] } : null;
    if (k === 'cutBack') return { type: 'cutBack', seconds: 5 };
    if (k === 'chapter') return { type: 'chapter', name: '' };
    if (k === 'camera') return { type: 'camera', on: false };
    if (k === 'mic') return { type: 'mic', on: micMuted };
    return { type: k } as Command;
  };

  return (
    <div className={`pill-stage ${docked ? 'docked' : ''}`}>
      <div className="pill-wrap" onPointerEnter={enter} onPointerLeave={leave}>
        {/* card above the capsule */}
        {phase === 'preroll' && (
          <div className="pill-card replay-card" key="replay">
            <ReplayView />
            {countdown !== null && (
              <div className="pc-count" key={countdown}>
                {countdown}
              </div>
            )}
            <MatchMeter score={match} dark />
            {prompt && <p className="pc-prompt">“{prompt}”</p>}
          </div>
        )}
        {listen.state === 'done' && listen.heard && (
          <div className="pill-card bubble" key={`d${listen.id}`}>
            <q>{listen.heard}</q>
            <span className="arrow">→</span>
            <strong>{INTENT_LABEL[listen.intent as Intent] ?? listen.intent}</strong>
          </div>
        )}
        {listen.state === 'unsure' && (
          <div className="pill-card bubble unsure" key={`u${listen.id}`}>
            <span>{listen.heard ? <>Heard <q>{listen.heard}</q>. Did you mean</> : 'Didn’t catch that. Did you mean'}</span>
            <div className="alts">
              {listen.alternatives.map((k) => {
                const c = alt(k);
                return c ? (
                  <button key={k} onClick={() => director.run(c)}>
                    {INTENT_LABEL[k as Intent] ?? k}
                  </button>
                ) : null;
              })}
            </div>
          </div>
        )}
        {holdBadge && mode !== 'listen' && <div className="pill-card bubble hold-note">{holdBadge}</div>}
        {toast && !asking && phase !== 'preroll' && (
          <div className="pill-card bubble note" key={`t${toast.id}`}>
            {toast.text}
          </div>
        )}

        <div className={`capsule cap-${mode} ph-${phase} ${micMuted ? 'muted' : ''}`}>
          {mode === 'rest' && (
            <div className="cap-row">
              <span className={`dot dot-${phase}`} />
              {live ? <Timecode className="cap-tc" /> : <span className="cap-word">Take1</span>}
              {phase === 'hold' && <Glyph kind="hold" size={18} />}
            </div>
          )}

          {mode === 'open' && (
            <div className="cap-row cap-controls">
              <button className={`cbtn ${micMuted ? 'off' : ''}`} onClick={() => director.toggleMic()} title={micMuted ? 'Unmute mic' : 'Mute mic'}>
                {micMuted ? Icon.micOff : Icon.mic}
              </button>
              <button className={`cbtn rec ${live || rew ? 'on' : ''}`} onClick={() => director.record()} title={phase === 'idle' ? 'Start recording' : 'Stop and wrap'}>
                {live || rew ? Icon.stop : Icon.rec}
              </button>
              <button className="cbtn" disabled={!live && !rew} onClick={() => director.run({ type: 'cut' })} title="Cut: redo the last sentence">
                {Icon.cut}
              </button>
              <button className={`cbtn ${phase === 'hold' ? 'on-hold' : ''}`} disabled={!live} onClick={() => director.holdToggle()} title="Hold: squeeze dead air">
                {Icon.hold}
              </button>
              <span className="cap-sep" />
              <span className={`dot dot-${phase}`} />
              <Timecode className="cap-tc" />
              <span className="cap-take">TK {take}</span>
              <span className="cap-sep" />
              <button className="cbtn voice" onClick={() => director.toggleCommand()} title="Give a command">
                {Icon.voice}
                <Keys accel={accel} dark />
              </button>
              {native && (
                <button className="cbtn" onClick={() => native!.showMain()} title="Open Take1">
                  {Icon.app}
                </button>
              )}
            </div>
          )}

          {mode === 'listen' && (
            <div className={`cap-row cap-listen ls-${listen.state}`}>
              {listen.state === 'done' && listen.intent ? (
                <>
                  <Glyph kind={listen.intent} size={22} />
                  <span className="cap-label">{INTENT_LABEL[listen.intent as Intent]}</span>
                </>
              ) : (
                <>
                  <Bars count={16} live={listen.state === 'listening'} />
                  <span className="cap-label">{listen.state === 'thinking' ? 'Got it' : listen.state === 'unsure' ? 'Try again' : 'Listening'}</span>
                  {listen.state === 'listening' && <kbd className="esc">Esc</kbd>}
                </>
              )}
            </div>
          )}

          {mode === 'rewind' && (
            <div className="cap-row">
              <Glyph kind="cut" size={22} />
              <span className="cap-label">
                {phase === 'rewinding' && rewind ? `Rewinding −${(rewind.from - rewind.to).toFixed(1)} s` : countdown !== null ? `Back in ${countdown}` : 'Replaying'}
              </span>
            </div>
          )}

          {mode === 'burst' && burst && (
            <div className="cap-row cap-burst" key={burst.id}>
              <Glyph kind={burst.kind} size={22} />
              <span className="cap-label">{burst.label}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
