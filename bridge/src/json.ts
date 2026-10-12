// Hook payloads arrive as arbitrary JSON. These helpers are the one place
// where that JSON is read, so the rest of the bridge works with real types.

export type Json = null | boolean | number | string | Json[] | JsonObject

export type JsonObject = { [key: string]: Json }

export function parseJsonObject(text: string): JsonObject | null {
  let value: Json

  try {
    value = JSON.parse(text)
  } catch {
    return null
  }

  return asObject(value)
}

export function asObject(value: Json | undefined): JsonObject | null {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== 'object') {
    return null
  }

  return value
}

export function str(obj: JsonObject | null, key: string): string | null {
  const value = obj?.[key]

  return typeof value === 'string' ? value : null
}

export function num(obj: JsonObject | null, key: string): number | null {
  const value = obj?.[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function bool(obj: JsonObject | null, key: string): boolean | null {
  const value = obj?.[key]

  return typeof value === 'boolean' ? value : null
}

export function obj(source: JsonObject | null, key: string): JsonObject | null {
  return asObject(source?.[key])
}

export function arr(source: JsonObject | null, key: string): Json[] {
  const value = source?.[key]

  return Array.isArray(value) ? value : []
}

export function strings(values: Json[]): string[] {
  const out: string[] = []

  for (const value of values) {
    if (typeof value === 'string') out.push(value)
  }

  return out
}

export function objects(values: Json[]): JsonObject[] {
  const out: JsonObject[] = []

  for (const value of values) {
    const item = asObject(value)

    if (item !== null) out.push(item)
  }

  return out
}
