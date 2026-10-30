import { useEffect, useState, type ReactNode } from 'react';
import { recorder } from '../engine/recorder';
import { native } from '../lib/native';
import { useStore } from '../lib/store';
import { INTENT_LABEL, type Command, type Intent } from '../voice/intent';
import { Bars, Glyph, Icon, Keys, MatchMeter, ReplayView, Timecode, holdToTalk, phaseText } from './components';

/**
 * Controls that float over whatever you're demoing, in the style of Flow's side controls.
 *  - 'rail' (desktop app): a transparent window on the right edge that screen capture
 *    never sees. At rest it's a slim handle; hover it and it opens into a column of
 *    buttons, each with its name and shortcut sliding out on hover.
 *  - 'remote' (browser): Chrome's Picture-in-Picture window. It can't be transparent or
 *    narrower than about 240 px, so the same column stays open inside it.
 * What you said, countdowns and questions pop out as cards to the left of the column.
 */
export function FloatingControls({ layout }: { layout: 'rail' | 'remote' }) {
  const phase = useStore((s) => s.phase);
  const speed = useStore((s) => s.speed);
  const micMuted = useStore((s) => s.micMuted);
  const listen = useStore((s) => s.listen.state);
  const accel = useStore((s) => s.talkKey);
  const keys = useStore((s) => s.shortcuts);
  const [hover, setHover] = useState(false);

  const live = phase === 'rolling' || phase === 'hold';
  const rew = phase === 'rewinding' || phase === 'preroll';
  const paused = phase === 'paused';
  const going = live || rew || paused;

  const enter = () => {
    setHover(true);
    native?.pillInteractive(true);
  };
  const leave = () => {
    setHover(false);
    native?.pillInteractive(false);
  };

  const tip = (label: string, k?: string) => (
    <>
      <span>{label}</span>
      {k && <Keys accel={k} dark />}
    </>
  );

  const items: ReactNode[] = [
    <Btn key="talk" className={`fc-talk ls-${listen}`} tip={tip(listen === 'listening' ? 'Listening… let go to send' : 'Hold to talk', accel)} {...holdToTalk}>
      {listen === 'listening' ? <Bars count={4} /> : Icon.voice}
    </Btn>,
    <Btn key="rec" className={`fc-rec ${going ? 'on' : ''}`} tip={tip(phase === 'idle' ? 'Start recording' : 'Stop recording', keys.record)} onClick={() => recorder.record()}>
      {going ? Icon.stop : Icon.rec}
    </Btn>,
    <Btn key="pause" className={paused ? 'fc-on' : ''} disabled={!going} tip={tip(paused ? 'Play' : 'Pause', keys.pause)} onClick={() => recorder.pauseToggle()}>
      {paused ? Icon.resume : Icon.pause}
    </Btn>,
    <Btn key="cut" disabled={!going} tip={tip('Cut the last sentence', keys.cut)} onClick={() => recorder.run({ type: 'cut' })}>
      {Icon.cut}
    </Btn>,
    <Btn key="speed" className={phase === 'hold' ? 'fc-speed-on' : ''} disabled={!live} tip={tip(phase === 'hold' ? 'Back to normal speed' : 'Speed up the waiting', keys.hold)} onClick={() => recorder.holdToggle()}>
      {phase === 'hold' ? <span className="fc-x">{speed}×</span> : Icon.hold}
    </Btn>,
    <Btn key="mic" className={micMuted ? 'fc-off' : ''} tip={tip(micMuted ? 'Unmute the mic' : 'Mute the mic', keys.mic)} onClick={() => recorder.toggleMic()}>
      {micMuted ? Icon.micOff : Icon.mic}
    </Btn>,
  ];
  if (native)
    items.push(
      <Btn key="app" tip={tip('Open Take1')} onClick={() => native!.showMain()}>
        {Icon.app}
      </Btn>,
    );

  const pip = layout === 'remote';
  const open = pip || hover || listen !== 'off' || rew || paused;
  return (
    <div className={`fc fc-rail ph-${phase} ${pip ? 'fc-pip-layout' : ''}`}>
      <div className="fc-cards">
        <Message compact={pip} />
      </div>
      <div className={`fc-dock ${open ? 'open' : ''}`} style={{ ['--n' as any]: items.length + 1 }} onPointerEnter={enter} onPointerLeave={leave}>
        <span className="fc-handle" aria-hidden />
        <div className="fc-status" title={phaseText(phase, speed)}>
          <span className={`dot dot-${phase}`} />
          <Timecode className="fc-tc" short />
        </div>
        {items.map((it, i) => (
          <div className="fc-item" key={i} style={{ ['--i' as any]: i + 1 }}>
            {it}
          </div>
        ))}
      </div>
    </div>
  );
}

