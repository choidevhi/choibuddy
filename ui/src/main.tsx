import '@fontsource-variable/jetbrains-mono'
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { FloatApp } from './float.tsx'
import { unlockAudioOnInteraction } from './sound.ts'
import './styles.css'

const root = document.getElementById('root')
// The Windows shell opens a second, transparent window on ?view=float.
const isFloat = new URLSearchParams(window.location.search).get('view') === 'float'

if (root !== null) {
  unlockAudioOnInteraction()
  createRoot(root).render(<StrictMode>{isFloat ? <FloatApp /> : <App />}</StrictMode>)
}
