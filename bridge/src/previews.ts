import type { CodeLine, CodePreview, Preview, StepKind, TodoItem, TodoStatus } from '../../shared/protocol.ts'
import { arr, type Json, type JsonObject, num, objects, str, strings } from './json.ts'

// Reads a text file for previews, or null when it is missing, huge or binary.
export type FileReader = (path: string) => string | null

const MAX_LINES = 60
const MAX_LINE_CHARS = 400
const EDIT_CONTEXT = 3
const EDIT_BLOCK_LINES = 18
const OUTPUT_LINES = 40

const LANGUAGES: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  java: 'java',
  py: 'python',
  go: 'go',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'css',
  html: 'html',
  vue: 'html',
  svelte: 'html',
  sh: 'shell',
  bash: 'shell',
  ps1: 'shell',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  gd: 'python',
  c: 'c',
  h: 'c',
  cpp: 'c',
  hpp: 'c',
  cs: 'c',
  swift: 'kotlin',
  sql: 'sql',
}

export function languageOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase()

  return LANGUAGES[ext] ?? 'plain'
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')

  return parts.at(-1) ?? path
}

export function kindOf(tool: string): StepKind {
  if (tool.startsWith('mcp__')) return 'mcp'

  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Write':
      return 'write'
    case 'Bash':
    case 'PowerShell':
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
    case 'Monitor':
      return 'bash'
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'ToolSearch':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Task':
    case 'Agent':
    case 'SendMessage':
      return 'agent'
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return 'todo'
    case 'AskUserQuestion':
      return 'question'
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return 'plan'
    default:
      return 'other'
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find(part => part.trim() !== '') ?? ''

  return line.trim()
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')

  if (lines.length > 1 && lines.at(-1) === '') lines.pop()

  return lines
}

function filePathOf(input: JsonObject): string {
  return str(input, 'file_path') ?? str(input, 'notebook_path') ?? str(input, 'path') ?? ''
}

export function todosOf(input: JsonObject): TodoItem[] {
  return objects(arr(input, 'todos')).map(todo => ({
    content: str(todo, 'content') ?? str(todo, 'activeForm') ?? '',
    status: todoStatus(str(todo, 'status')),
  }))
}

function todoStatus(value: string | null): TodoStatus {
  return value === 'in_progress' || value === 'completed' ? value : 'pending'
}

export function stepTitle(tool: string, input: JsonObject): string {
  const kind = kindOf(tool)

  switch (kind) {
    case 'read':
    case 'edit':
    case 'write': {
      const path = filePathOf(input)

      return path === '' ? tool : baseName(path)
    }
    case 'bash':
      return clip(str(input, 'description') ?? firstLine(str(input, 'command') ?? tool), 90)
    case 'search':
      return clip(str(input, 'pattern') ?? str(input, 'query') ?? str(input, 'path') ?? tool, 90)
    case 'web':
      return clip(hostOf(str(input, 'url')) ?? str(input, 'query') ?? tool, 90)
    case 'agent':
      return clip(str(input, 'description') ?? str(input, 'subagent_type') ?? tool, 90)
    case 'todo': {
      const active = todosOf(input).find(todo => todo.status === 'in_progress')

      return clip(active?.content ?? str(input, 'subject') ?? '', 90)
    }
    case 'question': {
      const first = objects(arr(input, 'questions'))[0] ?? null

      return clip(str(first, 'question') ?? '', 90)
    }
    case 'plan':
      return ''
    case 'mcp': {
      const [, server = '', name = tool] = tool.split('__')

      return `${server} · ${name}`
    }
    case 'other':
      return clip(firstStringField(input) ?? tool, 90)
  }
}

function hostOf(url: string | null): string | null {
  if (url === null) return null

  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function firstStringField(input: JsonObject): string | null {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() !== '') return firstLine(value)
  }

  return null
}

