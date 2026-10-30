import { useEffect, useMemo, useRef, useState } from 'react';
import { recorder } from '../engine/recorder';
import { native } from '../lib/native';
import { store, useStore } from '../lib/store';
import { clock } from '../lib/time';
import { chapterList, guessTitle, toCues, toSrt, toVtt, youtubeChapterProblem } from '../lib/transcript';
import {
  canShareFile,
  chooseFolder,
  folderSupported,
  googleConfig,
  googleSignOut,
  savedFolder,
  saveToFolder,
  setGoogleConfig,
  uploadByHand,
  uploadToDrive,
  uploadToYouTube,
} from '../lib/share';
import { Button, CopyButton, Icon, download, downloadText, Overlay } from '../ui/components';
import { ChaptersCard, TranscribeProgress } from './Review';
import { CaptionDesigner } from './CaptionDesigner';
import { FONTS, PRESETS, loadStyle, type CaptionStyle } from '../lib/captions';

function Progress({ progress, label, err }: { progress: number; label: string; err: string | null }) {
  const deg = Math.round(progress * 360);
  return (
    <main className="export printing">
      <div className="ring" style={{ background: `conic-gradient(var(--ink) ${deg}deg, var(--cream-2) ${deg}deg)` }}>
        <div className="ring-inner">
          <span className="ring-pct">{Math.round(progress * 100)}%</span>
        </div>
      </div>
      <p className="printing-label">{err ? `Something went wrong: ${err}` : label}</p>
      {err && (
        <Button kind="ghost" onClick={() => store.set({ screen: 'review' })}>
          Back to Review
        </Button>
      )}
    </main>
  );
}

const AUTOSAVE = 'take1.autosave';
const readAutosave = () => {
  try {
    return localStorage.getItem(AUTOSAVE) === '1';
  } catch {
    return false;
  }
};

