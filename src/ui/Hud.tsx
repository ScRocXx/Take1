import { useStore } from '../lib/store';
import { Timecode, TallyDot, Ticker, Spool, MatchMeter, LivePreview, Slate, phaseLabel } from './components';

/**
 * The floating console (Document Picture-in-Picture). Always on top while you
 * present another window. Kept deliberately small: timecode, tally, what it heard.
 * If you capture your entire monitor it would be in shot, so while rolling it
 * collapses to "dot mode" (Stage also nudges you to capture a window instead).
 */
export function Hud() {
  const s = useStore((x) => x);
  const dot = s.surface === 'monitor' && s.phase === 'rolling';
  return (
    <div className={`hud hud-${s.phase} ${dot ? 'hud-dot' : ''}`}>
      <div className="hud-edge" />
      {dot ? (
        <div className="hud-dotmode">
          <TallyDot phase={s.phase} />
          <Timecode className="hud-tc-small" />
        </div>
      ) : (
        <>
          <div className="hud-top">
            <span className="hud-state">
              <TallyDot phase={s.phase} />
              {phaseLabel[s.phase]}
            </span>
            <span className="hud-slate">
              SC {s.scene} · TK {s.take}
            </span>
          </div>
          {s.phase === 'rewinding' && s.rewind ? (
            <Spool from={s.rewind.from} to={s.rewind.to} />
          ) : s.phase === 'preroll' ? (
            <div className="hud-preroll">
              <LivePreview className="hud-onion" onion={s.matchFrame} />
              <div className="hud-pr-right">
                <div className="hud-count" key={s.countdown}>
                  {s.countdown}
                </div>
                <MatchMeter score={s.matchScore} />
              </div>
              {s.teleprompter && <p className="hud-prompt">“{s.teleprompter}”</p>}
            </div>
          ) : (
            <>
              <Timecode className="hud-tc" />
              {s.phase === 'idle' && <p className="hud-hint">Say “Action” to roll</p>}
              {s.phase === 'hold' && <p className="hud-hint hold">Holding dead air · say “Action”</p>}
              {s.holdBadge && s.phase === 'rolling' && <p className="hud-hint hold">{s.holdBadge}</p>}
              <Ticker items={s.ticker} interim={s.interim} max={3} compact />
            </>
          )}
          <Slate scene={s.scene} take={s.take} k={s.slateKey} />
        </>
      )}
    </div>
  );
}
