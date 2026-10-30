import { native } from './native';

/**
 * Getting a finished video somewhere useful:
 *  - a folder on this computer you choose once (File System Access API),
 *  - YouTube (private, unlisted or public; chapters go in the description, captions as a track),
 *  - Google Drive (the MP4, plus captions next to it).
 *
 * Google needs an OAuth client ID that belongs to you (free, one-time setup; see the
 * README). In the browser, sign-in uses Google Identity Services; in the desktop app
 * it opens your normal browser and the app keeps a refresh token, encrypted by the OS.
 */

// ───────────────── save to a folder ─────────────────

const KV_DB = 'take1-settings';
function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(KV_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const r = fn(open.result.transaction('kv', mode).objectStore('kv'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
  });
}

export const folderSupported = () => 'showDirectoryPicker' in window;

export async function savedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return ((await kv('readonly', (s) => s.get('folder'))) as FileSystemDirectoryHandle) ?? null;
  } catch {
    return null;
  }
}

export async function chooseFolder() {
  const h: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: 'take1-exports', mode: 'readwrite' });
  await kv('readwrite', (s) => s.put(h, 'folder'));
  return h;
}

export async function forgetFolder() {
  await kv('readwrite', (s) => s.delete('folder'));
}

/** Write files into the chosen folder (asks for permission again if the browser dropped it). */
export async function saveToFolder(files: { name: string; data: Blob | string }[]) {
  let dir = await savedFolder();
  if (!dir) dir = await chooseFolder();
  const h = dir as any;
  if ((await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission?.({ mode: 'readwrite' })) !== 'granted') {
    throw new Error('Take1 needs permission to write to that folder.');
  }
  for (const f of files) {
    const fh = await dir.getFileHandle(f.name, { create: true });
    const w = await (fh as any).createWritable();
    await w.write(f.data);
    await w.close();
  }
  return dir.name;
}

// ───────────────── Google account ─────────────────

export interface GoogleConfig {
  clientId: string;
  /** desktop app only: Google issues a (non-confidential) secret for "Desktop app" clients */
  clientSecret?: string;
  email?: string;
  /** came with this copy of Take1 (.env), not typed in by the user */
  builtIn?: boolean;
}

const CFG_KEY = 'take1.google';

/**
 * A client ID built into this copy of Take1 (from .env, see .env.example), so the people
 * using it only ever see Google's normal sign-in. Without one, each person sets up their own.
 */
function builtInConfig(): GoogleConfig | null {
  const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;
  const clientId = native ? env.VITE_GOOGLE_DESKTOP_CLIENT_ID : env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) return null;
  return { clientId, clientSecret: native ? env.VITE_GOOGLE_DESKTOP_CLIENT_SECRET : undefined, builtIn: true };
}

export function googleConfig(): GoogleConfig | null {
  let saved: GoogleConfig | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(CFG_KEY) ?? 'null');
  } catch {
    /* private mode */
  }
  const built = builtInConfig();
  if (saved?.clientId) return saved.clientId === built?.clientId ? { ...built, ...saved, builtIn: true } : saved;
  return built ? { ...built, email: saved?.email } : null;
}
export function setGoogleConfig(c: GoogleConfig | null) {
  try {
    if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CFG_KEY);
  } catch {
    /* private mode */
  }
}

export const SCOPES = {
  youtube: 'https://www.googleapis.com/auth/youtube.upload',
  captions: 'https://www.googleapis.com/auth/youtube.force-ssl',
  drive: 'https://www.googleapis.com/auth/drive.file',
  email: 'openid email',
};

let token: { value: string; expires: number; scopes: Set<string> } | null = null;

function loadGis(): Promise<any> {
  const g = (window as any).google?.accounts?.oauth2;
  if (g) return Promise.resolve(g);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve((window as any).google.accounts.oauth2);
    s.onerror = () => reject(new Error('Couldn’t reach Google sign-in. Are you online?'));
    document.head.appendChild(s);
  });
}