export function Export() {
  const duration = useStore((s) => s.duration);
  const outtakes = useStore((s) => s.outtakes.length);
  const transcript = useStore((s) => s.transcript);
  const captions = useStore((s) => s.captions);
  const chapters = useStore((s) => s.chapters);
  const title = useStore((s) => s.title);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState<string | null>('Exporting');
  const [file, setFile] = useState<{ url: string; blob: Blob; burned: CaptionStyle | null } | null>(null);
  // the export without captions, for the caption preview
  const [plain, setPlain] = useState<Blob | null>(null);
  const [capStyle, setCapStyle] = useState<CaptionStyle>(loadStyle);
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(false);
  const lines = useMemo(() => transcript ?? [], [transcript]);

  const build = (burn: CaptionStyle | null) => {
    setBusy(burn ? 'Drawing captions into the video' : 'Exporting');
    setProgress(0);
    setErr(null);
    recorder
      .exportFinal(setProgress, { captions: burn })
      .then(async (r) => {
        setFile((f) => {
          if (f) URL.revokeObjectURL(f.url);
          return { url: r.url, blob: r.blob, burned: burn };
        });
        if (!burn) setPlain(r.blob);
        setBusy(null);
        // an unchanged export was already saved there the first time
        if (!r.cached && readAutosave() && (await savedFolder())) autoSave(r.blob).catch(() => {});
      })
      .catch((e) => setErr(String(e?.message ?? e)));
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!store.get().title && lines.length) recorder.setTitle(guessTitle(lines));
    build(null);
  }, []);

  useEffect(() => {
    if (lines.length && !store.get().title) recorder.setTitle(guessTitle(lines));
  }, [lines]);

  const name = (title || 'recording').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'recording';
  const autoSave = async (blob: Blob) => {
    const files: { name: string; data: Blob | string }[] = [{ name: `${name}.mp4`, data: blob }];
    if (lines.length) files.push({ name: `${name}.srt`, data: toSrt(lines) });
    const where = await saveToFolder(files);
    store.set({ toast: { id: Date.now(), text: `Saved to ${where}`, tone: 'ok' } });
  };

  if (busy || !file) return <Progress progress={progress} label={`${busy ?? 'Exporting'} · ${Math.round(progress * 100)}%`} err={err} />;

  const capBusy = captions.status === 'downloading' || captions.status === 'transcribing';
  const cues = toCues(lines);
  const ytProblem = youtubeChapterProblem(chapters, duration);

  return (
    <main className="export">
      <header className="export-head">
        <p className="overline">Export</p>
        <h1>Your video is ready</h1>
        <p className="lede">
          {clock(duration)} long{outtakes ? `, ${outtakes} sentence${outtakes === 1 ? '' : 's'} redone while recording` : ''}. It’s saved in your Library.
        </p>
        <label className="title-field">
          <span>Title</span>
          <input value={title} placeholder="Name this recording" onChange={(e) => recorder.setTitle(e.target.value)} />
        </label>
      </header>

      <section className="export-grid">
        <article className="card out-card out-video card-fathom">
          <video src={file.url} controls />
          <footer>
            <div>
              <h3>{title || 'Your recording'}.mp4</h3>
              <span className="small">
                {(file.blob.size / 1e6).toFixed(1)} MB · speech levelled{file.burned ? ' · captions drawn in' : ''}
                {chapters.length ? ' · chapters included' : ''}
              </span>
            </div>
            <Button kind="primary" icon={Icon.down} onClick={() => download(file.url, `${name}.mp4`)}>
              Download
            </Button>
          </footer>
        </article>

        <SendCard blob={file.blob} name={name} title={title || 'Recording'} srt={lines.length ? toSrt(lines) : null} chapters={ytProblem ? '' : chapterList(chapters, duration)} />

        <article className="card out-card captions-card">
          <h3>Captions</h3>
          {captions.status === 'idle' || (captions.status === 'error' && !lines.length) ? (
            <>
              <p className="muted small">Transcribe on this computer (Whisper). The first time, about 80 MB downloads once. Your spoken commands are already removed.</p>
              {captions.status === 'error' && <p className="note note-warn small">{captions.detail}</p>}
              <footer>
                <Button kind="ink" onClick={() => recorder.transcribe()}>
                  Generate captions
                </Button>
              </footer>
            </>
          ) : capBusy ? (
            <TranscribeProgress />
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
              <p className="small cap-status">
                {file.burned ? `Drawn into the MP4 · ${PRESETS.find((p) => p.id === file.burned!.preset)?.label ?? 'Custom'} style, ${FONTS[file.burned.font].label}` : 'Not drawn into the video yet.'}{' '}
                <a href="#caption-style" onClick={(e) => { e.preventDefault(); document.getElementById('caption-style')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
                  {file.burned ? 'Change style' : 'Choose a style'}
                </a>
              </p>
              <footer>
                <Button kind="quiet" icon={Icon.down} onClick={() => downloadText(toSrt(lines), `${name}.srt`)}>
                  .srt
                </Button>
                <Button kind="quiet" icon={Icon.down} onClick={() => downloadText(toVtt(lines), `${name}.vtt`)}>
                  .vtt
                </Button>
              </footer>
            </>
          )}
        </article>

        <div className="out-card chapters-out">
          <ChaptersCard />
          {chapters.length > 0 && (
            <div className="card yt-chapters">
              <h3>For YouTube</h3>
              <pre>{chapterList(chapters, duration)}</pre>
              <p className="muted small">
                Paste into a YouTube description and it turns these into chapters (uploading from here does it for you). Re-export after editing to update the ones inside the MP4.
              </p>
              <footer>
                <CopyButton text={chapterList(chapters, duration)} label="Copy chapters" />
                <Button kind="quiet" onClick={() => build(file.burned)}>
                  Re-export with these
                </Button>
              </footer>
            </div>
          )}
        </div>
      </section>

      {lines.length > 0 && !capBusy && plain && (
        <CaptionDesigner
          lines={lines}
          plain={plain}
          width={recorder.comp.W}
          height={recorder.comp.H}
          style={capStyle}
          onChange={setCapStyle}
          applied={file.burned}
          busy={!!busy}
          onApply={() => build(capStyle)}
          onRemove={() => build(null)}
        />
      )}

      <footer className="export-foot">
        <Button kind="quiet" onClick={() => store.set({ screen: 'review' })}>
          ← Back to Review
        </Button>
        <div className="row">
          <Button kind="ghost" onClick={() => store.set({ screen: 'library' })}>
            Open Library
          </Button>
          <Button kind="primary" onClick={() => recorder.reset()}>
            New recording
          </Button>
        </div>
      </footer>
    </main>
  );
}

type Job = { state: 'idle' | 'busy' | 'done' | 'error'; p: number; msg?: string; link?: string };
const idle: Job = { state: 'idle', p: 0 };

/** Where the file goes next: a folder on this computer, YouTube, Google Drive, or the share sheet. */
function SendCard({ blob, name, title, srt, chapters }: { blob: Blob; name: string; title: string; srt: string | null; chapters: string }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [autosave, setAutosave] = useState(readAutosave());
  const [save, setSave] = useState<Job>(idle);
  const [yt, setYt] = useState<Job>(idle);
  const [drive, setDrive] = useState<Job>(idle);
  const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('unlisted');
  const [ytCaptions, setYtCaptions] = useState(true);
  const [cfg, setCfg] = useState(googleConfig());
  const [setup, setSetup] = useState<false | 'youtube' | 'drive' | 'account'>(false);
  const fileObj = useMemo(() => new File([blob], `${name}.mp4`, { type: 'video/mp4' }), [blob, name]);

  useEffect(() => {
    savedFolder().then((h) => setFolder(h?.name ?? null));
  }, []);

  const run = async (set: (j: Job) => void, fn: (p: (x: number) => void) => Promise<string | void>) => {
    set({ state: 'busy', p: 0 });
    try {
      const link = await fn((p) => set({ state: 'busy', p }));
      set({ state: 'done', p: 1, link: link || undefined });
      setCfg(googleConfig());
    } catch (e) {
      set({ state: 'error', p: 0, msg: String((e as Error)?.message ?? e) });
    }
  };

  const toFolder = () =>
    run(setSave, async () => {
      const files: { name: string; data: Blob | string }[] = [{ name: `${name}.mp4`, data: blob }];
      if (srt) files.push({ name: `${name}.srt`, data: srt });
      const where = await saveToFolder(files);
      setFolder(where);
      return '';
    });

  const description = [title, chapters && `\n${chapters}`].filter(Boolean).join('\n');

  return (
    <article className="card out-card send-card">
      <h3>Send it somewhere</h3>

      {folderSupported() && (
        <div className="send-row">
          <span className="send-ico">{Icon.folder}</span>
          <div className="send-text">
            <strong>Save to a folder</strong>
            <small>{folder ? `In “${folder}”` : 'Pick a folder once; Take1 remembers it'}</small>
            <JobLine job={save} done="Saved" />
          </div>
          <div className="send-actions">
            {folder && (
              <Button
                kind="quiet"
                onClick={async () => {
                  const h = await chooseFolder().catch(() => null);
                  if (h) setFolder(h.name);
                }}
              >
                Change
              </Button>
            )}
            <Button kind="ghost" disabled={save.state === 'busy'} onClick={toFolder}>
              Save
            </Button>
          </div>
          {folder && (
            <label className="send-auto">
              <input
                type="checkbox"
                checked={autosave}
                onChange={(e) => {
                  setAutosave(e.target.checked);
                  try {
                    localStorage.setItem(AUTOSAVE, e.target.checked ? '1' : '0');
                  } catch {
                    /* private mode */
                  }
                }}
              />
              Save every export here automatically
            </label>
          )}
        </div>
      )}

      <div className="send-row">
        <span className="send-ico">{Icon.youtube}</span>
        <div className="send-text">
          <strong>Upload to YouTube</strong>
          <small>{chapters ? 'Chapters go in the description' : 'Title from above'}{srt ? ', captions as a subtitle track' : ''}</small>
          <JobLine job={yt} done="Uploaded" />
          {cfg?.clientId && !cfg.builtIn && privacy !== 'private' && (
            <small className="muted">YouTube keeps uploads from a personal Google project private until the project passes its review; change it in YouTube Studio.</small>
          )}
        </div>
        <div className="send-actions">
          <select value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)} aria-label="Visibility">
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
          <Button
            kind="ghost"
            disabled={yt.state === 'busy'}
            onClick={() => (cfg?.clientId ? run(setYt, (p) => uploadToYouTube(blob, { title, description, privacy, captionsSrt: ytCaptions && srt ? srt : undefined }, p)) : setSetup('youtube'))}
          >
            Upload
          </Button>
        </div>
        {srt && (
          <label className="send-auto">
            <input type="checkbox" checked={ytCaptions} onChange={(e) => setYtCaptions(e.target.checked)} />
            Add the captions as a subtitle track
          </label>
        )}
      </div>

      <div className="send-row">
        <span className="send-ico">{Icon.drive}</span>
        <div className="send-text">
          <strong>Upload to Google Drive</strong>
          <small>The MP4{srt ? ' and its .srt' : ''}, in your Drive</small>
          <JobLine job={drive} done="Uploaded" />
        </div>
        <div className="send-actions">
          <Button
            kind="ghost"
            disabled={drive.state === 'busy'}
            onClick={() =>
              cfg?.clientId ? run(setDrive, (p) => uploadToDrive(blob, `${name}.mp4`, srt ? [{ name: `${name}.srt`, text: srt, type: 'application/x-subrip' }] : [], p)) : setSetup('drive')
            }
          >
            Upload
          </Button>
        </div>
      </div>

      {canShareFile(fileObj) && (
        <div className="send-row">
          <span className="send-ico">{Icon.share}</span>
          <div className="send-text">
            <strong>Share</strong>
            <small>Your system’s share sheet (mail, chat apps…)</small>
          </div>
          <div className="send-actions">
            <Button kind="ghost" onClick={() => navigator.share({ files: [fileObj], title }).catch(() => {})}>
              Share
            </Button>
          </div>
        </div>
      )}

      <div className="google-acct">
        {cfg?.clientId ? (
          <>
            <span>
              Google: {cfg.email ? <strong>{cfg.email}</strong> : 'not signed in yet (you’ll be asked on first upload)'}
            </span>
            {cfg.email && (
              <button
                className="link-btn"
                onClick={async () => {
                  await googleSignOut();
                  setCfg(googleConfig());
                }}
              >
                Sign out
              </button>
            )}
            {!cfg.builtIn && (
              <button className="link-btn" onClick={() => setSetup('account')}>
                Change client ID
              </button>
            )}
          </>
        ) : (
          <>
            <span>To upload straight from Take1, connect Google once (free). Or press Upload to do it by hand.</span>
            <button className="link-btn" onClick={() => setSetup('account')}>
              Connect Google
            </button>
          </>
        )}
      </div>
      {setup && (
        <GoogleSetup
          target={setup === 'account' ? null : setup}
          onByHand={async () => {
            const where = setup === 'drive' ? 'drive' : 'youtube';
            setSetup(false);
            const copied = await uploadByHand(where, fileObj, where === 'youtube' ? description : '');
            const set = where === 'youtube' ? setYt : setDrive;
            set({
              state: 'done',
              p: 1,
              msg:
                where === 'youtube'
                  ? `Saved ${name}.mp4 and opened YouTube. Drag the file in${copied ? '; the title and description are on your clipboard' : ''}.`
                  : `Saved ${name}.mp4 and opened Drive. Drag the file in.`,
            });
          }}
          onClose={() => {
            setSetup(false);
            setCfg(googleConfig());
          }}
        />
      )}
    </article>
  );
}

