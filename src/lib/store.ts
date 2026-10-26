import { useSyncExternalStore } from 'react';

export type Phase = 'idle' | 'rolling' | 'rewinding' | 'preroll' | 'hold' | 'wrapped';
export type Screen = 'greenroom' | 'stage' | 'console' | 'dailies' | 'wrap' | 'library';
export type Tone = 'rec' | 'cue' | 'hold' | 'redact' | 'ok' | 'muted';

export interface Rect { x: number; y: number; w: number; h: number }

export interface LogItem {
  id: number;
  kind: string; // action kind (cut, hold, …) or 'heard' / 'system'
  label: string;
  detail?: string;
  tone: Tone;
  at: number; // tape seconds
}

export interface StageMark { id: string; name: string; rect: Rect }

export interface OuttakeInfo {
  id: string;
  take: number;
  from: number;
  to: number;
  text: string;
  thumb: string | null;
}

export interface RangeInfo {
  id: string;
  kind: 'hold' | 'redact';
  start: number;
  end: number;
  rect?: Rect;
  wall?: number;
}

export interface ChapterInfo { id: string; t: number; name: string }

export type ListenState = 'off' | 'listening' | 'thinking' | 'done' | 'unsure';

export interface Settings {
  sounds: boolean;
  prerollAudio: boolean;
  replaySeconds: number;
  countdown: number;
  pill: boolean;
}

/** Hold-to-talk combos. Fn isn't offered: on Windows laptops the Fn key never reaches the OS. */
export const TALK_KEYS: { id: string; label: string; note: string }[] = [
  { id: 'Ctrl+Shift', label: 'Ctrl + Shift', note: 'Default' },
  { id: 'Ctrl+Win', label: 'Ctrl + Win', note: 'What Wispr Flow uses on Windows' },
  { id: 'Alt+Shift', label: 'Alt + Shift', note: 'If you don’t switch keyboard languages with it' },
  { id: 'RightCtrl', label: 'Right Ctrl', note: 'One key, rarely used by other apps' },
];

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  record: 'Ctrl+Alt+R',
  cut: 'Ctrl+Alt+C',
  hold: 'Ctrl+Alt+H',
  mic: 'Ctrl+Alt+M',
  pill: 'Ctrl+Alt+T',
};

export interface TakeMeta {
  id: string;
  title: string;
  createdAt: number;
  duration: number;
  retakes: number;
  held: number;
  size: number;
  hasCaptions: boolean;
  captionsBurned: boolean;
  thumbUrl: string | null;
}

export interface CaptionState {
  status: 'idle' | 'downloading' | 'transcribing' | 'ready' | 'error';
  progress: number;
  detail: string | null;
}

export interface AppState {
  screen: Screen;
  sessionId: string;
  title: string;
  library: TakeMeta[];
  captions: CaptionState;
  keysDown: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
  helpOpen: boolean;
  phase: Phase;
  scene: number;
  take: number;
  log: LogItem[];
  listen: { state: ListenState; heard: string; intent: string | null; alternatives: string[]; id: number };
  engine: { status: 'idle' | 'loading' | 'ready' | 'error'; progress: number; detail: string | null };
  micOn: boolean;
  micMuted: boolean;
  micLevel: number;
  micDevices: { id: string; label: string }[];
  micDevice: string | null;
  hasScreen: boolean;
  surface: string | null;
  sourceName: string | null;
  hasCamera: boolean;
  cameraOn: boolean;
  marks: StageMark[];
  activeMark: string | null;
  namingMark: boolean;
  countdown: number | null;
  matchScore: number | null;
  teleprompter: string | null;
  rewind: { from: number; to: number } | null;
  slateKey: number;
  lastAction: { kind: string; label: string; id: number } | null;
  outtakes: OuttakeInfo[];
  ranges: RangeInfo[];
  chapters: ChapterInfo[];
  duration: number;
  holdBadge: string | null;
  toast: { id: number; text: string; tone: Tone } | null;
  pillOpen: boolean;
  desktop: boolean;
  pickingSource: boolean;
  trying: boolean;
  tried: Record<string, boolean>;
  transcript: { start: number; end: number; text: string }[] | null;
  transcribing: boolean;
  shortcuts: Record<string, string>;
  talkKey: string;
  talkHook: boolean;
  settings: Settings;
}

const initial: AppState = {
  screen: 'greenroom',
  sessionId: '',
  title: '',
  library: [],
  captions: { status: 'idle', progress: 0, detail: null },
  keysDown: { ctrl: false, shift: false, alt: false, meta: false },
  helpOpen: false,
  phase: 'idle',
  scene: 1,
  take: 1,
  log: [],
  listen: { state: 'off', heard: '', intent: null, alternatives: [], id: 0 },
  engine: { status: 'idle', progress: 0, detail: null },
  micOn: false,
  micMuted: false,
  micLevel: 0,
  micDevices: [],
  micDevice: null,
  hasScreen: false,
  surface: null,
  sourceName: null,
  hasCamera: false,
  cameraOn: true,
  marks: [],
  activeMark: null,
  namingMark: false,
  countdown: null,
  matchScore: null,
  teleprompter: null,
  rewind: null,
  slateKey: 0,
  lastAction: null,
  outtakes: [],
  ranges: [],
  chapters: [],
  duration: 0,
  holdBadge: null,
  toast: null,
  pillOpen: false,
  desktop: typeof window !== 'undefined' && !!(window as any).take1Native,
  pickingSource: false,
  trying: false,
  tried: {},
  transcript: null,
  transcribing: false,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  talkKey: 'Ctrl+Shift',
  talkHook: true,
  settings: { sounds: true, prerollAudio: true, replaySeconds: 5, countdown: 3, pill: true },
};

let state: AppState = initial;
const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(state), () => sel(state));
}

let logId = 0;
export function pushLog(item: Omit<LogItem, 'id'>) {
  store.set((s) => ({ log: [...s.log.slice(-60), { ...item, id: ++logId }] }));
}

let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, tone: Tone = 'muted') {
  store.set({ toast: { id: ++toastId, text, tone } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.set({ toast: null }), 3400);
}

export const uid = () => Math.random().toString(36).slice(2, 9);