/** Turn Google's error codes into what to change in Google Cloud. */
export function explainGoogleError(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('redirect_uri_mismatch'))
    return native
      ? 'Google rejected the sign-in address. In the desktop app the OAuth client must be type “Desktop app”, not “Web application”. Create a Desktop app client and paste its ID and secret in Set up.'
      : `Google rejected this page’s address. The OAuth client must be type “Web application” with ${location.origin} as an authorised JavaScript origin.`;
  if (e.includes('origin_mismatch') || e.includes('idpiframe') || e.includes('not a valid origin'))
    return `Google doesn’t accept ${location.origin} for this client. Add it under “Authorised JavaScript origins” (client type “Web application”).`;
  if (e.includes('invalid_client') || e.includes('unauthorized_client'))
    return native ? 'Google didn’t recognise this client ID and secret. Check both in Set up (client type “Desktop app”).' : 'Google didn’t recognise this client ID. Check it in Set up.';
  if (e.includes('access_denied') || e.includes('popup_closed') || e.includes('closed'))
    return 'Sign-in was cancelled. If Google said the app isn’t verified, add your account as a test user on the OAuth consent screen.';
  if (e.includes('timed out')) return 'Sign-in timed out. If the browser showed a Google error, check the client type in Set up.';
  return raw;
}

