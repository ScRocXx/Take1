const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** SMPTE-style timecode HH:MM:SS:FF at 30 fps. */
export function timecode(sec: number, fps = 30) {
  const s = Math.max(0, sec);
  const h = s / 3600;
  const m = (s % 3600) / 60;
  const ss = s % 60;
  const ff = (s % 1) * fps;
  return `${pad(h)}:${pad(m)}:${pad(ss)}:${pad(ff)}`;
}

/** 1:05 or 1:02:05 */
export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 00:01:02,345 */
export function srtTime(sec: number) {
  const s = Math.max(0, sec);
  const ms = Math.round((s % 1) * 1000);
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)},${pad(ms, 3)}`;
}

export const seconds = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
