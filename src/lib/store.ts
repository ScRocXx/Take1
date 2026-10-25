import { useSyncExternalStore } from 'react';

export type Phase = 'idle' | 'rolling' | 'rewinding' | 'preroll' | 'hold' | 'wrapped';
export type Screen = 'greenroom' | 'stage' | 'console' | 'dailies' | 'wrap';
export type Tone = 'tally' | 'cue' | 'hold' | 'redact' | 'ok' | 'muted';

export interface Rect { x: number; y: number; w: number; h: number }

export interface TickerItem {
  id: number;
  kind: 'speech' | 'command' | 'system';
  text: string;
  tone?: Tone;
  struck?: boolean;
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
  rect?: Rect; // normalized to the output frame (redact only)
  wall?: number; // real seconds held (hold only)
}

export interface ChapterInfo { id: string; t: number; name: string }

export interface Settings {
  sounds: boolean;
  prerollAudio: boolean;
  strict: boolean;
  countdown: number;
}

export interface AppState {
  screen: Screen;
  phase: Phase;
  scene: number;
  take: number;
  ticker: TickerItem[];
  interim: string;
  listening: 'off' | 'on' | 'error' | 'unsupported';
  listenError: string | null;
  micOn: boolean;
  micLevel: number;
  hasScreen: boolean;
  surface: string | null;
  hasCamera: boolean;
  cameraOn: boolean;
  marks: StageMark[];
  activeMark: string | null;
  namingMark: boolean;
  countdown: number | null;
  matchFrame: string | null;
  matchScore: number | null;
  teleprompter: string | null;
  rewind: { from: number; to: number } | null;
  slateKey: number;
  outtakes: OuttakeInfo[];
  ranges: RangeInfo[];
  chapters: ChapterInfo[];
  duration: number;
  holdBadge: string | null;
  toast: { id: number; text: string; tone: Tone } | null;
  hudOpen: boolean;
  rehearsing: boolean;
  rehearsal: Record<string, boolean>;
  lastCommand: string | null;
  settings: Settings;
}

const initial: AppState = {
  screen: 'greenroom',
  phase: 'idle',
  scene: 1,
  take: 1,
  ticker: [],
  interim: '',
  listening: 'off',
  listenError: null,
  micOn: false,
  micLevel: 0,
  hasScreen: false,
  surface: null,
  hasCamera: false,
  cameraOn: true,
  marks: [],
  activeMark: null,
  namingMark: false,
  countdown: null,
  matchFrame: null,
  matchScore: null,
  teleprompter: null,
  rewind: null,
  slateKey: 0,
  outtakes: [],
  ranges: [],
  chapters: [],
  duration: 0,
  holdBadge: null,
  toast: null,
  hudOpen: false,
  rehearsing: false,
  rehearsal: {},
  lastCommand: null,
  settings: { sounds: true, prerollAudio: true, strict: false, countdown: 3 },
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

let tickerId = 0;
export function pushTicker(item: Omit<TickerItem, 'id'>) {
  store.set((s) => ({ ticker: [...s.ticker.slice(-40), { ...item, id: ++tickerId }] }));
}

let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, tone: Tone = 'muted') {
  store.set({ toast: { id: ++toastId, text, tone } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.set({ toast: null }), 3200);
}

export const uid = () => Math.random().toString(36).slice(2, 9);
