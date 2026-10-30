import { useEffect, useRef, useState, type ReactNode } from 'react';
import { recorder } from '../engine/recorder';
import { native } from '../lib/native';
import { useStore } from '../lib/store';
import { INTENT_LABEL, type Command, type Intent } from '../voice/intent';
import { Bars, Glyph, Icon, Keys, Timecode, holdToTalk, phaseText } from './components';

/**
 * Controls that float over whatever you're demoing.
 *  - 'rail' (desktop app): a slim bar on the edge of the screen, in a transparent window
 *    screen capture never sees. Drag it to either side, at any height. Hover it and it
 *    opens into a column of buttons; hold the talk keys and it becomes a listening pill.
 *    Command animations, the replay and the countdown play on the whole-screen overlay
 *    (FxOverlay); questions and what you said pop out beside the bar.
 *  - 'remote' (browser): Chrome's Picture-in-Picture window, which can't be transparent or
 *    smaller than about 240 × 50, so the window itself is the bar: one row of buttons.
 */
export function FloatingControls({ layout }: { layout: 'rail' | 'remote' }) {
  return layout === 'rail' ? <Rail /> : <Strip />;
}

/** The buttons, in order. `tips` adds the name + shortcut that slides out on hover. */
function useButtons(tips: boolean) {
  const phase = useStore((s) => s.phase);
  const speed = useStore((s) => s.speed);
  const micMuted = useStore((s) => s.micMuted);
  const listen = useStore((s) => s.listen.state);
  const accel = useStore((s) => s.talkKey);
  const keys = useStore((s) => s.shortcuts);
  const live = phase === 'rolling' || phase === 'hold';
  const paused = phase === 'paused';
  const going = live || paused || phase === 'rewinding' || phase === 'preroll';

  const tip = (label: string, k?: string) =>
    tips ? (
      <>
        <span>{label}</span>
        {k && <Keys accel={k} dark />}
      </>
    ) : (
      label
    );

  const talk = (
    <Btn key="talk" className={`fc-talk ls-${listen}`} tip={tip(listen === 'listening' ? 'Listening… let go to send' : 'Hold to talk', accel)} {...holdToTalk}>
      {listen === 'listening' ? <Bars count={4} /> : Icon.voice}
    </Btn>
  );
  const rest: ReactNode[] = [
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
  return { talk, rest };
}

// ───────────────────────── desktop: the slim bar ─────────────────────────

function Rail() {
  const phase = useStore((s) => s.phase);
  const speed = useStore((s) => s.speed);
  const listen = useStore((s) => s.listen.state);
  const side = useStore((s) => s.pillPlace?.side ?? 'right');
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const { talk, rest } = useButtons(true);
  const items = [
    talk,
    ...rest,
    <Btn key="app" tip={<span>Open Take1</span>} onClick={() => native?.showMain()}>
      {Icon.app}
    </Btn>,
  ];

  const enter = () => {
    setHover(true);
    native?.pillInteractive(true);
  };
  const leave = () => {
    if (draggingRef.current) return;
    setHover(false);
    native?.pillInteractive(false);
  };

  /** Grab the bar anywhere but a button to move it; let go and it glides to the nearer edge. */
  const grab = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    e.preventDefault();
    const w = e.currentTarget.ownerDocument.defaultView ?? window;
    draggingRef.current = true;
    setDragging(true);
    native?.pillDrag('start');
    const end = () => {
      w.removeEventListener('pointerup', end);
      w.removeEventListener('pointercancel', end);
      w.removeEventListener('blur', end);
      draggingRef.current = false;
      setDragging(false);
      native?.pillDrag('end');
    };
    w.addEventListener('pointerup', end);
    w.addEventListener('pointercancel', end);
    w.addEventListener('blur', end);
  };

  // the shell ended the drag (mouse released somewhere we didn't see): stop following
  const place = useStore((s) => s.pillPlace);
  useEffect(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
  }, [place]);

  const talking = listen === 'listening' || listen === 'thinking';
  const mode = hover || dragging ? 'open' : talking ? 'listen' : 'rest';

  return (
    <div className={`fc fc-rail side-${side} ph-${phase}`}>
      <div className="fc-anchor">
        <div className="fc-cards">
          <Message rail />
        </div>
        <div
          className={`fc-dock m-${mode} ${dragging ? 'dragging' : ''}`}
          style={{ ['--n' as any]: items.length + 1 }}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onPointerDown={grab}
        >
          <span className="fc-handle" aria-hidden />
          <div className={`fc-listen ${listen === 'thinking' ? 'thinking' : ''}`} aria-hidden>
            {listen === 'thinking' ? (
              <span className="fc-dots">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <Bars count={9} live={mode === 'listen'} className="fc-vbars" />
            )}
          </div>
          <div className="fc-status" title={`${phaseText(phase, speed)} · drag to move`}>
            <span className="fc-grip" aria-hidden>
              <i />
              <i />
              <i />
            </span>
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
    </div>
  );
}

// ───────────────────────── browser: the window is the bar ─────────────────────────

