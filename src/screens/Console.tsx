import { useEffect, useState } from 'react';
import { director } from '../engine/director';
import { native } from '../lib/native';
import { useStore, DEFAULT_SHORTCUTS } from '../lib/store';
import { clock } from '../lib/time';
import { CALL_SHEET } from '../voice/intent';
import { Button, Glyph, Icon, Keys, LivePreview, MatchMeter, ReplayView, Timecode, Toggle, phaseLabel } from '../ui/components';

const SHORTCUT_LABEL: Record<string, string> = {
  command: 'Give a command',
  record: 'Record / stop',
  cut: 'Cut',
  hold: 'Hold / resume',
  mic: 'Mute / unmute mic',
  pill: 'Show / hide pill',
};

export function Console() {
  const s = useStore((x) => x);
  const live = s.phase === 'rolling' || s.phase === 'hold';
  const rew = s.phase === 'rewinding' || s.phase === 'preroll';
  const [burst, setBurst] = useState<typeof s.lastAction>(null);

  useEffect(() => {
    if (!s.lastAction) return;
    setBurst(s.lastAction);
    const t = setTimeout(() => setBurst(null), 1300);
    return () => clearTimeout(t);
  }, [s.lastAction?.id]);

  return (
    <main className={`console ph-${s.phase}`}>
      <section className="console-main">
        <header className="slate-bar">
          <div className="sb-state">
            <span className={`dot dot-${s.phase}`} />
            {phaseLabel[s.phase]}
          </div>
          <Timecode className="sb-tc" />
          <dl className="sb-meta">
            <div>
              <dt>Scene</dt>
              <dd>{s.scene}</dd>
            </div>
            <div>
              <dt>Take</dt>
              <dd>{s.take}</dd>
            </div>
            <div>
              <dt>Retakes</dt>
              <dd>{s.outtakes.length}</dd>
            </div>
          </dl>
        </header>

        <div className={`monitor tally-${s.phase}`}>
          {s.phase === 'preroll' ? (
            <div className="preroll">
              <ReplayView className="preroll-replay" />
              <div className="preroll-side">
                <div className="preroll-count" key={s.countdown ?? 'r'}>
                  {s.countdown ?? <Glyph kind="cut" size={64} />}
                </div>
                <p className="preroll-title">{s.countdown ? 'Punching in' : `Replaying the last ${s.settings.replaySeconds} seconds`}</p>
                {s.teleprompter && <p className="prompt">“{s.teleprompter}”</p>}
                <LivePreview className="preroll-live" onion />
                <MatchMeter score={s.matchScore} />
                <p className="muted small">
                  “Action” to go now · “cut” for one more line back · “never mind” to cancel
                </p>
              </div>
            </div>
          ) : (
            <LivePreview />
          )}

          {s.phase === 'idle' && (
            <div className="overlay ov-idle">
              <p>
                Say <em>“action”</em> or press <Keys accel={s.shortcuts.record} />
              </p>
            </div>
          )}
          {s.phase === 'rewinding' && s.rewind && (
            <div className="overlay ov-rewind">
              <Glyph kind="cut" size={120} />
              <span>Rewinding {(s.rewind.from - s.rewind.to).toFixed(1)} s</span>
            </div>
          )}
          {s.phase === 'hold' && (
            <div className="overlay ov-hold">
              <Glyph kind="hold" size={72} />
              <span>Holding · dead air runs at 8×</span>
            </div>
          )}
          {burst && s.phase !== 'rewinding' && s.phase !== 'preroll' && (
            <div className="burst" key={burst.id}>
              <Glyph kind={burst.kind} size={56} />
              <span>{burst.label}</span>
            </div>
          )}
          {s.holdBadge && s.phase === 'rolling' && <div className="badge-note">{s.holdBadge}</div>}
        </div>

        <div className="dock">
          <button className={`dock-btn ${s.micMuted ? 'off' : ''}`} onClick={() => director.toggleMic()}>
            {s.micMuted ? Icon.micOff : Icon.mic}
            <span>{s.micMuted ? 'Muted' : 'Mic'}</span>
          </button>
          <button className={`dock-rec ${live || rew ? 'on' : ''}`} onClick={() => director.record()}>
            {live || rew ? Icon.stop : Icon.rec}
            <span>{s.phase === 'idle' ? 'Record' : 'Stop & wrap'}</span>
          </button>
          <button className="dock-btn" disabled={!live && !rew} onClick={() => director.run({ type: 'cut' })}>
            {Icon.cut}
            <span>Cut</span>
          </button>
          <button className={`dock-btn ${s.phase === 'hold' ? 'on' : ''}`} disabled={!live} onClick={() => director.holdToggle()}>
            {Icon.hold}
            <span>{s.phase === 'hold' ? 'Resume' : 'Hold'}</span>
          </button>
          <span className="dock-sep" />
          <button className={`dock-voice ls-${s.listen.state}`} onClick={() => director.toggleCommand()}>
            {Icon.voice}
            <span>{s.listen.state === 'listening' ? 'Listening…' : 'Give a command'}</span>
            <Keys accel={s.shortcuts.command} />
          </button>
          {!s.pillOpen && (
            <Button kind="quiet" icon={Icon.pop} onClick={() => director.openPill()}>
              Float the pill
            </Button>
          )}
        </div>
      </section>

      <aside className="side">
        <div className="card">
          <h3>Say it your way</h3>
          <ul className="callsheet">
            {CALL_SHEET.map((c) => (
              <li key={c.key} className={s.lastAction?.kind === c.key ? 'lit' : ''}>
                <span className="cs-glyph">
                  <Glyph kind={c.key} size={22} />
                </span>
                <div>
                  <q>{c.key === 'zoom' && s.marks[0] ? `Zoom ${s.marks[0].name.toLowerCase()}` : c.say}</q>
                  <small>{c.also}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>Take log</h3>
          {s.log.length ? (
            <ol className="takelog">
              {[...s.log].reverse().slice(0, 8).map((l) => (
                <li key={l.id}>
                  <Glyph kind={l.kind} size={18} />
                  <span>{l.label}</span>
                  <time>{clock(l.at)}</time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">Every command lands here.</p>
          )}
        </div>

        <details className="card settings">
          <summary>
            <h3>Settings</h3>
          </summary>
          <label className="slider">
            <span>
              Replay before punch-in <strong>{s.settings.replaySeconds} s</strong>
            </span>
            <input type="range" min={2} max={8} step={1} value={s.settings.replaySeconds} onChange={(e) => director.setSettings({ replaySeconds: +e.target.value })} />
          </label>
          <Toggle label="Replay audio" hint="Use headphones" on={s.settings.prerollAudio} onChange={(v) => director.setSettings({ prerollAudio: v })} />
          <Toggle label="Interface sounds" on={s.settings.sounds} onChange={(v) => director.setSettings({ sounds: v })} />
          <div className="shortcuts">
            {Object.keys(DEFAULT_SHORTCUTS).map((k) => (
              <ShortcutRow key={k} name={k} accel={s.shortcuts[k]} />
            ))}
          </div>
          <p className="muted small">{native ? 'Shortcuts work from any app.' : 'In the browser, shortcuts work while this tab or the pill is focused. The desktop app makes them global.'}</p>
        </details>
      </aside>
    </main>
  );
}

function ShortcutRow({ name, accel }: { name: string; accel: string }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setRec(false);
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[];
      if (!mods.length) return;
      const key = e.code === 'Space' ? 'Space' : e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      director.setShortcut(name, [...mods, key].join('+'));
      setRec(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rec, name]);
  return (
    <div className="sc-row">
      <span>{SHORTCUT_LABEL[name]}</span>
      <button className={`sc-keys ${rec ? 'rec' : ''}`} onClick={() => setRec(true)}>
        {rec ? 'Press keys…' : <Keys accel={accel} />}
      </button>
    </div>
  );
}
