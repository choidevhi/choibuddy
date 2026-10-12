import { useEffect, useRef, useState } from 'react'

// Words appear at least this fast, and any backlog is worked off within
// CATCH_UP_S, so the text keeps up with Claude without jumping in chunks.
const MIN_CHARS_PER_S = 60
const CATCH_UP_S = 0.35
// A run without spaces (CJK, long identifiers) is still revealed in pieces.
const MAX_WORD = 6
const WORD = /\s*\S+/y

// Where the next word ends after `from`.
export function nextStop(text: string, from: number): number {
  WORD.lastIndex = from

  const match = WORD.exec(text)

  if (match === null) return text.length

  const end = from + match[0].length
  const leading = match[0].length - match[0].trimStart().length

  return end - from - leading > MAX_WORD ? from + leading + MAX_WORD : end
}

// Shows `target` word by word as it grows, from empty when first shown. Time
// based (not per frame), so it reads the same at 60 and 120 Hz. Text that
// does not continue what is shown (the start cut off) appears at once.
export function useTypewriter(target: string): string {
  const [shown, setShown] = useState('')
  const state = useRef({ length: 0, target: '', carry: 0 })

  useEffect(() => {
    const current = state.current

    if (!target.startsWith(current.target.slice(0, current.length))) {
      current.length = target.length
      current.carry = 0
    }

    current.target = target

    if (current.length >= target.length) {
      setShown(target)

      return
    }

    let frame = 0
    let last = performance.now()

    const tick = (time: number): void => {
      // A long gap (a hidden tab) is not made up in one jump.
      const seconds = Math.min(0.5, (time - last) / 1000)

      last = time
      current.carry += seconds * Math.max(MIN_CHARS_PER_S, (current.target.length - current.length) / CATCH_UP_S)

      let moved = false

      while (current.length < current.target.length) {
        const stop = nextStop(current.target, current.length)

        if (stop - current.length > current.carry) break
        current.carry -= stop - current.length
        current.length = stop
        moved = true
      }

      if (moved) setShown(current.target.slice(0, current.length))
      if (current.length < current.target.length) frame = requestAnimationFrame(tick)
      else current.carry = 0
    }

    frame = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(frame)
  }, [target])

  return shown
}
