import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

// Relative base: the same build is loaded from Tauri's asset protocol and
// from Android's WebViewAssetLoader under /assets/ui/.
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  server: { port: 1430, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
})