function JobLine({ job, done }: { job: Job; done: string }) {
  if (job.state === 'idle') return null;
  if (job.state === 'busy' && job.p === 0)
    return <span className="job busy">{native ? 'Finish signing in to Google in your browser…' : 'Signing in to Google…'}</span>;
  if (job.state === 'busy')
    return (
      <span className="job busy">
        <span className="engine-bar">
          <i style={{ transform: `scaleX(${Math.max(0.03, job.p)})` }} />
        </span>
        {Math.round(job.p * 100)}%
      </span>
    );
  if (job.state === 'error') return <span className="job err">{job.msg}</span>;
  return (
    <span className="job ok">
      {Icon.check} {job.msg ?? done}
      {job.link && (
        <a href={job.link} target="_blank" rel="noreferrer">
          {Icon.link} Open
        </a>
      )}
    </span>
  );
}

const CLIENT_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

function GoogleSetup({ target, onByHand, onClose }: { target: 'youtube' | 'drive' | null; onByHand: () => void; onClose: () => void }) {
  const cur = googleConfig();
  const [id, setId] = useState(cur?.builtIn ? '' : (cur?.clientId ?? ''));
  const [secret, setSecret] = useState(cur?.builtIn ? '' : (cur?.clientSecret ?? ''));
  const [open, setOpen] = useState(!target);
  const origin = location.origin;
  const place = target === 'drive' ? 'Google Drive' : 'YouTube';
  return (
    <Overlay onClose={onClose}>
      <div className="modal-card google-setup" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{target ? `Upload to ${place}` : 'Connect YouTube and Google Drive'}</h2>
        </header>

        {target && (
          <section className="gs-quick">
            <h4>Right now, no setup</h4>
            <p className="small">
              Take1 saves <strong>the MP4</strong>
              {target === 'youtube' ? ', copies the title and description (with chapters)' : ''} and opens {place}. Drag the file into that tab.
            </p>
            <Button kind="primary" onClick={onByHand}>
              Save the file and open {place}
            </Button>
          </section>
        )}

        <section className="gs-connect">
          <button className="gs-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span>
              <h4>{target ? 'Or upload straight from Take1 next time' : 'Upload straight from Take1'}</h4>
              <small className="muted">A one-time Google setup, free, about 5 minutes. After that it’s one click{target === 'youtube' ? ', with chapters and captions added for you' : ''}.</small>
            </span>
            <i>{open ? '−' : '+'}</i>
          </button>
          {open && (
            <>
              <ol className="setup-steps">
                <li>
                  In Google Cloud, enable the{' '}
                  <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer">
                    YouTube Data API v3
                  </a>{' '}
                  and the{' '}
                  <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">
                    Google Drive API
                  </a>{' '}
                  (create a project if it asks).
                </li>
                <li>
                  Set up the{' '}
                  <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">
                    consent screen
                  </a>{' '}
                  (External), and under <em>Audience</em> add your own Google account as a <strong>test user</strong>.
                </li>
                <li>
                  <a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noreferrer">
                    Create an OAuth client
                  </a>
                  :{' '}
                  {native ? (
                    <>
                      type <strong>Desktop app</strong> (not “Web application”).
                    </>
                  ) : (
                    <>
                      type <strong>Web application</strong>, and add <code>{origin}</code> under <em>Authorised JavaScript origins</em>. Leave redirect URIs empty.
                    </>
                  )}
                </li>
                <li>Paste the client ID here{native ? ' with its client secret (it stays on this computer)' : ''}. Google may take a few minutes to accept a new client.</li>
              </ol>
              {id && !CLIENT_RE.test(id) && <p className="note note-warn small">A client ID looks like 1234567890-abc123….apps.googleusercontent.com</p>}
              {native && id && secret && !secret.startsWith('GOCSPX-') && <p className="note note-warn small">A Desktop app client secret starts with GOCSPX-</p>}
              <label className="title-field">
                <span>Client ID</span>
                <input value={id} onChange={(e) => setId(e.target.value.trim())} placeholder="1234…apps.googleusercontent.com" />
              </label>
              {native && (
                <label className="title-field">
                  <span>Secret</span>
                  <input value={secret} onChange={(e) => setSecret(e.target.value.trim())} placeholder="GOCSPX-…" />
                </label>
              )}
            </>
          )}
        </section>

        <footer className="row">
          {cur && !cur.builtIn && (
            <Button
              kind="quiet"
              onClick={() => {
                setGoogleConfig(null);
                onClose();
              }}
            >
              Remove
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <Button kind="quiet" onClick={onClose}>
            {open ? 'Cancel' : 'Close'}
          </Button>
          {open && (
            <Button
              kind={target ? 'ghost' : 'primary'}
              disabled={!CLIENT_RE.test(id) || (!!native && !secret.startsWith('GOCSPX-'))}
              onClick={() => {
                setGoogleConfig({ clientId: id, clientSecret: secret || undefined, email: cur?.clientId === id ? cur.email : undefined });
                onClose();
              }}
            >
              Save
            </Button>
          )}
        </footer>
      </div>
    </Overlay>
  );
}
