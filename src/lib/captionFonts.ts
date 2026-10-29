/**
 * Caption fonts ship with the app (the @fontsource packages, Latin subset, SIL Open Font
 * License), so styled captions never need the network. vite.config.ts lists only the
 * installed files; for a missing one the family's Windows/macOS fallbacks take over.
 */
import files from 'virtual:caption-fonts';
import { FONTS, type FontId } from './captions';

const FAMILY: Partial<Record<FontId, string>> = {
  figtree: 'Take1 Figtree',
  poppins: 'Take1 Poppins',
  montserrat: 'Take1 Montserrat',
  anton: 'Take1 Anton',
  bebas: 'Take1 Bebas',
  marker: 'Take1 Marker',
};

export interface FontFile {
  family: string;
  weight: number;
  url: string;
}

/** Absolute URLs, so the export worker can load the same files. */
export function fontFile(id: FontId): FontFile | null {
  const url = (files as Partial<Record<FontId, string>>)[id];
  const family = FAMILY[id];
  return url && family ? { family, weight: FONTS[id].weight, url: new URL(url, location.href).href } : null;
}

const loaded = new Map<FontId, Promise<void>>();

/** Loads a caption font into the page (for the preview and the style tiles). */
export function ensureFont(id: FontId): Promise<void> {
  let p = loaded.get(id);
  if (!p) {
    const f = fontFile(id);
    p = f
      ? new FontFace(f.family, `url(${f.url})`, { weight: String(f.weight) })
          .load()
          .then((face) => void document.fonts.add(face))
          .catch(() => {})
      : Promise.resolve();
    loaded.set(id, p);
  }
  return p;
}
