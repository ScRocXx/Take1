import { useState } from 'react';
import { library } from '../lib/library';
import { store, useStore, type TakeMeta } from '../lib/store';
import { clock } from '../lib/time';
import { toSrt, toVtt } from '../features/packet';
import { Button, Icon, download, downloadText } from '../ui/components';

const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'take1';
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Every exported take, stored on this computer. */
export function Library() {
  const takes = useStore((s) => s.library);
  const recording = useStore((s) => s.phase !== 'idle' && s.phase !== 'wrapped');
  const [playing, setPlaying] = useState<{ meta: TakeMeta; url: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const play = async (m: TakeMeta) => {
    const r = await library.get(m.id);
    if (r) setPlaying({ meta: m, url: URL.createObjectURL(r.video) });
  };

  const dl = async (m: TakeMeta, kind: 'mp4' | 'srt' | 'vtt') => {
    const r = await library.get(m.id);
    if (!r) return;
    if (kind === 'mp4') {
      const u = URL.createObjectURL(r.video);
      download(u, `${slugify(r.title)}.mp4`);
      setTimeout(() => URL.revokeObjectURL(u), 5000);
    } else if (r.transcript?.length) downloadText(kind === 'srt' ? toSrt(r.transcript) : toVtt(r.transcript), `${slugify(r.title)}.${kind}`);
  };

  return (
    <main className="library">
      <header className="screen-head row-head">
        <div>
          <p className="overline">Library</p>
          <h1>
            Your <em>takes.</em>
          </h1>
          <p className="muted">Every take you export is saved here, on this computer only.</p>
        </div>
        <Button kind="primary" disabled={recording} onClick={() => store.set({ screen: store.get().micOn ? 'stage' : 'greenroom' })}>
          New recording
        </Button>
      </header>

      {takes.length ? (
        <div className="lib-grid">
          {takes.map((t) => (
            <article key={t.id} className="lib-card">
              <button className="lib-thumb" style={{ backgroundImage: t.thumbUrl ? `url(${t.thumbUrl})` : undefined }} onClick={() => play(t)} aria-label={`Play ${t.title}`}>
                <span className="ot-play">{Icon.play}</span>
                <span className="lib-dur">{clock(t.duration)}</span>
              </button>
              <input
                className="lib-title"
                title={t.title}
                defaultValue={t.title}
                onBlur={(e) => e.target.value !== t.title && library.update(t.id, { title: e.target.value || 'Untitled take' })}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <p className="lib-meta">
                {when(t.createdAt)} · {t.retakes} retake{t.retakes === 1 ? '' : 's'} · {(t.size / 1e6).toFixed(1)} MB
                {t.captionsBurned ? ' · captions burned in' : t.hasCaptions ? ' · captions' : ''}
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
          <p className="empty-title">Nothing on the shelf yet.</p>
          <p className="muted">Record a take and export it. It will show up here, ready to download again any time.</p>
        </div>
      )}

      {playing && (
        <div className="modal" onClick={() => (URL.revokeObjectURL(playing.url), setPlaying(null))}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>{playing.meta.title}</h2>
              <Button kind="quiet" onClick={() => (URL.revokeObjectURL(playing.url), setPlaying(null))}>
                Close
              </Button>
            </header>
            <video src={playing.url} controls autoPlay />
          </div>
        </div>
      )}
    </main>
  );
}