function codeLines(lines: string[], firstNumber: number, mark: CodeLine['mark']): CodeLine[] {
  return lines.slice(0, MAX_LINES).map((text, index) => ({
    n: firstNumber + index,
    text: clip(text, MAX_LINE_CHARS),
    mark,
  }))
}

function code(path: string, lines: CodeLine[]): CodePreview {
  return { type: 'code', path, language: languageOf(path), lines }
}

function readPreview(input: JsonObject, read: FileReader): Preview | null {
  const path = filePathOf(input)
  const content = read(path)

  if (content === null) return { type: 'text', title: baseName(path), text: '@unpreviewable' }

  const offset = Math.max(1, num(input, 'offset') ?? 1)
  const limit = Math.min(MAX_LINES, num(input, 'limit') ?? MAX_LINES)
  const lines = splitLines(content).slice(offset - 1, offset - 1 + limit)

  return code(path, codeLines(lines, offset, 'none'))
}

function capBlock(lines: CodeLine[]): CodeLine[] {
  if (lines.length <= EDIT_BLOCK_LINES) return lines

  const head = lines.slice(0, EDIT_BLOCK_LINES - 3)
  const tail = lines.slice(-2)
  const hidden = lines.length - head.length - tail.length

  return [...head, { n: null, text: `… +${hidden}`, mark: 'none' }, ...tail]
}

// Shows an edit as whole lines of the file: context, removed lines, added
// lines, context. old_string can start mid-line, so the block is widened to
// full lines and the replacement is applied inside them.
export function editPreview(path: string, oldText: string, newText: string, read: FileReader): CodePreview {
  const raw = read(path)
  const content = raw === null ? null : normalize(raw)
  const oldNorm = normalize(oldText)
  const newNorm = normalize(newText)
  const start = content === null || oldNorm === '' ? -1 : content.indexOf(oldNorm)

  if (content === null || start === -1) {
    const removed = splitLines(oldNorm).map((text): CodeLine => ({ n: null, text: clip(text, MAX_LINE_CHARS), mark: 'del' }))
    const added = splitLines(newNorm).map((text): CodeLine => ({ n: null, text: clip(text, MAX_LINE_CHARS), mark: 'add' }))

    return code(path, [...capBlock(removed), ...capBlock(added)])
  }

  const lineStart = content.lastIndexOf('\n', start - 1) + 1
  const oldEnd = start + oldNorm.length
  const nextBreak = content.indexOf('\n', oldEnd)
  const lineEnd = nextBreak === -1 ? content.length : nextBreak
  const prefix = content.slice(lineStart, start)
  const suffix = content.slice(oldEnd, lineEnd)
  const firstLineNumber = content.slice(0, lineStart).split('\n').length
  const oldLines = splitLines(content.slice(lineStart, lineEnd))
  const newLines = splitLines(prefix + newNorm + suffix)
  const fileLines = splitLines(content)
  const beforeFrom = Math.max(0, firstLineNumber - 1 - EDIT_CONTEXT)
  const before = codeLines(fileLines.slice(beforeFrom, firstLineNumber - 1), beforeFrom + 1, 'none')
  const afterFrom = firstLineNumber - 1 + oldLines.length
  const after = codeLines(fileLines.slice(afterFrom, afterFrom + EDIT_CONTEXT), firstLineNumber + newLines.length, 'none')
  const removed = capBlock(codeLines(oldLines, firstLineNumber, 'del'))
  const added = capBlock(codeLines(newLines, firstLineNumber, 'add'))

  return code(path, [...before, ...removed, ...added, ...after])
}

function writePreview(input: JsonObject, read: FileReader): CodePreview {
  const path = filePathOf(input)
  const isNew = read(path) === null

  return code(path, codeLines(splitLines(str(input, 'content') ?? ''), 1, isNew ? 'add' : 'none'))
}

// "key: value" lines read better than JSON for the short inputs most tools take.
function prettyInput(input: JsonObject): string {
  const lines = Object.entries(input).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)

    return `${key}: ${clip(text.replace(/\s+/g, ' '), 300)}`
  })

  return lines.slice(0, 30).join('\n')
}

