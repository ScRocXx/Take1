import { useEffect, useMemo, useRef, useState } from 'react';
import { director } from '../engine/director';
import { store, useStore } from '../lib/store';
import { clock } from '../lib/time';
import { guessTitle, toChapters, toCues, toMarkdown, toSocial, toSrt, toVtt } from '../features/packet';
import { Button, CopyButton, Icon, Toggle, download, downloadText } from '../ui/components';

function Printing({ progress, label, err }: { progress: number; label: string; err: string | null }) {
  const deg = Math.round(progress * 360);
  return (
    <main className="wrap printing">
      <div className="ring" style={{ background: `conic-gradient(var(--ink) ${deg}deg, var(--cream-2) ${deg}deg)` }}>
        <div className="ring-inner">
          <svg viewBox="0 0 100 100" className="reel spin" aria-hidden>
            <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="3" />
            <circle cx="50" cy="50" r="8" fill="currentColor" />
            {[0, 120, 240].map((a) => (
              <circle key={a} cx={50 + 22 * Math.cos((a * Math.PI) / 180)} cy={50 + 22 * Math.sin((a * Math.PI) / 180)} r="10" fill="none" stroke="currentColor" strokeWidth="3" />
            ))}
          </svg>
        </div>
      </div>
      <p className="printing-label">{err ? `Something went wrong: ${err}` : `${label} · ${Math.round(progress * 100)}%`}</p>
    </main>
  );
}

