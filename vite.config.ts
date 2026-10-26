import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  worker: { format: 'es' },
  // transformers.js ships its own wasm loader; let it load lazily in the worker
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { target: 'es2022' },
});
