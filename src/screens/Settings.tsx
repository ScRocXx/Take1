import { useEffect, useState } from 'react';
import { recorder } from '../engine/recorder';
import { native } from '../lib/native';
import { store, useStore, DEFAULT_SHORTCUTS, TALK_KEYS } from '../lib/store';
import { stt } from '../voice/stt';
import { Button, Keys, Toggle } from '../ui/components';

const SHORTCUT_LABEL: Record<string, string> = {
  record: 'Start / stop recording',
  pause: 'Pause / play',
  cut: 'Cut',
  hold: 'Speed up / normal speed',
  mic: 'Mute / unmute mic',
  pill: 'Show / hide the floating bar',
};

/** Desktop app: Settings is its own page, like any app's. */
export function SettingsScreen() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    native?.version?.().then(setVersion).catch(() => {});
  }, []);
  return (
    <main className="setup settings-page">
      <header className="setup-head">
        <div>
          <p className="overline">Take1{version ? ` ${version}` : ''}</p>
          <h1>Settings</h1>
        </div>
        <Button kind="ghost" onClick={() => store.set({ screen: store.get().phase === 'wrapped' ? 'review' : store.get().hasScreen ? 'record' : 'setup' })}>
          Done
        </Button>
      </header>
      <SettingsPanel />
    </main>
  );
}

/** Desktop-only: wake phrase, the floating bar, starting with Windows. */
function DesktopGroup() {
  const wake = useStore((s) => s.settings.wake);
  const [login, setLogin] = useState<boolean | null>(null);
  useEffect(() => {
    native?.getOpenAtLogin?.().then(setLogin).catch(() => setLogin(null));
  }, []);
  return (
    <div className="set-group">
      <h4>Desktop app</h4>
      <Toggle
        label="Say “Take one” to give a command"
        hint="No keys needed: pause, then say “Take one, cut” (or “Take one”, then the command). Heard on this computer and removed from the video. Uses a little more CPU while you talk."
        on={wake}
        onChange={(v) => {
          recorder.setSettings({ wake: v });
          if (v) stt.warm();
        }}
      />
      <div className="talk-pick">
        <span>
          Floating bar
          <small>Drag it to either edge of the screen, at any height. Hover it for the buttons.</small>
        </span>
        <Button kind="ghost" onClick={() => native?.pillReset?.()}>
          Reset position
        </Button>
      </div>
      {login !== null && (
        <Toggle
          label="Open Take1 when I sign in"
          hint="The bar is ready on the edge of the screen"
          on={login}
          onChange={async (v) => setLogin((await native?.setOpenAtLogin?.(v)) ?? v)}
        />
      )}
    </div>
  );
}

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const talkKey = useStore((s) => s.talkKey);
  const shortcuts = useStore((s) => s.shortcuts);
  const devices = useStore((s) => s.micDevices);
  const device = useStore((s) => s.micDevice);
  const micOn = useStore((s) => s.micOn);
  const engine = useStore((s) => s.engine);
  return (
    <section className="card settings">
      <header className="settings-head">
        <h3>Settings</h3>
        <span className="muted small">Saved on this computer</span>
      </header>
      <div className="settings-grid">
        <div className="set-group">
          <h4>Recording</h4>
          <label className="slider">
            <span>
              Replay before recording again <strong>{settings.replaySeconds} s</strong>
            </span>
            <input type="range" min={2} max={8} step={1} value={settings.replaySeconds} onChange={(e) => recorder.setSettings({ replaySeconds: +e.target.value })} />
          </label>
          <label className="slider">
            <span>
              Countdown after the replay <strong>{settings.countdown} s</strong>
            </span>
            <input type="range" min={1} max={5} step={1} value={settings.countdown} onChange={(e) => recorder.setSettings({ countdown: +e.target.value })} />
          </label>
          <Toggle label="Replay audio" hint="Hear the replay too (use headphones)" on={settings.prerollAudio} onChange={(v) => recorder.setSettings({ prerollAudio: v })} />
          <label className="talk-pick">
            <span>
              “Speed up” plays at
              <small>“hold 3x” or “fast forward 8x” overrides it</small>
            </span>
            <select value={settings.speed} onChange={(e) => recorder.setSettings({ speed: +e.target.value })}>
              {[2, 3, 4, 8].map((f) => (
                <option key={f} value={f}>
                  {f}×
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="set-group">
          <h4>Voice</h4>
          <label className="talk-pick">
            <span>
              Microphone
              <small>{micOn ? 'Speech is recognised on this computer' : 'Turn it on in Setup'}</small>
            </span>
            <select value={device ?? ''} disabled={!micOn || !devices.length} onChange={(e) => recorder.micOn(e.target.value)}>
              {devices.length ? (
                devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))
              ) : (
                <option value="">Default</option>
              )}
            </select>
          </label>
          <label className="talk-pick">
            <span>
              Hold to talk
              <small>{TALK_KEYS.find((k) => k.id === talkKey)?.note}</small>
            </span>
            <select value={talkKey} onChange={(e) => recorder.setTalkKey(e.target.value)}>
              {TALK_KEYS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <div className="talk-pick">
            <span>
              Speech model
              <small>
                {engine.status === 'ready'
                  ? 'Ready'
                  : engine.status === 'loading'
                    ? `Downloading · ${Math.round(engine.progress * 100)}%`
                    : engine.status === 'error'
                      ? engine.detail
                      : 'Loads when the mic turns on'}
              </small>
            </span>
            {engine.status === 'error' && (
              <Button kind="ghost" onClick={() => stt.retry()}>
                Try again
              </Button>
            )}
          </div>
          <Toggle label="Sounds" hint="Short cues for start, pause, cut, speed and stop" on={settings.sounds} onChange={(v) => recorder.setSettings({ sounds: v })} />
        </div>

        <div className="set-group">
          <h4>{native ? 'Shortcuts' : 'Floating controls & shortcuts'}</h4>
          {!native && (
            <Toggle
              label="Open the floating controls"
              hint="When you continue from Setup to Record"
              on={settings.pill}
              onChange={(v) => recorder.setSettings({ pill: v })}
            />
          )}
          <div className="shortcuts">
            {Object.keys(DEFAULT_SHORTCUTS).map((k) => (
              <ShortcutRow key={k} name={k} accel={shortcuts[k] ?? DEFAULT_SHORTCUTS[k]} />
            ))}
          </div>
          <p className="muted small">
            {native ? 'Shortcuts work from any app. Click one to change it.' : 'Click one to change it. In the browser they work while this tab or the floating controls are focused.'}
          </p>
        </div>
        {native && <DesktopGroup />}
      </div>
    </section>
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
      recorder.setShortcut(name, [...mods, key].join('+'));
      setRec(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rec, name]);
  return (
    <div className="sc-row">
      <span>{SHORTCUT_LABEL[name] ?? name}</span>
      <button className={`sc-keys ${rec ? 'rec' : ''}`} onClick={() => setRec(true)}>
        {rec ? 'Press keys…' : <Keys accel={accel} />}
      </button>
    </div>
  );
}
