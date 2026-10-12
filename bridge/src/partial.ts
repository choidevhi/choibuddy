// A tool's input arrives as JSON text that is still being written. This
// reads one string field out of it as far as it goes, so code can be shown
// while Claude types it.

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }

export function partialField(json: string, key: string): string | null {
  const marker = new RegExp(`"${key}"\\s*:\\s*"`)
  const found = marker.exec(json)

  if (found === null) return null

  let out = ''
  let at = found.index + found[0].length

  while (at < json.length) {
    const char = json[at] ?? ''

    if (char === '"') return out

    if (char !== '\\') {
      out += char
      at += 1
      continue
    }

    const next = json[at + 1]

    // The escape itself is cut off: stop before it.
    if (next === undefined) return out

    if (next === 'u') {
      const hex = json.slice(at + 2, at + 6)

      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out
      out += String.fromCharCode(Number.parseInt(hex, 16))
      at += 6
      continue
    }

    out += ESCAPES[next] ?? next
    at += 2
  }

  return out
}

// Past this many characters only the end of a text is streamed: the whole
// file again eight times a second would be wasted on a phone.
const TAIL_CHARS = 8_000

// The end of `text`, cut at a line start, and how many lines were left out.
export function streamTail(text: string, max = TAIL_CHARS): { text: string; skippedLines: number } {
  if (text.length <= max) return { text, skippedLines: 0 }

  const newline = text.indexOf('\n', text.length - max)
  const start = newline === -1 ? text.length - max : newline + 1
  let skippedLines = 0

  for (let at = text.indexOf('\n'); at !== -1 && at < start; at = text.indexOf('\n', at + 1)) skippedLines += 1

  return { text: text.slice(start), skippedLines }
}

// Which field holds the code a tool is writing.
export function liveField(tool: string): string | null {
  switch (tool) {
    case 'Write':
      return 'content'
    case 'Edit':
    case 'MultiEdit':
      return 'new_string'
    case 'NotebookEdit':
      return 'new_source'
    default:
      return null
  }
}
