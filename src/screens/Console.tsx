import { director } from '../engine/director';
import { useStore } from '../lib/store';
import { GRAMMAR } from '../voice/grammar';
import { Button, Icon, LivePreview, MatchMeter, MicMeter, Slate, Spool, TallyDot, Ticker, Timecode, Toggle, phaseLabel } from '../ui/components';

export function Console() {
  const s = useStore((x) => x);
  return (
    <main className={`console ph-${s.phase}`}>
      <header className="console-bar">
        <div className="cb-state">
          <TallyDot phase={s.phase} />
          <span>{phaseLabel[s.phase]}</span>
        </div>
        <Timecode className="cb-tc" />
        <div className="cb-slate">
          <span>
            <small>SCENE</small>
            {s.scene}
          </span>
          <span>
            <small>TAKE</small>
            {s.take}
          </span>
          <span>
            <small>OUTTAKES</small>
            {s.outtakes.length}
          </span>
        </div>
        <div className="cb-right">
          <MicMeter level={s.micLevel} bars={10} />
          {!s.hudOpen && (
            <Button kind="quiet" icon={Icon.pop} onClick={() => director.openHud()}>
              Pop out console
            </Button>
          )}
        </div>
      </header>

      <section className="console-stage">
        <div className={`tally-frame tf-${s.phase}`}>
          <LivePreview className="console-preview" onion={s.phase === 'preroll' ? s.matchFrame : null} />

          {s.phase === 'idle' && (
            <div className="overlay ov-idle">
              <div className="breath" />
              <p>
                Say <q>Action</q> when you’re ready
              </p>
              <span className="fine">Your words appear below as Take1 hears them.</span>
            </div>
          )}
          {s.phase === 'hold' && (
            <div className="overlay ov-hold">
              <span className="hold-tag">HOLD · 8×</span>
              <p>Dead air is being squeezed. Say <q>Action</q> when it’s ready.</p>
            </div>
          )}
          {s.phase === 'rewinding' && s.rewind && (
            <div className="overlay ov-rewind">
              <Spool from={s.rewind.from} to={s.rewind.to} />
            </div>
          )}
          {s.phase === 'preroll' && (
            <div className="overlay ov-preroll">
              <div className="count" key={s.countdown}>
                {s.countdown}
              </div>
              <div className="preroll-info">
                <MatchMeter score={s.matchScore} />
                <p className="fine">The faded frame is where the tape left off. Put your window back to match it.</p>
                {s.teleprompter && <p className="prompt">“{s.teleprompter}”</p>}
                <p className="fine">
                  <q>Action</q> to punch in now · <q>Cut</q> to go back one more line · <q>Scratch that</q> to cancel
                </p>
              </div>
            </div>
          )}
          {s.holdBadge && s.phase === 'rolling' && <div className="badge-float">{s.holdBadge}</div>}
          <Slate scene={s.scene} take={s.take} k={s.slateKey} />
        </div>
        <Ticker items={s.ticker} interim={s.interim} max={10} />
      </section>

      <aside className="console-side">
        <div className="card callsheet">
          <h3>Call sheet</h3>
          <ul>
            {GRAMMAR.map((g) => (
              <li key={g.say} className={`cs-${g.tone} ${s.lastCommand === g.key ? 'lit' : ''}`}>
                <q>{g.key === 'zoom' && s.marks[0] ? `Zoom ${s.marks[0].name.toLowerCase()}` : g.say}</q>
                <span>{g.does}</span>
              </li>
            ))}
          </ul>
        </div>
        {s.marks.length > 0 && (
          <div className="card">
            <h3>Stage marks</h3>
            <div className="marks">
              {s.marks.map((m) => (
                <span key={m.id} className={`mark-chip ${s.activeMark === m.id ? 'active' : ''}`}>
                  <button disabled>{m.name}</button>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="card">
          <h3>Settings</h3>
          <Toggle label="Pre-roll audio in headphones" on={s.settings.prerollAudio} onChange={(v) => director.setSettings({ prerollAudio: v })} />
          <Toggle label="UI sounds" on={s.settings.sounds} onChange={(v) => director.setSettings({ sounds: v })} />
          <Toggle label="Strict mode (say “Take one, cut”)" on={s.settings.strict} onChange={(v) => director.setSettings({ strict: v })} />
          <p className="fine kbd-help">
            Keyboard backup: <kbd>Alt</kbd>+<kbd>A</kbd> action · <kbd>C</kbd> cut · <kbd>H</kbd> hold · <kbd>Z</kbd> scratch · <kbd>W</kbd> wrap
          </p>
        </div>
      </aside>
    </main>
  );
}
