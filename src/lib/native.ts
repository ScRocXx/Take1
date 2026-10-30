/** Bridge to the desktop shell (electron/preload.cjs). Undefined in a plain browser. */
export interface NativeSource {
  id: string;
  name: string;
  thumbnail: string;
  icon: string | null;
  kind: 'window' | 'screen';
}

/** Where the floating bar is: its side, its centre on screen, and that screen's bounds (DIP). */
export interface PillPlace {
  side: 'left' | 'right';
  cx: number;
  cy: number;
  display: { x: number; y: number; width: number; height: number };
}

/** Whether the bar (pill) and the full-screen overlay (fx) stay out of screen captures. */
export interface CaptureStatus {
  state: 'hidden' | 'leaks' | 'unknown';
  fx: boolean | null;
  pill: boolean | null;
  /** os.release(), e.g. 10.0.22631 */
  build: string;
  platform: string;
  at?: number;
}

export interface Take1Native {
  isDesktop: true;
  platform: string;
  onHotkey(cb: (name: string) => void): void;
  setShortcuts(map: Record<string, string>): Promise<Record<string, boolean>>;
  getShortcuts(): Promise<Record<string, string> | null>;
  listening(on: boolean): void;
  setTalkKey(key: string): Promise<boolean>;
  talkStatus(): Promise<boolean>;
  getSources(): Promise<NativeSource[]>;
  chooseSource(id: string): Promise<void>;
  pillInteractive(on: boolean): void;
  pillVisible(on: boolean): void;
  /** pressed on the floating bar: once the pointer moves 5 px the bar follows it */
  pillPress(): void;
  /** let go: a moved bar glides to the nearer side edge */
  pillRelease(): void;
  onPillDragging(cb: (on: boolean) => void): void;
  /** recording or not: the shell keeps the capture shield up and holds its check meanwhile */
  recording(on: boolean): void;
  captureStatus(): Promise<CaptureStatus>;
  /** flash a dot in the bar and the overlay, screenshot, and see whether either shows */
  checkCapture(): Promise<CaptureStatus>;
  onCaptureStatus(cb: (s: CaptureStatus) => void): void;
  /** put the bar back on the right edge, centred */
  pillReset(): void;
  pillWhere(): Promise<PillPlace>;
  onPillPlaced(cb: (p: PillPlace) => void): void;
  getOpenAtLogin(): Promise<boolean>;
  setOpenAtLogin(on: boolean): Promise<boolean>;
  version(): Promise<string>;
  showMain(): void;
  hideMain(): void;
  /** Google sign-in through the system browser (loopback + PKCE); keeps a refresh token. */
  googleAuth?(o: { clientId: string; clientSecret: string; scopes: string }): Promise<{ access_token: string; expires_in: number; scope?: string }>;
  googleSignOut?(): Promise<void>;
}

export const native: Take1Native | undefined = (window as any).take1Native;
