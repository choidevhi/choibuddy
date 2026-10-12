import { useEffect, useRef } from 'react'

// A prompt box asks to stop its session's running turn (Esc in the
// terminal); App knows which PC the session is on and asks that bridge.
const EVENT = 'choibuddy-stop'

export function askStop(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: sessionId }))
}

export function useStopRequests(onStop: (sessionId: string) => void): void {
  const latest = useRef(onStop)

  useEffect(() => {
    latest.current = onStop
  })

  useEffect(() => {
    const listen = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') latest.current(event.detail)
    }

    window.addEventListener(EVENT, listen)

    return () => window.removeEventListener(EVENT, listen)
  }, [])
}
