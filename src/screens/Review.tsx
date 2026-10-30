import { useEffect, useMemo, useRef, useState } from 'react';
import { recorder } from '../engine/recorder';
import { store, useStore, type RangeInfo, type Rect } from '../lib/store';
import { clock } from '../lib/time';
import { youtubeChapterProblem } from '../lib/transcript';
import { Button, Icon, useDrawBox, Overlay } from '../ui/components';

export function Review() {
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
  const sped = ranges.filter((r) => r.kind === 'hold');
  const blurs = ranges.filter((r) => r.kind === 'redact');
  const saved = sped.reduce((a, r) => a + (r.wall ?? 0) - (r.end - r.start), 0);

  useEffect(() => {
    recorder
      .previewMp4()
      .then(setUrl)
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  const seek = (s: number) => {
    if (video.current) video.current.currentTime = s;
    setT(s);
  };

  const thumbs = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const at = (duration * (i + 0.5)) / 12;
        return { at, url: recorder.snapAt(at)?.url };
      }),
    [duration],
  );

  const splices = outtakes.map((o) => o.from).filter((f) => f > 0.1 && f < duration);
  const activeBlurs = blurs.filter((r) => t >= r.start && t <= r.end);
  const pct = (x: number) => `${(Math.min(x, duration) / Math.max(duration, 0.01)) * 100}%`;

  const playOuttake = async (id: string, take: number) => {
    setPlaying({ url: null, take });
    setPlaying({ url: await recorder.renderOuttakes([id]), take });
  };

  return (
    <main className="review">
      <header className="screen-head row-head">
        <div>
          <p className="overline">Review</p>
          <h1>Your recording</h1>
          <p className="muted explain">
            This is the finished video with your redone sentences already joined. The strip under the player shows where: orange marks are joins, green
            bands were sped up, lavender bands will be blurred.
          </p>
        </div>
        <Button kind="primary" onClick={() => store.set({ screen: 'export' })}>
          Export
        </Button>
      </header>

      <div className="stats-panel">
        <div>
          <strong>{clock(duration)}</strong>
          <span>long</span>
        </div>
        <div>
          <strong>{outtakes.length}</strong>
          <span>{outtakes.length === 1 ? 'sentence redone' : 'sentences redone'}</span>
        </div>
        <div>
          <strong>{Math.round(saved)} s</strong>
          <span>of waiting sped up</span>
        </div>
        <div>
          <strong>{chapters.length}</strong>
          <span>{chapters.length === 1 ? 'chapter' : 'chapters'}</span>
        </div>
      </div>

      <section className="review-grid">
        <div className="player-col">
          <div className="player" style={{ aspectRatio: `${recorder.comp.W} / ${recorder.comp.H}` }}>
            {url ? <video ref={video} src={url} controls onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} /> : <div className="splicing">{err ? `Couldn’t build the preview: ${err}` : 'Joining your takes…'}</div>}
            {activeBlurs.map((r) => (
              <div key={r.id} className="blur-box" style={{ left: `${r.rect!.x * 100}%`, top: `${r.rect!.y * 100}%`, width: `${r.rect!.w * 100}%`, height: `${r.rect!.h * 100}%` }} />
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
            {sped.map((r) => (
              <i key={r.id} className="tl-hold" style={{ left: pct(r.start), width: pct(r.end - r.start) }} title={`${Math.round(r.wall ?? 0)} s at ${r.factor ?? 4}×`} />
            ))}
            {blurs.map((r) => (
              <i key={r.id} className="tl-redact" style={{ left: pct(r.start), width: pct(r.end - r.start) }} />
            ))}
            {splices.map((f, i) => (
              <i key={i} className="tl-splice" style={{ left: pct(f) }} title="Join" />
            ))}
            {chapters.map((c) => (
              <i key={c.id} className="tl-chapter" style={{ left: pct(c.t) }} title={c.name} />
            ))}
            <i className="tl-head" style={{ left: pct(t) }} />
          </div>
          <div className="legend">
            <span className="lg-splice">Join</span>
            <span className="lg-hold">Sped up</span>
            <span className="lg-redact">Blurred</span>
            <span className="lg-chapter">Chapter</span>
          </div>

          <section className="outtakes">
            <h3>Sentences you redid</h3>
            <p className="muted small">None of these are in the video. Click one to watch it.</p>
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
                    <p>{o.text ? `“${o.text}”` : 'Click to watch'}</p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">None. Recorded in one go.</p>
            )}
          </section>
        </div>

        <aside className="side">
          <TranscriptCard t={t} seek={seek} />
          <ChaptersCard t={t} seek={seek} />
          <div className="card">
            <h3>Blurs</h3>
            {blurs.length ? (
              blurs.map((r) => (
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
              <p className="muted small">Showed something private? Say “blur that” while recording and drag over it.</p>
            )}
          </div>
        </aside>
      </section>

      {editing && <BlurEditor range={editing} onClose={() => setEditing(null)} />}
      {playing && (
        <Overlay onClose={() => setPlaying(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>Take {playing.take} (removed)</h2>
              <Button kind="quiet" onClick={() => setPlaying(null)}>
                Close
              </Button>
            </header>
            {playing.url ? <video src={playing.url} controls autoPlay /> : <div className="splicing">Loading…</div>}
          </div>
        </Overlay>
      )}
    </main>
  );
}

function TranscriptCard({ t, seek }: { t: number; seek: (s: number) => void }) {
  const transcript = useStore((s) => s.transcript);
  const transcribing = useStore((s) => s.transcribing);
  const captions = useStore((s) => s.captions);
  return (
    <div className="card">
      <h3>Transcript</h3>
      <div className="transcript">
        {!transcript && !transcribing && captions.status !== 'error' && (
          <div className="tr-empty">
            <p className="muted small">Transcribe on this computer to get a clickable transcript, captions and suggested chapters.</p>
            <Button kind="ink" onClick={() => recorder.transcribe()}>
              Transcribe
            </Button>
          </div>
        )}
        {transcribing && <TranscribeProgress />}
        {transcript?.map((l, i) => (
          <button key={i} className={t >= l.start && t < l.end ? 'now' : ''} onClick={() => seek(l.start)}>
            <time>{clock(l.start)}</time>
            {l.text}
          </button>
        ))}
        {captions.status === 'error' && !transcribing && (
          <div className="tr-empty">
            <p className="muted small">{captions.detail ?? 'Transcription failed.'}</p>
            <Button kind="ghost" onClick={() => recorder.transcribe()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function TranscribeProgress() {
  const captions = useStore((s) => s.captions);
  const down = captions.status === 'downloading';
  return (
    <div className="cap-progress">
      <div className="engine-bar wide">
        <i style={{ transform: `scaleX(${Math.max(0.03, captions.progress)})` }} />
      </div>
      <p className="muted small">{down ? `Downloading the transcription model · ${Math.round(captions.progress * 100)}% (first time only)` : `Transcribing · ${Math.round(captions.progress * 100)}%`}</p>
    </div>
  );
}

/** Chapters: shown on the timeline, embedded in the MP4, and pasted into YouTube descriptions. */
export function ChaptersCard({ t, seek }: { t?: number; seek?: (s: number) => void }) {
  const chapters = useStore((s) => s.chapters);
  const transcript = useStore((s) => s.transcript);
  const duration = useStore((s) => s.duration);
  const problem = chapters.length ? youtubeChapterProblem(chapters, duration) : null;
  const rename = (id: string, name: string) => store.set((s) => ({ chapters: s.chapters.map((x) => (x.id === id ? { ...x, name, auto: false } : x)) }));
  const remove = (id: string) => store.set((s) => ({ chapters: s.chapters.filter((x) => x.id !== id) }));
  return (
    <div className="card chapters-card">
      <h3>Chapters</h3>
      {chapters.length ? (
        <div className="chapter-list">
          {chapters.map((c) => (
            <div key={c.id} className="chapter-row">
              <button onClick={() => seek?.(c.t)} title="Jump here">
                {clock(c.t)}
              </button>
              <input value={c.name} onChange={(e) => rename(c.id, e.target.value)} placeholder="Chapter name" />
              <button className="x" onClick={() => remove(c.id)} aria-label="Remove chapter">
                {Icon.x}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">Say “chapter: setup” while recording, add one here, or let Take1 suggest them from the transcript.</p>
      )}
      {chapters.some((c) => c.auto) && <p className="muted small">Suggested from your transcript. Rename or remove any.</p>}
      {problem && <p className="note note-warn small">{problem}</p>}
      <div className="row">
        {t !== undefined && (
          <Button kind="ghost" icon={Icon.plus} onClick={() => recorder.addChapterAt(t)}>
            Add at {clock(t)}
          </Button>
        )}
        {transcript?.length ? (
          <Button kind="quiet" onClick={() => recorder.suggestChapters()}>
            Suggest from transcript
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function BlurEditor({ range, onClose }: { range: RangeInfo; onClose: () => void }) {
  const snap = recorder.snapAt(range.start + 0.5);
  const { rect, setRect, handlers } = useDrawBox(range.rect ?? { x: 0, y: 0, w: 1, h: 1 });
  return (
    <Overlay onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Drag over what should be blurred</h2>
        </header>
        <div className="draw" style={{ aspectRatio: `${recorder.comp.W} / ${recorder.comp.H}` }} {...handlers}>
          {snap && <img src={snap.url} alt="" draggable={false} />}
          {rect && <div className="draw-rect redact" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />}
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
            disabled={!rect || rect.w < 0.01}
            onClick={() => {
              store.set((s) => ({ ranges: s.ranges.map((x) => (x.id === range.id ? { ...x, rect: rect as Rect } : x)) }));
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
