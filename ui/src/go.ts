import { useEffect, useRef } from 'react'

// Something asks App to show a session's chat: the new session sheet, once
// Codex started there.
const EVENT = 'choibuddy-open-chat'

export function openChat(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: sessionId }))
}

export function useChatRequests(onOpen: (sessionId: string) => void): void {
  const latest = useRef(onOpen)

  useEffect(() => {
    latest.current = onOpen
  })

  useEffect(() => {
    const listen = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') latest.current(event.detail)
    }

    window.addEventListener(EVENT, listen)

    return () => window.removeEventListener(EVENT, listen)
  }, [])
}
