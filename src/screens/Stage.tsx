import { useEffect, useRef, useState } from 'react';
import { director } from '../engine/director';
import { store, useStore, type Rect } from '../lib/store';
import { Button, Icon, LivePreview } from '../ui/components';

export function Stage() {
  const hasScreen = useStore((s) => s.hasScreen);
  const surface = useStore((s) => s.surface);
  const hasCamera = useStore((s) => s.hasCamera);
  const marks = useStore((s) => s.marks);
  const active = useStore((s) => s.activeMark);
  const [editing, setEditing] = useState<{ url: string; aspect: number } | null>(null);

  const share = async () => {
    try {
      await director.shareScreen();
    } catch {
      /* user cancelled */
    }
  };

  const openConsole = async () => {
    director.zoomTo(null, false);
    await director.openHud();
    store.set({ screen: 'console', phase: 'idle' });
  };

  return (
    <main className="stage-screen">
      <section className="stage-main">
        <header className="screen-head">
          <p className="eyebrow">Set the stage</p>
          <h1>
            Pick your <em>shot.</em>
          </h1>
        </header>
        <div className="stage-frame">
          {hasScreen ? (
            <LivePreview className="stage-preview" />
          ) : (
            <button className="stage-empty" onClick={share}>
              <span className="se-icon">{Icon.screen}</span>
              <strong>Share the window you’ll demo</strong>
              <span>A single window keeps the floating console out of your video.</span>
            </button>
          )}
          {editing && <MarkEditor image={editing} onClose={() => setEditing(null)} />}
        </div>
        {surface === 'monitor' && (
          <div className="banner banner-cue">
            <strong>You’re capturing your whole screen.</strong> The floating console will be in shot. Share a single window instead, or drag
            the console to a second display. While rolling it shrinks to a small dot either way.
            <Button kind="quiet" onClick={share}>
              Switch to a window
            </Button>
          </div>
        )}
      </section>

      <aside className="stage-side">
        <div className="card">
          <h3>Sources</h3>
          <div className="source-row">
            <span>{Icon.screen} Window</span>
            <Button kind="quiet" onClick={share}>
              {hasScreen ? 'Change' : 'Share'}
            </Button>
          </div>
          <div className="source-row">
            <span>{Icon.camera} Camera bubble</span>
            <Button kind="quiet" onClick={() => director.toggleCamera()}>
              {hasCamera ? 'Turn off' : 'Turn on'}
            </Button>
          </div>
          <div className="source-row">
            <span>{Icon.mic} Microphone</span>
            <span className="ok-text">On</span>
          </div>
        </div>

        <div className="card">
          <h3>Stage marks</h3>
          <p className="fine">Name the parts of your window you’ll want to zoom into. During the take, say “Zoom {marks[0]?.name.toLowerCase() || 'terminal'}”.</p>
          <div className="marks">
            {marks.map((m) => (
              <span key={m.id} className={`mark-chip ${active === m.id ? 'active' : ''}`}>
                <button onClick={() => director.zoomTo(active === m.id ? null : m, false)}>{m.name}</button>
                <button className="x" onClick={() => director.removeMark(m.id)} aria-label={`Remove ${m.name}`}>
                  {Icon.x}
                </button>
              </span>
            ))}
            {!marks.length && <span className="fine">No marks yet.</span>}
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

        <div className="card call-card">
          <h3>Ready?</h3>
          <p className="fine">The console pops out and floats above your window. Then just say “Action”.</p>
          <Button kind="primary" disabled={!hasScreen} onClick={openConsole}>
            Open the console
          </Button>
        </div>
      </aside>
    </main>
  );
}

function MarkEditor({ image, onClose }: { image: { url: string; aspect: number }; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [name, setName] = useState('');
  const naming = useStore((s) => s.namingMark);

  useEffect(() => {
    director.onName = (n) => setName(n.replace(/^(call it|name it|this is( the)?)\s+/i, ''));
    return () => {
      director.onName = null;
      store.set({ namingMark: false });
    };
  }, []);

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
        className="me-canvas"
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
        onPointerUp={() => {
          setDrag(null);
          if (rect && rect.w > 0.02 && rect.h > 0.02) store.set({ namingMark: true });
        }}
      >
        <img src={image.url} alt="" draggable={false} />
        {rect && (
          <div className="me-rect" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />
        )}
        {!rect && <span className="me-hint">Drag a box around the area to zoom into</span>}
      </div>
      <div className="me-bar">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={naming ? 'Say its name… e.g. “terminal”' : 'Name this mark'}
          className={naming && !name ? 'listening' : ''}
          autoFocus
        />
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
