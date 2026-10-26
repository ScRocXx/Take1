import { useEffect, useMemo, useRef, useState } from 'react';
import { director } from '../engine/director';
import { store, useStore, type RangeInfo, type Rect } from '../lib/store';
import { clock } from '../lib/time';
import { Button, Icon } from '../ui/components';

export function Dailies() {
  const duration = useStore((s) => s.duration);
  const ranges = useStore((s) => s.ranges);
  const chapters = useStore((s) => s.chapters);
  const outtakes = useStore((s) => s.outtakes);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [editing, setEditing] = useState<RangeInfo | null>(null);
  const [playing, setPlaying] = useState<{ url: string | null; take: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const lines = useMemo(() => director.transcript(), [duration]);
  const holds = ranges.filter((r) => r.kind === 'hold');
  const redacts = ranges.filter((r) => r.kind === 'redact');
  const saved = holds.reduce((a, r) => a + (r.wall ?? 0) - (r.end - r.start), 0);

  useEffect(() => {
    director
      .previewMp4()
      .then(setUrl)
      .catch((e) => setErr(String(e)));
  }, []);

  const seek = (s: number) => {
    if (video.current) video.current.currentTime = s;
    setT(s);
  };

  const thumbs = useMemo(() => {
    const n = 12;
    return Array.from({ length: n }, (_, i) => {
      const at = (duration * (i + 0.5)) / n;
      return { at, url: director.snapAt(at)?.url };
    });
  }, [duration]);

  const splices = outtakes.map((o) => o.from).filter((f) => f > 0.1 && f < duration);
  const activeRedacts = redacts.filter((r) => t >= r.start && t <= r.end);

  const playOuttake = async (id: string, take: number) => {
    setPlaying({ url: null, take });
    const u = await director.renderOuttakes([id]);
    setPlaying({ url: u, take });
  };

  return (
    <main className="dailies">
      <header className="screen-head dh">
        <div>
          <p className="eyebrow">Dailies</p>
          <h1>
            Here’s your <em>take.</em>
          </h1>
        </div>
        <div className="stats">
          <div>
            <strong>{clock(duration)}</strong>
            <span>final cut</span>
          </div>
          <div>
            <strong>{outtakes.length}</strong>
            <span>lines retaken</span>
          </div>
          <div>
            <strong>{Math.round(saved)} s</strong>
            <span>dead air held</span>
          </div>
          <div>
            <strong>{redacts.length}</strong>
            <span>redactions</span>
          </div>
        </div>
        <Button kind="primary" onClick={() => store.set({ screen: 'wrap' })}>
          Print it →
        </Button>
      </header>

      <section className="dailies-grid">
        <div className="player-col">
          <div className="player" style={{ aspectRatio: `${director.comp.W} / ${director.comp.H}` }}>
            {url ? (
              <video ref={video} src={url} controls onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} />
            ) : (
              <div className="splicing">{err ? `Couldn’t build the preview: ${err}` : 'Splicing the tape…'}</div>
            )}
            {activeRedacts.map((r) => (
              <div
                key={r.id}
                className="redact-box"
                style={{ left: `${r.rect!.x * 100}%`, top: `${r.rect!.y * 100}%`, width: `${r.rect!.w * 100}%`, height: `${r.rect!.h * 100}%` }}
              >
                <span>BLURRED ON EXPORT</span>
              </div>
            ))}
          </div>

          <div className="timeline" onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek(((e.clientX - r.left) / r.width) * duration);
          }}>
            {holds.map((r) => (
              <i key={r.id} className="tl-hold" style={{ left: `${(r.start / duration) * 100}%`, width: `${((r.end - r.start) / duration) * 100}%` }} title={`Held ${Math.round(r.wall ?? 0)} s`} />
            ))}
            {redacts.map((r) => (
              <i key={r.id} className="tl-redact" style={{ left: `${(r.start / duration) * 100}%`, width: `${((r.end - r.start) / duration) * 100}%` }} />
            ))}
            {splices.map((f, i) => (
              <i key={i} className="tl-splice" style={{ left: `${(f / duration) * 100}%` }} title="Splice" />
            ))}
            {chapters.map((c) => (
              <i key={c.id} className="tl-chapter" style={{ left: `${(c.t / duration) * 100}%` }} title={c.name} />
            ))}
            <i className="tl-head" style={{ left: `${(t / Math.max(duration, 0.01)) * 100}%` }} />
          </div>
          <div className="filmstrip">
            {thumbs.map((th, i) => (
              <button key={i} onClick={() => seek(th.at)} style={{ backgroundImage: th.url ? `url(${th.url})` : undefined }}>
                <span>{clock(th.at)}</span>
              </button>
            ))}
          </div>
          <div className="legend">
            <span className="lg-splice">Splice</span>
            <span className="lg-hold">Hold</span>
            <span className="lg-redact">Redaction</span>
            <span className="lg-chapter">Chapter</span>
          </div>

          <div className="outtakes">
            <h3>
              Outtakes <span>every mistake this video survived</span>
            </h3>
            {outtakes.length ? (
              <div className="ot-lane">
                {outtakes.map((o) => (
                  <button key={o.id} className="ot-card" onClick={() => playOuttake(o.id, o.take)}>
                    <div className="ot-thumb" style={{ backgroundImage: o.thumb ? `url(${o.thumb})` : undefined }}>
                      <span className="ot-play">{Icon.play}</span>
                    </div>
                    <div className="ot-meta">
                      <strong>Take {o.take}</strong>
                      <span>{(o.to - o.from).toFixed(1)} s</span>
                    </div>
                    <p>{o.text ? `“${o.text}”` : 'No words caught'}</p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="fine">Clean run. Not a single Cut.</p>
            )}
          </div>
        </div>

        <aside className="dailies-side">
          <div className="card">
            <h3>Transcript</h3>
            <div className="transcript">
              {lines.length ? (
                lines.map((l, i) => (
                  <button key={i} className={t >= l.start && t < l.end ? 'now' : ''} onClick={() => seek(l.start)}>
                    <span>{clock(l.start)}</span>
                    {l.text}
                  </button>
                ))
              ) : (
                <p className="fine">No narration was transcribed.</p>
              )}
            </div>
          </div>
          <div className="card">
            <h3>Chapters</h3>
            {chapters.length ? (
              chapters.map((c) => (
                <div key={c.id} className="chapter-row">
                  <button onClick={() => seek(c.t)}>{clock(c.t)}</button>
                  <input
                    value={c.name}
                    onChange={(e) => store.set((s) => ({ chapters: s.chapters.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)) }))}
                  />
                </div>
              ))
            ) : (
              <p className="fine">Say “Mark it, live demo” while rolling to drop chapters.</p>
            )}
          </div>
          <div className="card">
            <h3>Redactions</h3>
            {redacts.length ? (
              redacts.map((r) => (
                <div key={r.id} className="redact-row">
                  <button onClick={() => seek(r.start)}>
                    {clock(r.start)}–{clock(r.end)}
                  </button>
                  <Button kind="quiet" onClick={() => setEditing(r)}>
                    Adjust box
                  </Button>
                  <Button kind="quiet" onClick={() => store.set((s) => ({ ranges: s.ranges.filter((x) => x.id !== r.id) }))}>
                    Remove
                  </Button>
                </div>
              ))
            ) : (
              <p className="fine">Flashed a key? Say “Redact that” right after.</p>
            )}
          </div>
        </aside>
      </section>

      {editing && <RedactEditor range={editing} onClose={() => setEditing(null)} />}
      {playing && (
        <div className="modal" onClick={() => setPlaying(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>Outtake · Take {playing.take}</h3>
              <Button kind="quiet" onClick={() => setPlaying(null)}>
                Close
              </Button>
            </header>
            {playing.url ? <video src={playing.url} controls autoPlay /> : <div className="splicing">Pulling it from the trash…</div>}
          </div>
        </div>
      )}
    </main>
  );
}

function RedactEditor({ range, onClose }: { range: RangeInfo; onClose: () => void }) {
  const snap = director.snapAt(range.start + 0.5);
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect>(range.rect ?? { x: 0, y: 0, w: 1, h: 1 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const pos = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Drag over what should be blurred</h3>
        </header>
        <div
          ref={box}
          className="me-canvas"
          style={{ aspectRatio: `${director.comp.W} / ${director.comp.H}` }}
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
          {snap && <img src={snap.url} alt="" draggable={false} />}
          <div className="me-rect redact" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />
        </div>
        <div className="me-bar">
          <Button kind="quiet" onClick={() => setRect({ x: 0, y: 0, w: 1, h: 1 })}>
            Whole frame
          </Button>
          <span style={{ flex: 1 }} />
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={rect.w < 0.01}
            onClick={() => {
              store.set((s) => ({ ranges: s.ranges.map((x) => (x.id === range.id ? { ...x, rect } : x)) }));
              onClose();
            }}
          >
            Save box
          </Button>
        </div>
      </div>
    </div>
  );
}