/** An access token covering `scopes`, signing in (or asking for more access) if needed. */
export async function googleToken(scopes: string[]): Promise<string> {
  const cfg = googleConfig();
  if (!cfg?.clientId) throw new Error('Add your Google client ID first.');
  const want = [...scopes, SCOPES.email];
  if (token && token.expires > Date.now() + 60_000 && want.every((s) => s.split(' ').every((x) => token!.scopes.has(x)))) return token.value;

  let value: string;
  let expiresIn: number;
  let granted: string;
  if (native?.googleAuth) {
    if (!cfg.clientSecret) throw new Error('The desktop app needs the client secret too (OAuth client type “Desktop app”). Add it in Set up.');
    const r = await native
      .googleAuth({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, scopes: want.join(' ') })
      .catch((err: Error) => {
        throw new Error(explainGoogleError(String(err?.message ?? err)));
      });
    value = r.access_token;
    expiresIn = r.expires_in;
    granted = r.scope ?? want.join(' ');
  } else {
    const oauth2 = await loadGis();
    const r: any = await new Promise((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: cfg.clientId,
        scope: want.join(' '),
        include_granted_scopes: true,
        callback: (resp: any) => (resp.error ? reject(new Error(explainGoogleError(`${resp.error} ${resp.error_description ?? ''}`))) : resolve(resp)),
        error_callback: (e: any) => reject(new Error(explainGoogleError(e?.type || e?.message || 'closed'))),
      });
      client.requestAccessToken({ prompt: cfg.email ? '' : 'consent', login_hint: cfg.email });
    });
    value = r.access_token;
    expiresIn = Number(r.expires_in) || 3600;
    granted = r.scope ?? want.join(' ');
  }
  token = { value, expires: Date.now() + expiresIn * 1000, scopes: new Set(granted.split(' ')) };
  if (!cfg.email) {
    try {
      const me = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${value}` } })).json();
      if (me.email) setGoogleConfig({ ...cfg, email: me.email });
    } catch {
      /* not essential */
    }
  }
  return value;
}

export async function googleSignOut() {
  if (token && !native?.googleAuth) fetch(`https://oauth2.googleapis.com/revoke?token=${token.value}`, { method: 'POST' }).catch(() => {});
  token = null;
  await native?.googleSignOut?.();
  const cfg = googleConfig();
  if (cfg?.builtIn) setGoogleConfig(null);
  else if (cfg) setGoogleConfig({ clientId: cfg.clientId, clientSecret: cfg.clientSecret });
}

/**
 * Google resumable upload: start a session with the metadata, then send the file in
 * 8 MB pieces so progress is real and a dropped connection doesn't lose everything.
 */
async function resumable(startUrl: string, metadata: object, file: Blob, accessToken: string, onProgress?: (p: number) => void) {
  const start = await fetch(startUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': file.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(file.size),
    },
    body: JSON.stringify(metadata),
  });
  if (!start.ok) throw new Error(await googleError(start));
  const session = start.headers.get('Location');
  if (!session) throw new Error('Google didn’t return an upload address.');
  const CHUNK = 32 * 256 * 1024; // 8 MiB, a multiple of 256 KiB as Google requires
  let sent = 0;
  for (;;) {
    const end = Math.min(file.size, sent + CHUNK);
    const res = await fetch(session, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${sent}-${end - 1}/${file.size}` },
      body: file.slice(sent, end),
    });
    if (res.status === 308) {
      const range = res.headers.get('Range');
      sent = range ? Number(range.split('-')[1]) + 1 : end;
      onProgress?.(sent / file.size);
      continue;
    }
    if (!res.ok) throw new Error(await googleError(res));
    onProgress?.(1);
    return res.json();
  }
}

async function googleError(res: Response) {
  try {
    const j = await res.json();
    return j.error?.message || j.error_description || `Google said ${res.status}`;
  } catch {
    return `Google said ${res.status}`;
  }
}

export interface YouTubeUpload {
  title: string;
  description: string;
  privacy: 'private' | 'unlisted' | 'public';
  captionsSrt?: string;
}

/** Upload to YouTube. Returns the watch URL. */
export async function uploadToYouTube(video: Blob, o: YouTubeUpload, onProgress?: (p: number) => void) {
  const accessToken = await googleToken(o.captionsSrt ? [SCOPES.youtube, SCOPES.captions] : [SCOPES.youtube]);
  onProgress?.(0.01); // signed in; uploading starts
  const res = await resumable(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    { snippet: { title: o.title.slice(0, 100), description: o.description.slice(0, 5000), categoryId: '28' }, status: { privacyStatus: o.privacy, selfDeclaredMadeForKids: false } },
    video,
    accessToken,
    (p) => onProgress?.(p * (o.captionsSrt ? 0.95 : 1)),
  );
  const id: string = res.id;
  if (o.captionsSrt) {
    const boundary = 'take1' + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ snippet: { videoId: id, language: 'en', name: 'English', isDraft: false } }) +
      `\r\n--${boundary}\r\nContent-Type: application/x-subrip\r\n\r\n${o.captionsSrt}\r\n--${boundary}--`;
    const c = await fetch('https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!c.ok) throw new Error(`Video uploaded, but the captions weren’t: ${await googleError(c)}`);
  }
  onProgress?.(1);
  return `https://youtu.be/${id}`;
}

/** Upload to Google Drive (plus any small side files, e.g. captions). Returns the video's Drive link. */
export async function uploadToDrive(video: Blob, name: string, extras: { name: string; text: string; type: string }[], onProgress?: (p: number) => void) {
  const accessToken = await googleToken([SCOPES.drive]);
  onProgress?.(0.01); // signed in; uploading starts
  const res = await resumable(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink',
    { name, mimeType: 'video/mp4' },
    video,
    accessToken,
    onProgress,
  );
  for (const x of extras) {
    const boundary = 'take1' + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: x.name, mimeType: x.type })}\r\n--${boundary}\r\nContent-Type: ${x.type}\r\n\r\n${x.text}\r\n--${boundary}--`;
    await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }
  return (res.webViewLink as string) ?? `https://drive.google.com/file/d/${res.id}/view`;
}

/**
 * No Google setup? Do it by hand, with Take1 doing the tedious parts: the file is saved,
 * the title and description (with chapters) are on the clipboard, and the upload page opens.
 */
export async function uploadByHand(where: 'youtube' | 'drive', file: File, text: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  let copied = false;
  if (text) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      /* clipboard blocked */
    }
  }
  window.open(where === 'youtube' ? 'https://www.youtube.com/upload' : 'https://drive.google.com/drive/my-drive', '_blank', 'noopener');
  return copied;
}

/** The system share sheet with the file attached, where the browser supports it. */
export function canShareFile(file: File) {
  return !!navigator.canShare?.({ files: [file] });
}
