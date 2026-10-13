import { useEffect, useRef, useState } from 'react'
import type { Lang } from './i18n.ts'

// Speaking a prompt: the phone's own speech recognition (the Android shell,
// no system popup), else the browser's where it has one. While it listens,
// what was heard so far comes through `onText`; the last call is final.

const TAGS: Record<Lang, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', fr: 'fr-FR' }

type VoiceEvent = { kind: 'listening' | 'partial' | 'final' | 'error' | 'denied'; text: string }

function parseVoice(detail: string): VoiceEvent | null {
  try {
    const value: VoiceEvent = JSON.parse(detail)

    return typeof value.kind === 'string' && typeof value.text === 'string' ? value : null
  } catch {
    return null
  }
}

export function voiceAvailable(): boolean {
  const native = window.ChoiBuddyNative

  if (native !== undefined) return native.voiceAvailable?.() === true

  return window.webkitSpeechRecognition !== undefined
}

export type Voice = {
  listening: boolean
  start: () => void
  stop: () => void
}

// `onText(text, final)`: what was heard so far; `onFail` when listening
// could not start or the microphone was refused.
export function useVoice(lang: Lang, onText: (text: string, final: boolean) => void, onFail: (denied: boolean) => void): Voice {
  const [listening, setListening] = useState(false)
  const browser = useRef<BrowserSpeech | null>(null)
  const handlers = useRef({ onText, onFail })

  handlers.current = { onText, onFail }

  // The Android shell answers with window events.
  useEffect(() => {
    const onEvent = (event: Event): void => {
      const voice = event instanceof CustomEvent ? parseVoice(JSON.stringify(event.detail)) : null

      if (voice === null) return

      if (voice.kind === 'listening') {
        setListening(true)

        return
      }

      if (voice.kind === 'partial') {
        handlers.current.onText(voice.text, false)

        return
      }

      setListening(false)
      if (voice.kind === 'final') handlers.current.onText(voice.text, true)
      else handlers.current.onFail(voice.kind === 'denied')
    }

    window.addEventListener('choibuddy-voice', onEvent)

    return () => {
      window.removeEventListener('choibuddy-voice', onEvent)
      browser.current?.stop()
    }
  }, [])

  const start = (): void => {
    const native = window.ChoiBuddyNative

    if (native?.startVoice !== undefined) {
      native.startVoice(TAGS[lang])

      return
    }

    const Speech = window.webkitSpeechRecognition

    if (Speech === undefined) {
      handlers.current.onFail(false)

      return
    }

    const speech = new Speech()
    let heard = ''

    speech.lang = TAGS[lang]
    speech.interimResults = true
    speech.continuous = false
    speech.onresult = event => {
      let text = ''

      for (let index = 0; index < event.results.length; index += 1) text += event.results[index]?.[0]?.transcript ?? ''

      heard = text
      handlers.current.onText(text, false)
    }
    speech.onerror = () => handlers.current.onFail(false)
    speech.onend = () => {
      browser.current = null
      setListening(false)
      handlers.current.onText(heard, true)
    }
    browser.current = speech
    setListening(true)
    speech.start()
  }

  const stop = (): void => {
    window.ChoiBuddyNative?.stopVoice?.()
    browser.current?.stop()
  }

  return { listening, start, stop }
}
