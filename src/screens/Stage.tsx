import { useEffect, useRef, useState } from 'react';
import { director } from '../engine/director';
import { native, type NativeSource } from '../lib/native';
import { store, useStore, type Rect } from '../lib/store';
import { Button, Icon, Keys, LivePreview } from '../ui/components';

export function Stage() {
  const hasScreen = useStore((s) => s.hasScreen);
  const surface = useStore((s) => s.surface);
  const sourceName = useStore((s) => s.sourceName);
  const hasCamera = useStore((s) => s.hasCamera);
  const marks = useStore((s) => s.marks);
  const active = useStore((s) => s.activeMark);
  const picking = useStore((s) => s.pickingSource);
  const accel = useStore((s) => s.shortcuts);
  const [editing, setEditing] = useState<{ url: string; aspect: number } | null>(null);

  const share = async () => {
    try {
      await director.shareScreen();
    } catch {
      /* cancelled */
    }
  };

  const openConsole = async () => {
    director.zoomTo(null, false);
    await director.openPill();
    store.set({ screen: 'console', phase: 'idle' });
    if (native) native.hideMain();
  };

  return (
    <main className="stage-screen">
      <section className="stage-main">
        <header className="screen-head">
          <p className="overline">Step 2 · Choose a window</p>
          <h1>
            Pick your <em>shot.</em>
          </h1>
        </header>
        <div className="monitor">
          {hasScreen ? (
            <LivePreview />
          ) : (
            <button className="monitor-empty" onClick={share}>
              <span className="me-icon">{Icon.screen}</span>
              <strong>Choose the window you’ll demo</strong>
              <span>A single window keeps notifications and other apps out of your video.</span>
            </button>
          )}
          {editing && <MarkEditor image={editing} onClose={() => setEditing(null)} />}
        </div>
        {surface === 'monitor' && !native && (
          <div className="note note-warn">
            You’re capturing a whole screen, so the floating pill will be in shot. Pick a single window, or use the desktop app, which hides the pill
            from recordings.
            <Button kind="quiet" onClick={share}>
              Pick a window
            </Button>
          </div>
        )}
      </section>

      <aside className="side">
        <div className="card">
          <h3>Sources</h3>
          <div className="src-row">
            <span>{Icon.screen}</span>
            <div>
              <strong>Window</strong>
              <small>{hasScreen ? sourceName || 'Shared' : 'Not chosen'}</small>
            </div>
            <Button kind="ghost" onClick={share}>
              {hasScreen ? 'Change' : 'Choose'}
            </Button>
          </div>
          <div className="src-row">
            <span>{Icon.camera}</span>
            <div>
              <strong>Camera bubble</strong>
              <small>{hasCamera ? 'Bottom-right corner' : 'Off'}</small>
            </div>
            <Button kind="ghost" onClick={() => director.toggleCamera()}>
              {hasCamera ? 'Turn off' : 'Turn on'}
            </Button>
          </div>
        </div>

        <div className="card">
          <h3>Zoom spots</h3>
          <p className="muted small">Name parts of the window you’ll zoom into. During the take, say “zoom {marks[0]?.name.toLowerCase() || 'terminal'}”.</p>
          <div className="marks">
            {marks.map((m) => (
              <span key={m.id} className={`mark ${active === m.id ? 'active' : ''}`}>
                <button onClick={() => director.zoomTo(active === m.id ? null : m, false)}>{m.name}</button>
                <button className="x" onClick={() => director.removeMark(m.id)} aria-label={`Remove ${m.name}`}>
                  {Icon.x}
                </button>
              </span>
            ))}
          </div>
          <Button
            kind="ghost"
            icon={Icon.plus}
            disabled={!hasScreen}
            onClick={() => {
              director.zoomTo(null, false);
              setEditing(director.comp.freezeSource());
            }}
          >
            Add a mark
          </Button>
        </div>

        <div className="card card-fathom">
          <h3>Ready</h3>
          <p>
            Next you’ll see the recording console{native ? ' and the floating pill (hidden from the recording)' : ' and a small floating pill window'}. Press{' '}
            <strong>Record</strong> (or <Keys accel={accel.record} dark />) to start.
          </p>
          <Button kind="primary" disabled={!hasScreen} onClick={openConsole}>
            {native ? 'Go to the pill' : 'Open the console'}
          </Button>
        </div>
      </aside>
      {picking && <SourcePicker />}
    </main>
  );
}

function SourcePicker() {
  const [list, setList] = useState<NativeSource[] | null>(null);
  const [tab, setTab] = useState<'window' | 'screen'>('window');
  useEffect(() => {
    native?.getSources().then(setList);
  }, []);
  const close = () => store.set({ pickingSource: false });
  const shown = (list ?? []).filter((s) => s.kind === tab);
  return (
    <div className="modal" onClick={close}>
      <div className="modal-card picker" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>What are you demoing?</h2>
          <div className="seg">
            <button className={tab === 'window' ? 'on' : ''} onClick={() => setTab('window')}>
              Windows
            </button>
            <button className={tab === 'screen' ? 'on' : ''} onClick={() => setTab('screen')}>
              Screens
            </button>
          </div>
        </header>
        <div className="picker-grid">
          {list === null && <p className="muted">Looking for windows…</p>}
          {shown.map((s) => (
            <button key={s.id} className="src-tile" onClick={() => director.useSource(s.id, s.name)}>
              <img src={s.thumbnail} alt="" />
              <span>
                {s.icon && <img className="ico" src={s.icon} alt="" />}
                {s.name}
              </span>
            </button>
          ))}
        </div>
        <footer>
          <Button kind="quiet" onClick={close}>
            Cancel
          </Button>
        </footer>
      </div>
    </div>
  );
}

function MarkEditor({ image, onClose }: { image: { url: string; aspect: number }; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [name, setName] = useState('');

  const pos = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  const save = () => {
    if (!rect) return;
    director.addMark(name || 'Mark', rect);
    onClose();
  };

  return (
    <div className="mark-editor">
      <div
        ref={box}
        className="draw"
        style={{ aspectRatio: String(image.aspect) }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const p = pos(e);
          setDrag(p);
          setRect({ x: p.x, y: p.y, w: 0, h: 0 });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const p = pos(e);
          setRect({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) });
        }}
        onPointerUp={() => setDrag(null)}
      >
        <img src={image.url} alt="" draggable={false} />
        {rect && <div className="draw-rect" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />}
        {!rect && <span className="draw-hint">Drag a box around the area to zoom into</span>}
      </div>
      <div className="draw-bar">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it, e.g. terminal" autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} />
        <Button kind="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button kind="primary" disabled={!rect || rect.w < 0.02} onClick={save}>
          Save mark
        </Button>
      </div>
    </div>
  );
}
