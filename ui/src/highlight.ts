// A small line-by-line highlighter: enough colour to read code at a glance on
// a desk display, without shipping a grammar engine to the phone.

export type TokenKind = 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'punct' | 'plain'

export type Token = {
  text: string
  kind: TokenKind
}

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue crate data def default defer del do elif else enum export ' +
    'extends extern false final finally fn for from func fun function go if impl implements import in inline interface internal is ' +
    'lambda let loop match mod module mut namespace new nil none not null object of open or override package pass private ' +
    'protected pub public raise readonly return satisfies sealed select self static struct super switch then this throw ' +
    'throws trait true try type typeof undefined union unsafe use val var void when where while with yield and true false ' +
    'None True False async await suspend lateinit companion'
  ).split(' '),
)

const HASH_COMMENTS = new Set(['python', 'shell', 'toml', 'yaml'])

function commentPattern(language: string): string {
  if (HASH_COMMENTS.has(language)) return '#.*$'
  if (language === 'sql') return '--.*$'

  return '\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$)|^\\s*\\*.*$'
}

const patterns = new Map<string, RegExp>()

function patternFor(language: string): RegExp {
  const cached = patterns.get(language)

  if (cached !== undefined) return cached

  const source = [
    `(${commentPattern(language)})`,
    '("(?:[^"\\\\]|\\\\.)*"?|\'(?:[^\'\\\\]|\\\\.)*\'?|`(?:[^`\\\\]|\\\\.)*`?)',
    '(\\b0x[0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
    '([A-Za-z_$][\\w$]*)',
    '(\\s+)',
    '([^\\sA-Za-z_$\\d"\'`]+)',
  ].join('|')
  const pattern = new RegExp(source, 'g')

  patterns.set(language, pattern)

  return pattern
}

export function highlightLine(line: string, language: string): Token[] {
  if (language === 'plain' || language === 'markdown') return [{ text: line, kind: 'plain' }]

  const pattern = patternFor(language)
  const tokens: Token[] = []

  pattern.lastIndex = 0

  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    const [text, comment, string, number, word] = match

    if (text === '') {
      pattern.lastIndex += 1
      continue
    }

    if (comment !== undefined) tokens.push({ text, kind: 'com' })
    else if (string !== undefined) tokens.push({ text, kind: 'str' })
    else if (number !== undefined) tokens.push({ text, kind: 'num' })
    else if (word !== undefined) tokens.push({ text, kind: wordKind(word, line, pattern.lastIndex) })
    else tokens.push({ text, kind: /^\s+$/.test(text) ? 'plain' : 'punct' })
  }

  return tokens
}

function wordKind(word: string, line: string, end: number): TokenKind {
  if (KEYWORDS.has(word)) return 'kw'
  if (/^\s*\(/.test(line.slice(end))) return 'fn'
  // SCREAMING_CASE reads as a constant, not a type.
  if (/^[A-Z][A-Z0-9_]+$/.test(word)) return 'plain'
  if (/^[A-Z]/.test(word)) return 'type'

  return 'plain'
}

const BADGES: Record<string, string> = {
  ts: 'TS',
  js: 'JS',
  rust: 'RS',
  kotlin: 'KT',
  java: 'JV',
  python: 'PY',
  go: 'GO',
  json: '{}',
  markdown: 'MD',
  css: 'CSS',
  html: '<>',
  shell: '$_',
  toml: 'TM',
  yaml: 'YML',
  c: 'C',
  sql: 'SQL',
}

export function languageBadge(language: string): string {
  return BADGES[language] ?? 'TXT'
}
