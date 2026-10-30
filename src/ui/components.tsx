import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { recorder } from '../engine/recorder';
import { clock, timecode } from '../lib/time';
import type { Phase, Rect } from '../lib/store';

/** rAF bound to the window that owns the element (works inside the floating pill too). */
export function useFrame(ref: React.RefObject<Element>, fn: (now: number) => void) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const w = ref.current?.ownerDocument.defaultView ?? window;
    let id = 0;
    const loop = (now: number) => {
      fnRef.current(now);
      id = w.requestAnimationFrame(loop);
    };
    id = w.requestAnimationFrame(loop);
    return () => w.cancelAnimationFrame(id);
  }, [ref]);
}

/** Press-and-hold behaviour for any voice button: listening only while held. */
export const holdToTalk = {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    recorder.commandDown();
  },
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    recorder.commandUp();
  },
  onPointerCancel: () => recorder.cancelCommand(),
  onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
};

export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`wordmark wm-${size}`} aria-label="Take1">
      Take<span className="wm-frame">1</span>
    </span>
  );
}

/** Live position in the recording. `short` shows m:ss (for tight spaces). */
export function Timecode({ className = '', short = false }: { className?: string; short?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useFrame(ref, () => {
    if (!ref.current) return;
    const t = recorder.outputTime();
    const text = short ? clock(t) : timecode(t);
    if (ref.current.textContent !== text) ref.current.textContent = text;
  });
  return (
    <span ref={ref} className={`timecode ${className}`}>
      {short ? '0:00' : '00:00:00:00'}
    </span>
  );
}

export const phaseLabel: Record<Phase, string> = {
  idle: 'Standing by',
  rolling: 'Rolling',
  paused: 'Paused',
  rewinding: 'Rewinding',
  preroll: 'Replay',
  hold: 'Sped up',
  wrapped: 'Wrapped',
};

/** Phase name for the status line, with the live speed factor. */
export function phaseText(phase: Phase, speed: number) {
  return phase === 'hold' ? `Sped up · ${speed}×` : phaseLabel[phase];
}

/**
 * Drag a box over a picture (normalised 0..1 coordinates). Used for "blur that",
 * "zoom in" while recording, zoom spots in Setup and adjusting blurs in Review.
 */
export function useDrawBox(initial: Rect | null = null) {
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(initial);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const pos = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const handlers = {
    ref: box,
    onPointerDown: (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const p = pos(e);
      setDrag(p);
      setRect({ x: p.x, y: p.y, w: 0, h: 0 });
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drag) return;
      const p = pos(e);
      setRect({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) });
    },
    onPointerUp: () => setDrag(null),
  };
  return { rect, setRect, handlers, dragging: !!drag };
}