export function toolPreview(tool: string, input: JsonObject, read: FileReader): Preview | null {
  switch (kindOf(tool)) {
    case 'read':
      return readPreview(input, read)
    case 'edit': {
      const path = filePathOf(input)
      const edits = objects(arr(input, 'edits'))

      if (tool === 'NotebookEdit') {
        return code(path, codeLines(splitLines(str(input, 'new_source') ?? ''), 1, 'add'))
      }

      if (edits.length > 0) {
        const first = edits[0] ?? null

        return editPreview(path, str(first, 'old_string') ?? '', str(first, 'new_string') ?? '', read)
      }

      return editPreview(path, str(input, 'old_string') ?? '', str(input, 'new_string') ?? '', read)
    }
    case 'write':
      return writePreview(input, read)
    case 'bash': {
      const command = str(input, 'command')

      return command === null ? null : { type: 'terminal', command: clip(command, 2000), output: '', failed: false }
    }
    case 'todo': {
      const todos = todosOf(input)

      return todos.length === 0 ? null : { type: 'todos', items: todos }
    }
    case 'question':
      return { type: 'text', title: '@question', text: questionText(input) }
    case 'plan':
      return { type: 'text', title: '@plan', text: clip(str(input, 'plan') ?? '', 6000) }
    case 'agent':
      return { type: 'text', title: str(input, 'subagent_type') ?? '@agent', text: clip(str(input, 'prompt') ?? str(input, 'message') ?? '', 1500) }
    case 'search':
    case 'web':
    case 'mcp':
    case 'other':
      return { type: 'text', title: tool, text: prettyInput(input) }
  }
}

function questionText(input: JsonObject): string {
  return objects(arr(input, 'questions'))
    .map(question => {
      const options = objects(arr(question, 'options')).map(option => str(option, 'label') ?? '')

      return `${str(question, 'question') ?? ''}\n${options.map(label => `  · ${label}`).join('\n')}`
    })
    .join('\n\n')
}

function tailLines(text: string, count: number): string {
  const lines = splitLines(text.trimEnd())

  return lines
    .slice(-count)
    .map(line => clip(line, MAX_LINE_CHARS))
    .join('\n')
}

function responseText(response: Json | undefined): string {
  if (typeof response === 'string') return response
  if (response === undefined || response === null) return ''

  if (Array.isArray(response)) {
    return response.map(item => responseText(item)).join('\n')
  }

  if (typeof response !== 'object') return String(response)

  const stdout = str(response, 'stdout')
  const stderr = str(response, 'stderr')

  if (stdout !== null || stderr !== null) return [stdout ?? '', stderr ?? ''].filter(part => part !== '').join('\n')

  const filenames = strings(arr(response, 'filenames'))

  if (filenames.length > 0) return filenames.slice(0, 30).join('\n')

  const text = str(response, 'content') ?? str(response, 'result') ?? str(response, 'text') ?? str(response, 'output')

  return text ?? JSON.stringify(response, null, 2)
}

// Merges a tool's result into the preview made when it started: commands
// gain their output, searches show what they found.
export function resultPreview(tool: string, previous: Preview | null, response: Json | undefined, error: string | null): Preview | null {
  const output = error ?? responseText(response)

  if (previous?.type === 'terminal') {
    return { ...previous, output: tailLines(output, OUTPUT_LINES), failed: error !== null }
  }

  const kind = kindOf(tool)

  if (kind === 'search' || kind === 'web' || kind === 'mcp' || kind === 'agent') {
    if (output.trim() === '') return previous

    return { type: 'text', title: previous?.type === 'text' ? previous.title : tool, text: clip(splitLines(output).slice(0, OUTPUT_LINES).join('\n'), 4000) }
  }

  if (error !== null && previous?.type !== 'code') {
    return { type: 'text', title: '@failed', text: tailLines(error, OUTPUT_LINES) }
  }

  return previous
}
