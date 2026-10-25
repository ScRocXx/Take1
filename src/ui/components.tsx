import { useEffect, useRef, useState, type ReactNode } from 'react';
import { director } from '../engine/director';
import { timecode } from '../lib/time';
import type { Phase, TickerItem, Tone } from '../lib/store';

/** rAF bound to the window that owns the element (works inside the floating console too). */
function useFrame(ref: React.RefObject<HTMLElement>, fn: () => void) {
  useEffect(() => {
    const w = ref.current?.ownerDocument.defaultView ?? window;
    let id = 0;
    const loop = () => {
      fn();
      id = w.requestAnimationFrame(loop);
    };
    id = w.requestAnimationFrame(loop);
    return () => w.cancelAnimationFrame(id);
  });
}

export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`wordmark wm-${size}`} aria-label="Take1">
      <em>take</em>
      <span className="wm-slash">/</span>
      <b>1</b>
    </span>
  );
}

export function Timecode({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useFrame(ref, () => {
    if (ref.current) ref.current.textContent = timecode(director.tapeNow());
  });
  return <span ref={ref} className={`timecode ${className}`}>00:00:00:00</span>;
}

export function TallyDot({ phase }: { phase: Phase }) {
  return <span className={`tally-dot td-${phase}`} aria-hidden />;
}

export const phaseLabel: Record<Phase, string> = {
  idle: 'Standing by',
  rolling: 'Rolling',
  rewinding: 'Rewinding',
  preroll: 'Pre-roll',
  hold: 'Hold · 8×',
  wrapped: 'Wrapped',
};

export function Chip({ tone = 'muted', children, struck }: { tone?: Tone; children: ReactNode; struck?: boolean }) {
  return <span className={`chip chip-${tone} ${struck ? 'chip-struck' : ''}`}>{children}</span>;
}

export function Ticker({ items, interim, max = 8, compact }: { items: TickerItem[]; interim: string; max?: number; compact?: boolean }) {
  const list = items.slice(-max);
  return (
    <div className={`ticker ${compact ? 'ticker-compact' : ''}`}>
      {list.map((it) =>
        it.kind === 'command' ? (
          <Chip key={it.id} tone={it.tone} struck={it.struck}>
            {it.text}
          </Chip>
        ) : (
          <span key={it.id} className={`ticker-text ${it.kind === 'system' ? 'ticker-sys' : ''}`}>
            {it.text}
          </span>
        ),
      )}
      {interim && <span className="ticker-interim">{interim}…</span>}
      {!list.length && !interim && <span className="ticker-empty">Listening for your voice…</span>}
    </div>
  );
}

/** Live copy of the compositor canvas, drawn at display rate in whichever window it lives. */
export function LivePreview({ className = '', onion }: { className?: string; onion?: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useFrame(ref as any, () => {
    const c = ref.current;
    if (!c) return;
    const src = director.comp.canvas;
    const w = Math.min(1280, Math.round(c.clientWidth * (c.ownerDocument.defaultView?.devicePixelRatio ?? 1))) || 640;
    const h = Math.round((w * src.height) / src.width);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    c.getContext('2d')!.drawImage(src, 0, 0, w, h);
  });
  return (
    <div className={`live-preview ${className}`} style={{ aspectRatio: `${director.comp.W} / ${director.comp.H}` }}>
      <canvas ref={ref} />
      {onion && <img className="onion" src={onion} alt="" />}
    </div>
  );
}

export function Slate({ scene, take, k }: { scene: number; take: number; k: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!k) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 1100);
    return () => clearTimeout(t);
  }, [k]);
  if (!show) return null;
  return (
    <div className="slate" key={k}>
      <div className="slate-arm">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="slate-body">
        <div>
          <small>SCENE</small>
          <strong>{scene}</strong>
        </div>
        <div>
          <small>TAKE</small>
          <strong>{take}</strong>
        </div>
      </div>
    </div>
  );
}

/** The rewind moment: reels spin backwards while the timecode runs from → to. */
export function Spool({ from, to }: { from: number; to: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const tc = useRef<HTMLSpanElement>(null);
  const t0 = useRef(performance.now());
  useFrame(ref, () => {
    const k = Math.min(1, (performance.now() - t0.current) / 1050);
    const e = 1 - Math.pow(1 - k, 3);
    if (tc.current) tc.current.textContent = timecode(from + (to - from) * e);
  });
  return (
    <div className="spool" ref={ref}>
      <div className="reels">
        <Reel />
        <div className="tape-path">
          <div className="tape-wave" />
        </div>
        <Reel />
      </div>
      <span className="spool-tc" ref={tc}>
        {timecode(from)}
      </span>
      <span className="spool-label">Rewinding −{(from - to).toFixed(1)} s</span>
    </div>
  );
}

function Reel() {
  return (
    <svg className="reel" viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="50" cy="50" r="9" fill="currentColor" />
      {[0, 120, 240].map((a) => (
        <circle key={a} cx={50 + 26 * Math.cos((a * Math.PI) / 180)} cy={50 + 26 * Math.sin((a * Math.PI) / 180)} r="12" fill="none" stroke="currentColor" strokeWidth="3" />
      ))}
    </svg>
  );
}

export function MatchMeter({ score }: { score: number | null }) {
  const pct = score === null ? 0 : Math.round(score * 100);
  const tone = pct >= 85 ? 'ok' : pct >= 60 ? 'cue' : 'tally';
  return (
    <div className={`match-meter mm-${tone}`}>
      <div className="mm-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <span>{score === null ? 'Reading frame…' : pct >= 85 ? `Matched ${pct}%` : `Line it up · ${pct}%`}</span>
    </div>
  );
}

export function MicMeter({ level, bars = 18 }: { level: number; bars?: number }) {
  return (
    <div className="mic-meter" aria-label="Microphone level">
      {Array.from({ length: bars }, (_, i) => {
        const on = level * bars > i;
        return <i key={i} className={on ? (i > bars * 0.8 ? 'hot' : 'on') : ''} />;
      })}
    </div>
  );
}

export function Button({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  icon,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ghost' | 'quiet' | 'danger';
  disabled?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <button className={`btn btn-${kind} ${className}`} onClick={onClick} disabled={disabled}>
      {icon}
      {children}
    </button>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <button role="switch" aria-checked={on} className={on ? 'on' : ''} onClick={() => onChange(!on)}>
        <i />
      </button>
    </label>
  );
}

export function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

export function downloadText(text: string, name: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  download(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      kind="quiet"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export const Icon = {
  mic: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ),
  screen: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </svg>
  ),
  pop: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  ),
  down: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 4v12m0 0-5-5m5 5 5-5M5 20h14" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <path d="m5 12 5 5 9-10" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
};