function Strip() {
  const phase = useStore((s) => s.phase);
  const speed = useStore((s) => s.speed);
  const { talk, rest } = useButtons(false);
  const msg = useStripMessage();
  return (
    <div className={`fc fc-strip ph-${phase}`}>
      <div className="fs-status" title={phaseText(phase, speed)}>
        <span className={`dot dot-${phase}`} />
        <Timecode className="fc-tc" short />
      </div>
      {talk}
      <div className="fs-body">
        {msg ? (
          <div className={`fs-msg ${msg.tone ? `fs-${msg.tone}` : ''}`} key={msg.key}>
            {msg.body}
          </div>
        ) : (
          <div className="fs-btns">{rest}</div>
        )}
      </div>
    </div>
  );
}

/** One line of news for the browser bar, in place of the buttons while it matters. */
function useStripMessage(): { key: string; tone: string; body: ReactNode } | null {
  const phase = useStore((s) => s.phase);
  const listen = useStore((s) => s.listen);
  const countdown = useStore((s) => s.countdown);
  const rewind = useStore((s) => s.rewind);
  const toast = useStore((s) => s.toast);
  const drawing = useStore((s) => s.drawing);
  const burst = useBurst();
  const alt = useAlt();

  if (listen.state === 'listening') return { key: `l${listen.id}`, tone: 'listen', body: <>Listening… let go to send</> };
  if (listen.state === 'thinking') return { key: `t${listen.id}`, tone: '', body: <span className="muted">Got it…</span> };
  if (listen.state === 'unsure')
    return {
      key: `u${listen.id}`,
      tone: 'ask',
      body: (
        <>
          {listen.alternatives.slice(0, 3).map((k) => {
            const c = alt(k);
            return c ? (
              <button key={k} onClick={() => recorder.run(c)}>
                {INTENT_LABEL[k as Intent] ?? k}
              </button>
            ) : null;
          })}
          <span className="muted">?</span>
        </>
      ),
    };
  if (listen.state === 'done' && listen.heard)
    return {
      key: `d${listen.id}`,
      tone: '',
      body: (
        <>
          <q>{listen.heard}</q>
          <strong>{INTENT_LABEL[listen.intent as Intent] ?? listen.intent}</strong>
        </>
      ),
    };
  if (drawing) return { key: 'draw', tone: 'draw', body: <>{drawing.kind === 'redact' ? 'Drag over what to blur in Take1' : 'Drag the zoom area in Take1'}</> };
  if (phase === 'rewinding' && rewind)
    return {
      key: 'rew',
      tone: 'cue',
      body: (
        <>
          <Glyph kind="cut" size={18} /> Removing {(rewind.from - rewind.to).toFixed(1)} s
        </>
      ),
    };
  if (phase === 'preroll') return { key: `p${countdown ?? 'r'}`, tone: 'cue', body: countdown !== null ? <strong className="fs-count">{countdown}</strong> : <>Replaying…</> };
  if (toast) return { key: `toast${toast.id}`, tone: '', body: <span className="fs-ellipsis">{toast.text}</span> };
  if (burst)
    return {
      key: `b${burst.id}`,
      tone: 'burst',
      body: (
        <>
          <Glyph kind={burst.kind} size={18} /> {burst.label}
        </>
      ),
    };
  return null;
}

function Btn({ children, tip, className = '', disabled, onClick, ...rest }: { children: ReactNode; tip: ReactNode; className?: string; disabled?: boolean; onClick?: () => void; [k: string]: any }) {
  const plain = typeof tip === 'string';
  return (
    <button className={`fc-btn ${className}`} disabled={disabled} onClick={onClick} aria-label={plain ? tip : undefined} title={plain ? tip : undefined} {...rest}>
      {children}
      {!plain && <span className="fc-tip">{tip}</span>}
    </button>
  );
}

/** The last action, for a moment after it happens. */
function useBurst() {
  const last = useStore((s) => s.lastAction);
  const [burst, setBurst] = useState<typeof last>(null);
  useEffect(() => {
    if (!last) return;
    setBurst(last);
    const t = setTimeout(() => setBurst((b) => (b?.id === last.id ? null : b)), 1500);
    return () => clearTimeout(t);
  }, [last?.id]);
  return burst;
}

/** "Did you mean" choices as runnable commands. */
function useAlt() {
  const marks = useStore((s) => s.marks);
  const micMuted = useStore((s) => s.micMuted);
  return (k: string): Command | null => {
    if (k === 'zoom') return { type: 'zoom', mark: marks[0] ?? null };
    if (k === 'cutBack') return { type: 'cutBack', seconds: 5 };
    if (k === 'chapter') return { type: 'chapter', name: '' };
    if (k === 'camera') return { type: 'camera', on: false };
    if (k === 'mic') return { type: 'mic', on: micMuted };
    return { type: k } as Command;
  };
}

/**
 * Cards beside the desktop bar: a question, what you said, something to do in Take1,
 * a note. Command animations, the replay and the countdown are on the overlay instead.
 */
function Message({ rail }: { rail?: boolean }) {
  const listen = useStore((s) => s.listen);
  const toast = useStore((s) => s.toast);
  const drawing = useStore((s) => s.drawing);
  const alt = useAlt();

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
  } else if (toast) {
    body = <span>{toast.text}</span>;
  }
  if (!body) return null;
  return (
    <div className={`fc-msg ${tone} ${rail ? 'rail' : ''}`} key={`${listen.id}-${listen.state}-${toast?.id ?? 0}`}>
      {body}
    </div>
  );
}
