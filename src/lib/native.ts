/** Bridge to the desktop shell (electron/preload.cjs). Undefined in a plain browser. */
export interface NativeSource {
  id: string;
  name: string;
  thumbnail: string;
  icon: string | null;
  kind: 'window' | 'screen';
}

export interface Take1Native {
  isDesktop: true;
  platform: string;
  onHotkey(cb: (name: string) => void): void;
  setShortcuts(map: Record<string, string>): Promise<Record<string, boolean>>;
  getShortcuts(): Promise<Record<string, string> | null>;
  listening(on: boolean): void;
  getSources(): Promise<NativeSource[]>;
  chooseSource(id: string): Promise<void>;
  pillInteractive(on: boolean): void;
  pillVisible(on: boolean): void;
  showMain(): void;
  hideMain(): void;
}

export const native: Take1Native | undefined = (window as any).take1Native;
