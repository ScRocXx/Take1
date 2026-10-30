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
  /** drag the floating bar: 'start' follows the pointer, 'end' snaps it to the nearer side edge */
  pillDrag(phase: 'start' | 'end'): void;
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
