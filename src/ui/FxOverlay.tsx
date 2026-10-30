import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { Glyph, MatchMeter, ReplayView } from './components';

/**
 * Desktop only: a click-through layer over the whole screen (never recorded) for
 *  - each command's animation, big and centred,
 *  - "Removing the last 2.4 s" while a cut rewinds,
 *  - the replay after a cut, in a panel that grows out of the bar (about a quarter of
 *    the screen) and folds back into it when the countdown starts,
 *  - the 3, 2, 1 before you speak again.
 */
export function FxOverlay() {
  const phase = useStore((s) => s.phase);
  const countdown = useStore((s) => s.countdown);
  const rewind = useStore((s) => s.rewind);
  const last = useStore((s) => s.lastAction);
  const place = useStore((s) => s.pillPlace);
  const match = useStore((s) => s.matchScore);
  const seconds = useStore((s) => s.settings.replaySeconds);
  const teleprompter = useStore((s) => s.teleprompter);
  // if Windows can't keep this overlay out of captures, don't draw over frames being recorded
  const leaks = useStore((s) => s.capture?.fx === true);
  const capturing = phase === 'rolling' || phase === 'hold';
  const root = useRef<HTMLDivElement>(null);
  const [burst, setBurst] = useState<typeof last>(null);

  useEffect(() => {
    if (!last || last.kind === 'cut') return; // a cut has its own animation while it rewinds
    setBurst(last);
    const t = setTimeout(() => setBurst((b) => (b?.id === last.id ? null : b)), 1500);
    return () => clearTimeout(t);
  }, [last?.id]);

  // the replay panel: open while replaying, then fold back into the bar on "3"
  const replaying = phase === 'preroll' && countdown === null;
  const [panel, setPanel] = useState<'off' | 'open' | 'closing'>('off');
  useEffect(() => {
    if (replaying) return setPanel('open');
    setPanel((p) => (p === 'open' ? 'closing' : p));
    const t = setTimeout(() => setPanel((p) => (p === 'closing' ? 'off' : p)), 460);
    return () => clearTimeout(t);
  }, [replaying]);

  // where the bar is, in this window's coordinates (the overlay covers the bar's screen)
  const win = root.current?.ownerDocument.defaultView;
  const W = place?.display.width ?? win?.innerWidth ?? 1920;
  const H = place?.display.height ?? win?.innerHeight ?? 1080;
  const side = place?.side ?? 'right';
  const bx = place ? place.cx - place.display.x : side === 'right' ? W - 37 : 37;
  const by = place ? place.cy - place.display.y : H / 2;
  const pw = Math.round(W * 0.5);
  const ph = Math.round(pw * (9 / 16) + 92);
  const top = Math.round(Math.min(H - ph - 24, Math.max(24, by - ph / 2)));
  const gap = 44;
  const panelStyle: Record<string, string | number> =
    side === 'right'
      ? { width: pw, top, right: Math.max(16, W - bx + gap), transformOrigin: `calc(100% + ${gap}px) ${by - top}px` }
      : { width: pw, top, left: Math.max(16, bx + gap), transformOrigin: `-${gap}px ${by - top}px` };

  return (
    <div className="fxo" ref={root}>
      {burst && phase !== 'rewinding' && !(leaks && capturing) && (
        <>
          <div className={`fxo-tint fx-${burst.kind}`} key={`t${burst.id}`} />
          <div className={`fxo-card b-${burst.kind}`} key={`c${burst.id}`}>
            <span className="fxo-glyph">
              <Glyph kind={burst.kind} size={84} />
            </span>
            <span className="fxo-label">{burst.label}</span>
          </div>
        </>
      )}

      {phase === 'rewinding' && rewind && (
        <div className="fxo-card fxo-cut" key={`r${rewind.from}`}>
          <span className="fxo-glyph">
            <Glyph kind="cut" size={96} />
          </span>
          <span className="fxo-label">Removing the last {(rewind.from - rewind.to).toFixed(1)} s</span>
        </div>
      )}

      {panel !== 'off' && (
        <div className={`fxo-replay ${panel}`} style={panelStyle}>
          <header>
            <strong>Replaying the last {seconds} s</strong>
            <span>Say it again after 3, 2, 1</span>
          </header>
          <ReplayView />
          {teleprompter && <p className="fxo-said">You said: “{teleprompter}”</p>}
          <MatchMeter score={match} />
        </div>
      )}

      {phase === 'preroll' && countdown !== null && (
        <div className="fxo-count" key={`n${countdown}`}>
          <svg viewBox="0 0 120 120" aria-hidden>
            <circle cx="60" cy="60" r="54" />
          </svg>
          <span>{countdown}</span>
        </div>
      )}
    </div>
  );
}
