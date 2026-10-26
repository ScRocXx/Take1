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
  const transcript = useStore((s) => s.transcript);
  const transcribing = useStore((s) => s.transcribing);
  const captions = useStore((s) => s.captions);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [editing, setEditing] = useState<RangeInfo | null>(null);
  const [playing, setPlaying] = useState<{ url: string | null; take: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
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

  const thumbs = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const at = (duration * (i + 0.5)) / 12;
        return { at, url: director.snapAt(at)?.url };
      }),
    [duration],
  );

  const splices = outtakes.map((o) => o.from).filter((f) => f > 0.1 && f < duration);
  const activeRedacts = redacts.filter((r) => t >= r.start && t <= r.end);
  const pct = (x: number) => `${(x / Math.max(duration, 0.01)) * 100}%`;

  const playOuttake = async (id: string, take: number) => {
    setPlaying({ url: null, take });
    const u = await director.renderOuttakes([id]);
    setPlaying({ url: u, take });
  };

  return (
    <main className="dailies">
      <header className="screen-head row-head">
        <div>
          <p className="overline">Review</p>
          <h1>
            Here’s your <em>take.</em>
          </h1>
          <p className="muted explain">
            This is the finished video, with every retake already spliced in. The strip under the player shows where things happened:
            orange ticks are splices, green bands are waits you held, lavender stripes will be blurred. Your fluffed lines are kept below as outtakes.
          </p>
        </div>
        <Button kind="primary" onClick={() => store.set({ screen: 'wrap' })}>
          Export
        </Button>
      </header>

      <div className="stats-panel">
        <div>
          <strong>{clock(duration)}</strong>
          <span>final cut</span>
        </div>
        <div>
          <strong>{outtakes.length}</strong>
          <span>{outtakes.length === 1 ? 'line' : 'lines'} retaken live</span>
        </div>
        <div>
          <strong>{Math.round(saved)} s</strong>
          <span>of waiting squeezed out</span>
        </div>
        <div>
          <strong>0 min</strong>
          <span>in an editor</span>
        </div>
      </div>

      <section className="dailies-grid">
        <div className="player-col">
          <div className="player" style={{ aspectRatio: `${director.comp.W} / ${director.comp.H}` }}>
            {url ? <video ref={video} src={url} controls onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} /> : <div className="splicing">{err ? `Couldn’t build the preview: ${err}` : 'Splicing the tape…'}</div>}
            {activeRedacts.map((r) => (
              <div key={r.id} className="redact-box" style={{ left: `${r.rect!.x * 100}%`, top: `${r.rect!.y * 100}%`, width: `${r.rect!.w * 100}%`, height: `${r.rect!.h * 100}%` }}>
                <span>Blurred on export</span>
              </div>
            ))}
          </div>

          <div
            className="timeline"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              seek(((e.clientX - r.left) / r.width) * duration);
            }}
          >
            <div className="tl-strip">
              {thumbs.map((th, i) => (
                <span key={i} style={{ backgroundImage: th.url ? `url(${th.url})` : undefined }} />
              ))}
            </div>
            {holds.map((r) => (
              <i key={r.id} className="tl-hold" style={{ left: pct(r.start), width: pct(r.end - r.start) }} title={`Held ${Math.round(r.wall ?? 0)} s`} />
            ))}
            {redacts.map((r) => (
              <i key={r.id} className="tl-redact" style={{ left: pct(r.start), width: pct(r.end - r.start) }} />
            ))}
            {splices.map((f, i) => (
              <i key={i} className="tl-splice" style={{ left: pct(f) }} title="Splice" />
            ))}
            {chapters.map((c) => (
              <i key={c.id} className="tl-chapter" style={{ left: pct(c.t) }} title={c.name} />
            ))}
            <i className="tl-head" style={{ left: pct(t) }} />
          </div>
          <div className="legend">
            <span className="lg-splice">Splice</span>
            <span className="lg-hold">Hold</span>
            <span className="lg-redact">Redaction</span>
            <span className="lg-chapter">Chapter</span>
          </div>

          <section className="outtakes">
            <h3>Outtakes</h3>
            <p className="muted small">Every line you retook with “cut”. None of it is in the video. Click one to watch it.</p>
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
                    <p>{o.text ? `“${o.text}”` : 'Tap to watch'}</p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">Clean run. Not one cut.</p>
            )}
          </section>
        </div>

        <aside className="side">
          <div className="card">
            <h3>Transcript</h3>
            <div className="transcript">
              {!transcript && !transcribing && (
                <div className="tr-empty">
                  <p className="muted small">Transcribe the take on your device to get a clickable transcript and captions.</p>
                  <Button kind="ink" onClick={() => director.transcribe()}>
                    Transcribe
                  </Button>
                </div>
              )}
              {transcribing && (
                <div className="cap-progress">
                  <div className="engine-bar wide">
                    <i style={{ transform: `scaleX(${captions.status === 'downloading' ? captions.progress : 1})` }} className={captions.status === 'transcribing' ? 'indeterminate' : ''} />
                  </div>
                  <p className="muted small">{captions.status === 'downloading' ? `Downloading the caption model · ${Math.round(captions.progress * 100)}% (first time only)` : 'Listening back to your take…'}</p>
                </div>
              )}
              {transcript?.map((l, i) => (
                <button key={i} className={t >= l.start && t < l.end ? 'now' : ''} onClick={() => seek(l.start)}>
                  <time>{clock(l.start)}</time>
                  {l.text}
                </button>
              ))}
              {captions.status === 'error' && !transcribing && (
                <div className="tr-empty">
                  <p className="muted small">{captions.detail ?? 'Transcription failed.'}</p>
                  <Button kind="ghost" onClick={() => director.transcribe()}>
                    Try again
                  </Button>
                </div>
              )}
            </div>
          </div>
          <div className="card">
            <h3>Chapters</h3>
            {chapters.length ? (
              chapters.map((c) => (
                <div key={c.id} className="chapter-row">
                  <button onClick={() => seek(c.t)}>{clock(c.t)}</button>
                  <input value={c.name} onChange={(e) => store.set((s) => ({ chapters: s.chapters.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)) }))} />
                </div>
              ))
            ) : (
              <p className="muted small">Say “mark it, live demo” while rolling to drop chapters.</p>
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
                    Adjust
                  </Button>
                  <Button kind="quiet" onClick={() => store.set((s) => ({ ranges: s.ranges.filter((x) => x.id !== r.id) }))}>
                    Remove
                  </Button>
                </div>
              ))
            ) : (
              <p className="muted small">Flashed a key? Say “redact that” right after.</p>
            )}
          </div>
        </aside>
      </section>

      {editing && <RedactEditor range={editing} onClose={() => setEditing(null)} />}
      {playing && (
        <div className="modal" onClick={() => setPlaying(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>Outtake · Take {playing.take}</h2>
              <Button kind="quiet" onClick={() => setPlaying(null)}>
                Close
              </Button>
            </header>
            {playing.url ? <video src={playing.url} controls autoPlay /> : <div className="splicing">Pulling it from the trim bin…</div>}
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
          <h2>Drag over what should be blurred</h2>
        </header>
        <div
          ref={box}
          className="draw"
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
          <div className="draw-rect redact" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />
        </div>
        <div className="draw-bar">
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