export function Wrap() {
  const duration = useStore((s) => s.duration);
  const chapters = useStore((s) => s.chapters);
  const ranges = useStore((s) => s.ranges);
  const outtakes = useStore((s) => s.outtakes);
  const transcript = useStore((s) => s.transcript);
  const captions = useStore((s) => s.captions);
  const title = useStore((s) => s.title);
  const [progress, setProgress] = useState(0);
  const [printing, setPrinting] = useState<string | null>('Printing the master');
  const [master, setMaster] = useState<{ url: string; size: number; burned: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reel, setReel] = useState<{ url: string | null; p: number } | null>(null);
  const lines = useMemo(() => transcript ?? [], [transcript]);
  const started = useRef(false);

  const print = (burn: boolean) => {
    setPrinting(burn ? 'Burning in captions' : 'Printing the master');
    setProgress(0);
    director
      .exportFinal(setProgress, { captions: burn })
      .then((r) => {
        setMaster((m) => {
          if (m) URL.revokeObjectURL(m.url);
          return { url: r.url, size: r.blob.size, burned: burn };
        });
        setPrinting(null);
      })
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!store.get().title) director.setTitle(guessTitle(lines));
    print(false);
  }, []);

  useEffect(() => {
    if (lines.length && (!title || title === 'My Take1 demo')) director.setTitle(guessTitle(lines));
  }, [lines]);

  const holds = ranges.filter((r) => r.kind === 'hold');
  const compressed = holds.reduce((a, r) => a + (r.wall ?? 0) - (r.end - r.start), 0);
  const t = title || 'My Take1 demo';
  const md = toMarkdown({ title: t, lines, chapters, duration, outtakes: outtakes.length, holds: holds.length, compressed });
  const social = toSocial({ title: t, lines, duration, outtakes: outtakes.length });
  const chap = toChapters(chapters, duration);
  const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'take1';
  const cues = toCues(lines);

  const blooper = async () => {
    setReel({ url: null, p: 0 });
    const url = await director.renderOuttakes(
      outtakes.map((o) => o.id),
      (p) => setReel({ url: null, p }),
    );
    setReel({ url, p: 1 });
  };

  if (printing || !master) return <Printing progress={progress} label={printing ?? 'Printing'} err={err} />;

  const capBusy = captions.status === 'downloading' || captions.status === 'transcribing';

  return (
    <main className="wrap">
      <header className="wrap-head">
        <p className="overline">Export</p>
        <h1 className="wrapped-title">That’s a wrap.</h1>
        <p className="lede">
          {clock(duration)} finished, {outtakes.length} fluffed line{outtakes.length === 1 ? '' : 's'} gone, zero minutes in an editor. Saved to your Library.
        </p>
        <label className="title-field">
          <span>Title</span>
          <input value={title} placeholder="Name this take" onChange={(e) => director.setTitle(e.target.value)} />
        </label>
      </header>

      <section className="wrap-grid">
        <article className="card out-card out-video card-fathom">
          <video src={master.url} controls />
          <footer>
            <div>
              <h3>Final cut</h3>
              <span className="small">
                MP4 · {(master.size / 1e6).toFixed(1)} MB · speech levelled to ≈ −16 LUFS{master.burned ? ' · captions burned in' : ''}
              </span>
            </div>
            <Button kind="primary" icon={Icon.down} onClick={() => download(master.url, `${slug}.mp4`)}>
              Download
            </Button>
          </footer>
        </article>

        <article className="card out-card captions-card">
          <h3>Captions</h3>
          {captions.status === 'idle' || (captions.status === 'error' && !lines.length) ? (
            <>
              <p className="muted small">
                Transcribe the final cut on your device (Whisper). The first time, about 80 MB downloads once. Your spoken commands are already muted out.
              </p>
              {captions.status === 'error' && <p className="note note-warn small">{captions.detail}</p>}
              <footer>
                <Button kind="ink" onClick={() => director.transcribe()}>
                  Generate captions
                </Button>
              </footer>
            </>
          ) : capBusy ? (
            <div className="cap-progress">
              <div className="engine-bar wide">
                <i style={{ transform: `scaleX(${captions.status === 'downloading' ? captions.progress : 1})` }} className={captions.status === 'transcribing' ? 'indeterminate' : ''} />
              </div>
              <p className="muted small">
                {captions.status === 'downloading' ? `Downloading the caption model · ${Math.round(captions.progress * 100)}% (first time only)` : 'Listening back to your take…'}
              </p>
            </div>
          ) : (
            <>
              <ol className="cue-list">
                {cues.slice(0, 6).map((c, i) => (
                  <li key={i}>
                    <time>{clock(c.start)}</time>
                    {c.text}
                  </li>
                ))}
                {cues.length > 6 && <li className="muted small">+ {cues.length - 6} more</li>}
              </ol>
              <Toggle
                label="Burn captions into the video"
                hint={master.burned ? 'On. The MP4 above has them.' : 'Re-renders the MP4 with captions drawn in'}
                on={master.burned}
                onChange={(v) => print(v)}
              />
              <footer>
                <Button kind="quiet" icon={Icon.down} onClick={() => downloadText(toSrt(lines), `${slug}.srt`)}>
                  .srt
                </Button>
                <Button kind="quiet" icon={Icon.down} onClick={() => downloadText(toVtt(lines), `${slug}.vtt`)}>
                  .vtt
                </Button>
              </footer>
            </>
          )}
        </article>

        <article className="card out-card">
          <h3>Submission post</h3>
          <pre>{md}</pre>
          <footer>
            <CopyButton text={md} />
            <Button kind="quiet" onClick={() => downloadText(md, `${slug}.md`, 'text/markdown')}>
              .md
            </Button>
          </footer>
        </article>

        <article className="card out-card">
          <h3>Social post</h3>
          <pre>{social}</pre>
          <footer>
            <CopyButton text={social} />
          </footer>
        </article>

        <article className="card out-card">
          <h3>Chapters</h3>
          <pre>{chap}</pre>
          <footer>
            <CopyButton text={chap} label="Copy for YouTube" />
          </footer>
        </article>

        <article className="card out-card out-reel">
          <h3>Blooper reel</h3>
          <p className="muted small">Every outtake, back to back, labelled by take.</p>
          {reel?.url ? (
            <>
              <video src={reel.url} controls />
              <footer>
                <Button kind="quiet" icon={Icon.down} onClick={() => download(reel.url!, `${slug}-bloopers.mp4`)}>
                  Download
                </Button>
              </footer>
            </>
          ) : (
            <footer>
              <Button kind="ghost" onClick={blooper} disabled={!outtakes.length || !!reel}>
                {!outtakes.length ? 'No outtakes. Clean run.' : reel ? `Cutting… ${Math.round(reel.p * 100)}%` : 'Cut the blooper reel'}
              </Button>
            </footer>
          )}
        </article>
      </section>

      <footer className="wrap-foot">
        <Button kind="quiet" onClick={() => store.set({ screen: 'dailies' })}>
          ← Back to Review
        </Button>
        <div className="row">
          <Button kind="ghost" onClick={() => store.set({ screen: 'library' })}>
            Open Library
          </Button>
          <Button kind="primary" onClick={() => director.reset()}>
            Record another
          </Button>
        </div>
      </footer>
    </main>
  );
}