export function Keys({ accel, dark }: { accel: string; dark?: boolean }) {
  const parts = accel.split('+').map((p) => (p === 'Control' ? 'Ctrl' : p === 'RightCtrl' ? 'Right Ctrl' : p === 'Super' ? 'Win' : p));
  return (
    <span className={`keys ${dark ? 'keys-dark' : ''}`}>
      {parts.map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
    </span>
  );
}

/** Flow-style white bars that follow the mic. */
export function Bars({ count = 14, live = true, className = '' }: { count?: number; live?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const mult = useRef(Array.from({ length: count }, (_, i) => 0.45 + 0.55 * Math.abs(Math.sin(i * 1.7 + 0.3))));
  useFrame(ref, (now) => {
    const el = ref.current;
    if (!el) return;
    const lv = live ? Math.min(1, (recorder.audio?.level ?? 0) * 7) : 0;
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const wob = 0.65 + 0.35 * Math.sin(now / 90 + i * 0.9);
      const h = 0.14 + Math.min(0.86, lv * mult.current[i] * wob * 1.25);
      (kids[i] as HTMLElement).style.transform = `scaleY(${h.toFixed(3)})`;
    }
  });
  return (
    <div ref={ref} className={`bars ${className}`} aria-hidden>
      {mult.current.map((_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}

/**
 * One animated glyph per action, drawn in a single line style so they read as a
 * family: reels spin back for Cut, chevrons run for Speed up, brackets close for Zoom…
 */
export function Glyph({ kind, size = 28 }: { kind: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 48 48', className: `glyph g-${kind}`, 'aria-hidden': true } as const;
  switch (kind) {
    case 'action':
    case 'record':
      return (
        <svg {...p}>
          <circle className="g-ripple" cx="24" cy="24" r="14" />
          <circle className="g-dot" cx="24" cy="24" r="8" />
        </svg>
      );
    case 'play':
      return (
        <svg {...p}>
          <circle className="g-ring" cx="24" cy="24" r="17" />
          <path className="g-play" d="M20 15v18l14-9z" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...p}>
          <circle className="g-ring" cx="24" cy="24" r="17" />
          <path className="g-bar-l" d="M19 16v16" />
          <path className="g-bar-r" d="M29 16v16" />
        </svg>
      );
    case 'unblur':
      return (
        <svg {...p}>
          <g className="g-lines">
            <path d="M9 16h30M9 24h22M9 32h26" />
          </g>
          <rect className="g-bar" x="7" y="19" width="34" height="10" rx="5" />
        </svg>
      );
    case 'resume':
      return (
        <svg {...p}>
          <path className="g-speed" d="M6 18h8M4 24h10M6 30h8" />
          <path className="g-play" d="M19 13v22l17-11z" />
        </svg>
      );
    case 'cut':
    case 'cutBack':
      return (
        <svg {...p}>
          <path className="g-tape" d="M10 31h28" />
          <g className="g-reel g-reel-l">
            <circle cx="14" cy="22" r="9" />
            <path d="M14 22v-5M14 22l4.3 2.5M14 22l-4.3 2.5" />
          </g>
          <g className="g-reel g-reel-r">
            <circle cx="34" cy="22" r="9" />
            <path d="M34 22v-5M34 22l4.3 2.5M34 22l-4.3 2.5" />
          </g>
        </svg>
      );
    case 'hold':
      return (
        <svg {...p}>
          <g className="g-chev">
            <path d="M10 14l10 10-10 10" />
            <path d="M22 14l10 10-10 10" />
            <path className="g-chev-3" d="M34 14l10 10-10 10" />
          </g>
        </svg>
      );
    case 'zoom':
    case 'wide':
      return (
        <svg {...p}>
          <path className="g-corner g-c1" d="M8 17V8h9" />
          <path className="g-corner g-c2" d="M31 8h9v9" />
          <path className="g-corner g-c3" d="M40 31v9h-9" />
          <path className="g-corner g-c4" d="M17 40H8v-9" />
          <circle className="g-center" cx="24" cy="24" r="2.5" />
        </svg>
      );
    case 'redact':
      return (
        <svg {...p}>
          <g className="g-lines">
            <path d="M9 16h30M9 24h22M9 32h26" />
          </g>
          <rect className="g-bar" x="7" y="19" width="34" height="10" rx="5" />
        </svg>
      );
    case 'chapter':
      return (
        <svg {...p}>
          <path className="g-rule" d="M6 40h36" />
          <path className="g-ribbon" d="M16 8h16v26l-8-6-8 6z" />
        </svg>
      );
    case 'scratch':
      return (
        <svg {...p}>
          <path className="g-arc" d="M14 18a13 13 0 1 1-2 13" />
          <path className="g-arrowhead" d="M8 10l6 8-9 2" />
        </svg>
      );
    case 'camera':
      return (
        <svg {...p}>
          <circle className="g-bubble" cx="24" cy="24" r="15" />
          <circle className="g-head" cx="24" cy="20" r="5" />
          <path className="g-shoulders" d="M15 34c2-5 5-7 9-7s7 2 9 7" />
        </svg>
      );
    case 'mic':
      return (
        <svg {...p}>
          <rect className="g-mic" x="18" y="7" width="12" height="22" rx="6" />
          <path className="g-mic" d="M12 23a12 12 0 0 0 24 0M24 35v6" />
          <path className="g-slash" d="M10 9l28 30" />
        </svg>
      );
    case 'punch':
    case 'wrap':
      return (
        <svg {...p}>
          <g className="g-clap-top">
            <path d="M8 17l30-8 2 7-30 8z" />
            <path d="M15 15l3 6M23 13l3 6M31 11l3 6" />
          </g>
          <rect className="g-clap-body" x="8" y="22" width="32" height="18" rx="2" />
          {kind === 'wrap' && <path className="g-check" d="M17 31l5 5 9-9" />}
        </svg>
      );
    case 'listen':
      return (
        <svg {...p}>
          <path className="g-wave" d="M8 24h4M16 16v16M24 10v28M32 16v16M40 22v4" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="24" cy="24" r="6" />
        </svg>
      );
  }
}

/** The live output picture (sent by the compositor worker), drawn at display rate in whichever window it lives. */
export function LivePreview({ className = '', onion }: { className?: string; onion?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const shown = useRef<ImageBitmap | null>(null);
  // the compositor only makes previews while at least one is on screen
  useEffect(() => recorder.comp.watch(), []);
  useFrame(ref, () => {
    const c = ref.current;
    const src = recorder.comp.latest;
    if (!c || !src || (src === shown.current && !onion)) return;
    shown.current = src;
    if (c.width !== src.width || c.height !== src.height) {
      c.width = src.width;
      c.height = src.height;
    }
    const x = c.getContext('2d')!;
    try {
      x.globalAlpha = 1;
      x.drawImage(src, 0, 0);
      if (onion && recorder.replay?.last) {
        x.globalAlpha = 0.42;
        x.drawImage(recorder.replay.last, 0, 0, c.width, c.height);
        x.globalAlpha = 1;
      }
    } catch {
      /* bitmap was replaced and closed between frames */
    }
  });
  return (
    <div className={`live-preview ${className}`} style={{ aspectRatio: `${recorder.comp.W} / ${recorder.comp.H}`, ['--ar' as any]: recorder.comp.W / recorder.comp.H }}>
      <canvas ref={ref} />
    </div>
  );
}

/** The real last few seconds of tape, played in sync with the pre-roll audio. */
export function ReplayView({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bar = useRef<HTMLElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useFrame(ref, () => {
    const c = ref.current;
    const r = recorder.replayNow();
    if (!c || !r) return;
    if (r.frame) {
      if (c.width !== r.frame.width) {
        c.width = r.frame.width;
        c.height = r.frame.height;
      }
      c.getContext('2d')!.drawImage(r.frame, 0, 0);
    }
    if (bar.current) bar.current.style.transform = `scaleX(${r.progress.toFixed(3)})`;
    if (label.current) label.current.textContent = `−${r.remaining.toFixed(1)} s`;
  });
  return (
    <div className={`replay ${className}`} style={{ aspectRatio: `${recorder.comp.W} / ${recorder.comp.H}` }}>
      <canvas ref={ref} />
      <span className="replay-tag">
        Replay <span ref={label} />
      </span>
      <div className="replay-track">
        <i ref={bar} />
      </div>
    </div>
  );
}

export function MatchMeter({ score, dark }: { score: number | null; dark?: boolean }) {
  const pct = score === null ? 0 : Math.round(score * 100);
  const tone = pct >= 85 ? 'ok' : pct >= 60 ? 'cue' : 'off';
  return (
    <div className={`match ${dark ? 'match-dark' : ''} m-${tone}`}>
      <div className="match-bar">
        <i style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <span>{score === null ? 'Reading the frame…' : pct >= 85 ? `Screen matches · ${pct}%` : `Line your screen up · ${pct}%`}</span>
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
  title,
}: {
  children?: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ink' | 'ghost' | 'quiet';
  disabled?: boolean;
  icon?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <button className={`btn btn-${kind} ${className}`} onClick={onClick} disabled={disabled} title={title}>
      {icon}
      {children}
    </button>
  );
}

/**
 * A dialog over the page. Rendered on <body>: inside an animated card, a fixed overlay
 * would be trapped in that card instead of covering the screen.
 */
export function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div className="modal" onClick={onClose}>
      {children}
    </div>,
    document.body,
  );
}

export function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
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

const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
export const Icon = {
  mic: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ),
  micOff: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" />
    </svg>
  ),
  rec: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <circle cx="12" cy="12" r="7" fill="currentColor" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  ),
  cut: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <path d="M11 7 6 12l5 5M18 7l-5 5 5 5" />
    </svg>
  ),
  hold: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <path d="M5 7l5 5-5 5M13 7l5 5-5 5" />
    </svg>
  ),
  voice: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <path d="M4 12h1.5M8 8v8M12 5v14M16 8v8M19.5 11v2" />
    </svg>
  ),
  screen: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </svg>
  ),
  pop: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="11" y="13" width="7" height="3" rx="1.5" fill="currentColor" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" width="14" height="14">
      <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
    </svg>
  ),
  resume: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
      <rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  youtube: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <rect x="3" y="6" width="18" height="12" rx="3.5" />
      <path d="M10.5 9.5v5l4-2.5z" fill="currentColor" />
    </svg>
  ),
  drive: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <path d="M8.5 4h7l6 10.5-3.5 6h-12L2.5 14.5z" />
      <path d="M8.5 4l6 10.5H2.5M15.5 4l-6 10.5 3 6" />
    </svg>
  ),
  share: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...s}>
      <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" width="16" height="16" {...s}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  ),
  down: (
    <svg viewBox="0 0 24 24" width="16" height="16" {...s}>
      <path d="M12 4v12m0 0-5-5m5 5 5-5M5 20h14" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" width="14" height="14" {...s} strokeWidth={3}>
      <path d="m5 12 5 5 9-10" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" width="14" height="14" {...s} strokeWidth={2.4}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" width="14" height="14" {...s} strokeWidth={2.4}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  app: (
    <svg viewBox="0 0 24 24" width="16" height="16" {...s}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 9h18" />
    </svg>
  ),
};
