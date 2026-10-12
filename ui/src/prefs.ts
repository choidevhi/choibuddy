import { useEffect, useState } from 'react'
import { readPref, writePref } from './platform.ts'

// A preference shared by every window of the app: the main widget and the
// floating buddy see each other's changes through the storage event.
export function usePref<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, allowed, fallback))

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === `choibuddy.${key}`) setValue(readPref(key, allowed, fallback))
    }

    window.addEventListener('storage', onStorage)

    return () => window.removeEventListener('storage', onStorage)
    // `allowed` and `fallback` are constants at every call site.
  }, [key])

  const set = (next: T): void => {
    writePref(key, next)
    setValue(next)
  }

  return [value, set]
}

export const ON_OFF = ['on', 'off'] as const

export type OnOff = (typeof ON_OFF)[number]
