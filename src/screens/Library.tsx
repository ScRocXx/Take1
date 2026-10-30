import { useEffect, useState } from 'react';
import { recorder } from '../engine/recorder';
import { library } from '../lib/library';
import { useStore, type TakeMeta } from '../lib/store';
import { clock } from '../lib/time';
import { toSrt, toVtt } from '../lib/transcript';
import { Button, Icon, download, downloadText, Overlay } from '../ui/components';

const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'recording';
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Every exported recording, stored on this computer. */
export function Library() {
  const takes = useStore((s) => s.library);
  const recording = useStore((s) => s.phase !== 'idle' && s.phase !== 'wrapped');
  const [playing, setPlaying] = useState<{ meta: TakeMeta; url: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [newIds] = useState(() => new Set(takes.filter((t) => !t.seen).map((t) => t.id)));

  useEffect(() => {
    library.markSeen();
  }, []);

  const video = async (id: string) => {
    const v = await library.getVideo(id);
    if (!v) throw new Error('This recording’s video is missing.');
    return v;
  };

  const play = async (m: TakeMeta) => setPlaying({ meta: m, url: URL.createObjectURL(await video(m.id)) });
  const close = () => {
    if (playing) URL.revokeObjectURL(playing.url);
    setPlaying(null);
  };

  const dl = async (m: TakeMeta, kind: 'mp4' | 'srt' | 'vtt') => {
    if (kind === 'mp4') {
      const u = URL.createObjectURL(await video(m.id));
      download(u, `${slugify(m.title)}.mp4`);
      setTimeout(() => URL.revokeObjectURL(u), 5000);
      return;
    }
    const r = await library.getMeta(m.id);
    if (r?.transcript?.length) downloadText(kind === 'srt' ? toSrt(r.transcript) : toVtt(r.transcript), `${slugify(m.title)}.${kind}`);
  };

  return (
    <main className="library">
      <header className="screen-head row-head">
        <div>
          <p className="overline">Library</p>
          <h1>Your recordings</h1>
          <p className="muted">Every export is saved here, on this computer only.</p>
        </div>
        <Button kind="primary" disabled={recording} onClick={() => recorder.reset()}>
          New recording
        </Button>
      </header>

      {takes.length ? (
        <div className="lib-grid">
          {takes.map((t) => (
            <article key={t.id} className={`lib-card ${newIds.has(t.id) ? 'new' : ''}`}>
              <button className="lib-thumb" style={{ backgroundImage: t.thumbUrl ? `url(${t.thumbUrl})` : undefined }} onClick={() => play(t)} aria-label={`Play ${t.title}`}>
                <span className="ot-play">{Icon.play}</span>
                <span className="lib-dur">{clock(t.duration)}</span>
                {newIds.has(t.id) && <span className="lib-new">New</span>}
              </button>
              <input
                className="lib-title"
                title={t.title}
                defaultValue={t.title}
                onBlur={(e) => e.target.value !== t.title && library.update(t.id, { title: e.target.value || 'Untitled recording' })}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <p className="lib-meta">
                {when(t.createdAt)} · {t.retakes} redone · {(t.size / 1e6).toFixed(1)} MB
                {t.captionsBurned ? ' · captions drawn in' : t.hasCaptions ? ' · captions' : ''}
              </p>
              <footer>
                <Button kind="ghost" icon={Icon.down} onClick={() => dl(t, 'mp4')}>
                  MP4
                </Button>
                {t.hasCaptions && (
                  <>
                    <Button kind="quiet" onClick={() => dl(t, 'srt')}>
                      .srt
                    </Button>
                    <Button kind="quiet" onClick={() => dl(t, 'vtt')}>
                      .vtt
                    </Button>
                  </>
                )}
                <span style={{ flex: 1 }} />
                {confirm === t.id ? (
                  <>
                    <Button kind="quiet" onClick={() => setConfirm(null)}>
                      Keep
                    </Button>
                    <Button kind="ink" onClick={() => library.remove(t.id).then(() => setConfirm(null))}>
                      Delete
                    </Button>
                  </>
                ) : (
                  <Button kind="quiet" onClick={() => setConfirm(t.id)}>
                    Delete
                  </Button>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <p className="empty-title">No recordings yet</p>
          <p className="muted">Record something and export it. It will show up here, ready to download again any time.</p>
        </div>
      )}

      {playing && (
        <Overlay onClose={close}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>{playing.meta.title}</h2>
              <Button kind="quiet" onClick={close}>
                Close
              </Button>
            </header>
            <video src={playing.url} controls autoPlay />
          </div>
        </Overlay>
      )}
    </main>
  );
}
