import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Caption fonts from the @fontsource packages (Latin subset). */
const CAPTION_FONTS: Record<string, string> = {
  figtree: '@fontsource/figtree/files/figtree-latin-700-normal.woff2',
  poppins: '@fontsource/poppins/files/poppins-latin-800-normal.woff2',
  montserrat: '@fontsource/montserrat/files/montserrat-latin-900-normal.woff2',
  anton: '@fontsource/anton/files/anton-latin-400-normal.woff2',
  bebas: '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2',
  marker: '@fontsource/permanent-marker/files/permanent-marker-latin-400-normal.woff2',
};

/**
 * `virtual:caption-fonts` maps each caption font to its bundled file, listing only the
 * files that are installed. A missing package never breaks the app: that style just
 * uses its fallback font until `npm install` brings it in.
 */
function captionFonts(): Plugin {
  const id = 'virtual:caption-fonts';
  return {
    name: 'caption-fonts',
    resolveId: (s) => (s === id ? '\0' + id : null),
    load(i) {
      if (i !== '\0' + id) return null;
      const imports: string[] = [];
      const entries: string[] = [];
      Object.entries(CAPTION_FONTS).forEach(([key, file], n) => {
        if (!existsSync(join(process.cwd(), 'node_modules', file))) return;
        imports.push(`import f${n} from ${JSON.stringify('/node_modules/' + file + '?url')};`);
        entries.push(`${key}: f${n}`);
      });
      return `${imports.join('\n')}\nexport default { ${entries.join(', ')} };\n`;
    },
  };
}

export default defineConfig({
  plugins: [react(), captionFonts()],
  server: { port: 5173 },
  worker: { format: 'es' },
  // transformers.js ships its own wasm loader; let it load lazily in the worker
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { target: 'es2022' },
});
