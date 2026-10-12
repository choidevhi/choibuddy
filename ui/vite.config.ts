import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
// The screens know which version they are, to spot a newer release.
const { version }: { version: string } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Relative base: the same build is loaded from Tauri's asset protocol and
// from Android's WebViewAssetLoader under /assets/ui/.
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 1430, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
})