function Btn({ children, tip, className = '', disabled, onClick, ...rest }: { children: ReactNode; tip: ReactNode; className?: string; disabled?: boolean; onClick?: () => void; [k: string]: any }) {
  return (
    <button className={`fc-btn ${className}`} disabled={disabled} onClick={onClick} aria-label={typeof tip === 'string' ? tip : undefined} {...rest}>
      {children}
      <span className="fc-tip">{tip}</span>
    </button>
  );
}

/** What the controls are saying right now: what you said, the countdown, a question, a note. */
function Message({ compact }: { compact?: boolean }) {
  const phase = useStore((s) => s.phase);
  const listen = useStore((s) => s.listen);
  const last = useStore((s) => s.lastAction);
  const countdown = useStore((s) => s.countdown);
  const match = useStore((s) => s.matchScore);
  const rewind = useStore((s) => s.rewind);
  const toast = useStore((s) => s.toast);
  const drawing = useStore((s) => s.drawing);
  const marks = useStore((s) => s.marks);
  const micMuted = useStore((s) => s.micMuted);
  const [burst, setBurst] = useState<typeof last>(null);

  useEffect(() => {
    if (!last) return;
    setBurst(last);
    const t = setTimeout(() => setBurst((b) => (b?.id === last.id ? null : b)), 1500);
    return () => clearTimeout(t);
  }, [last?.id]);

  const alt = (k: string): Command | null => {
    if (k === 'zoom') return { type: 'zoom', mark: marks[0] ?? null };
    if (k === 'cutBack') return { type: 'cutBack', seconds: 5 };
    if (k === 'chapter') return { type: 'chapter', name: '' };
    if (k === 'camera') return { type: 'camera', on: false };
    if (k === 'mic') return { type: 'mic', on: micMuted };
    return { type: k } as Command;
  };

  let body: ReactNode = null;
  let tone = '';
  if (listen.state === 'unsure') {
    tone = 'ask';
    body = (
      <>
        <span>{listen.heard ? <>Heard <q>{listen.heard}</q>. Did you mean</> : 'Didn’t catch that. Did you mean'}</span>
        <div className="alts">
          {listen.alternatives.map((k) => {
            const c = alt(k);
            return c ? (
              <button key={k} onClick={() => recorder.run(c)}>
                {INTENT_LABEL[k as Intent] ?? k}
              </button>
            ) : null;
          })}
        </div>
      </>
    );
  } else if (listen.state === 'thinking') {
    body = <span className="muted">Got it…</span>;
  } else if (listen.state === 'done' && listen.heard) {
    body = (
      <>
        <q>{listen.heard}</q>
        <span className="arrow">→</span>
        <strong>{INTENT_LABEL[listen.intent as Intent] ?? listen.intent}</strong>
      </>
    );
  } else if (drawing) {
    tone = 'draw';
    body = (
      <>
        <span>{drawing.kind === 'redact' ? 'Drag over what to blur in Take1' : 'Drag the zoom area in Take1'}</span>
        {native && <button onClick={() => native!.showMain()}>Open</button>}
      </>
    );
  } else if (phase === 'rewinding' && rewind) {
    tone = 'cue';
    body = (
      <>
        <Glyph kind="cut" size={20} />
        <span>Removing the last {(rewind.from - rewind.to).toFixed(1)} s</span>
      </>
    );
  } else if (phase === 'preroll') {
    tone = 'cue';
    body = compact ? (
      <span>
        {countdown !== null ? `Recording again in ${countdown}` : 'Replaying…'}
        {match !== null && ` · screen ${Math.round(match * 100)}% match`}
      </span>
    ) : (
      <div className="fc-replay">
        <ReplayView />
        {countdown !== null && (
          <div className="fc-count" key={countdown}>
            {countdown}
          </div>
        )}
        <MatchMeter score={match} dark />
      </div>
    );
  } else if (phase === 'paused') {
    body = (
      <span>
        Paused. Say <q>play</q> to carry on.
      </span>
    );
  } else if (toast) {
    body = <span>{toast.text}</span>;
  } else if (burst) {
    tone = 'burst';
    body = (
      <>
        <Glyph kind={burst.kind} size={20} />
        <span>{burst.label}</span>
      </>
    );
  }
  if (!body) return null;
  return (
    <div className={`fc-msg ${tone}`} key={`${listen.id}-${phase}-${burst?.id ?? 0}`}>
      {body}
    </div>
  );
}
