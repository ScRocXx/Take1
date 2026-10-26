import { useEffect, useMemo, useState } from 'react';
import { director } from '../engine/director';
import { store, useStore } from '../lib/store';
import { clock } from '../lib/time';
import { guessTitle, toChapters, toMarkdown, toSocial, toSrt } from '../features/packet';
import { Button, CopyButton, Icon, download, downloadText } from '../ui/components';

export function Wrap() {
  const duration = useStore((s) => s.duration);
  const chapters = useStore((s) => s.chapters);
  const ranges = useStore((s) => s.ranges);
  const outtakes = useStore((s) => s.outtakes);
  const [progress, setProgress] = useState(0);
  const [master, setMaster] = useState<{ url: string; size: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reel, setReel] = useState<{ url: string | null; p: number } | null>(null);
  const lines = useMemo(() => director.transcript(), [duration]);
  const [title, setTitle] = useState(() => guessTitle(lines));

  useEffect(() => {
    director
      .exportFinal(setProgress)
      .then((r) => setMaster({ url: r.url, size: r.blob.size }))
      .catch((e) => setErr(String(e)));
  }, []);

  const holds = ranges.filter((r) => r.kind === 'hold');
  const compressed = holds.reduce((a, r) => a + (r.wall ?? 0) - (r.end - r.start), 0);
  const md = toMarkdown({ title, lines, chapters, duration, outtakes: outtakes.length, holds: holds.length, compressed });
  const social = toSocial({ title, lines, duration, outtakes: outtakes.length });
  const srt = toSrt(lines);
  const chap = toChapters(chapters, duration);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'take1';

  const blooper = async () => {
    setReel({ url: null, p: 0 });
    const url = await director.renderOuttakes(
      outtakes.map((o) => o.id),
      (p) => setReel({ url: null, p }),
    );
    setReel({ url, p: 1 });
  };

  if (!master) {
    const deg = Math.round(progress * 360);
    return (
      <main className="wrap printing">
        <div className="ring" style={{ background: `conic-gradient(var(--tally) ${deg}deg, var(--panel-2) ${deg}deg)` }}>
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
        <p className="printing-label">{err ? `Something went wrong: ${err}` : `Printing the master · ${Math.round(progress * 100)}%`}</p>
      </main>
    );
  }

  return (
    <main className="wrap">
      <header className="wrap-head">
        <h1 className="wrapped-title">That’s a wrap.</h1>
        <p className="lede">
          {clock(duration)} finished, {outtakes.length} fluffed line{outtakes.length === 1 ? '' : 's'} gone, zero minutes in an editor.
        </p>
        <label className="title-field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </header>

      <section className="wrap-grid">
        <article className="card out-card out-video">
          <video src={master.url} controls />
          <footer>
            <div>
              <h3>Final cut</h3>
              <span className="fine">MP4 · {(master.size / 1e6).toFixed(1)} MB · speech levelled to ≈ −16 LUFS</span>
            </div>
            <Button kind="primary" icon={Icon.down} onClick={() => download(master.url, `${slug}.mp4`)}>
              Download
            </Button>
          </footer>
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

        <article className="card out-card">
          <h3>Captions</h3>
          <pre>{srt.split('\n').slice(0, 12).join('\n') || 'No narration transcribed.'}</pre>
          <footer>
            <Button kind="quiet" icon={Icon.down} onClick={() => downloadText(srt, `${slug}.srt`)} disabled={!srt}>
              .srt
            </Button>
          </footer>
        </article>

        <article className="card out-card out-reel">
          <h3>Blooper reel</h3>
          <p className="fine">Every outtake, back to back, labelled by take. Your most honest content.</p>
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
                {!outtakes.length ? 'No outtakes. Show-off.' : reel ? `Cutting… ${Math.round(reel.p * 100)}%` : 'Cut the blooper reel'}
              </Button>
            </footer>
          )}
        </article>
      </section>

      <footer className="wrap-foot">
        <Button kind="quiet" onClick={() => store.set({ screen: 'dailies' })}>
          ← Back to Dailies
        </Button>
        <Button kind="ghost" onClick={() => director.reset()}>
          Record another
        </Button>
      </footer>
    </main>
  );
}
