import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Transcripts, userText } from '../src/transcripts.ts'

const line = (value: object): string => `${JSON.stringify(value)}\n`

function sampleTranscript(): string {
  return [
    line({ type: 'permission-mode', permissionMode: 'default' }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>hidden</system-reminder>' }, cwd: 'C:/work/korus', timestamp: '2026-10-11T10:00:00Z', uuid: 'm0' }),
    line({ type: 'user', message: { role: 'user', content: '세율 바꿔줘<system-reminder>x</system-reminder>' }, cwd: 'C:/work/korus', timestamp: '2026-10-11T10:00:01Z', uuid: 'u1' }),
    line({ type: 'ai-title', aiTitle: '부가세율 변경' }),
    line({ type: 'assistant', message: { id: 'msg1', role: 'assistant', content: [{ type: 'text', text: '바꿀게요.' }] }, timestamp: '2026-10-11T10:00:02Z', uuid: 'a1' }),
    line({ type: 'assistant', message: { id: 'msg1', role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] }, uuid: 'a1b' }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, uuid: 't1' }),
    line({ type: 'assistant', isSidechain: true, message: { id: 'side', role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] }, uuid: 's1' }),
    line({ type: 'assistant', message: { id: 'msg2', role: 'assistant', content: [{ type: 'text', text: '다 바꿨어요.' }] }, timestamp: '2026-10-11T10:00:05Z', uuid: 'a2' }),
  ].join('')
}

test('a conversation keeps what people typed and what Claude said, nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-projects-'))
  const dir = join(root, 'C--work-korus')
  const path = join(dir, 'sess-1.jsonl')

  mkdirSync(dir)
  writeFileSync(path, sampleTranscript())

  const transcripts = new Transcripts(root)
  const found = transcripts.find('sess-1', null)

  assert.equal(found, path)

  const first = transcripts.conversation('sess-1', path, null, 50)

  assert.equal(first.title, '부가세율 변경')
  assert.deepEqual(
    first.messages.map(message => `${message.role}:${message.text}`),
    ['user:세율 바꿔줘', 'assistant:바꿀게요.', 'assistant:다 바꿨어요.'],
  )

  // New lines are read incrementally; a half-written line waits.
  appendFileSync(path, line({ type: 'user', message: { role: 'user', content: '<command-name>/reload-plugins</command-name><command-args></command-args>' }, uuid: 'u2' }))
  appendFileSync(path, '{"type":"assistant","message":{"id":"msg3","content":[{"type":"text","text":"반')

  const second = transcripts.conversation('sess-1', path, null, 50)

  assert.equal(second.total, 4)
  assert.equal(second.messages.at(-1)?.text, '/reload-plugins')

  appendFileSync(path, '쯤"}]},"uuid":"a3"}\n')
  assert.equal(transcripts.conversation('sess-1', path, null, 50).messages.at(-1)?.text, '반쯤')

  const page = transcripts.conversation('sess-1', path, 3, 2)

  assert.deepEqual([page.start, page.messages.length], [1, 2])

  const history = transcripts.recent(10, 365 * 24 * 60 * 60_000, Date.now())

  assert.deepEqual(
    history.map(entry => [entry.sessionId, entry.project, entry.title]),
    [['sess-1', 'korus', '부가세율 변경']],
  )
})

test('slash commands read as typed and wrappers are dropped', () => {
  assert.equal(userText('<command-name>/model</command-name><command-args>opus</command-args>'), '/model opus')
  assert.equal(userText('<local-command-caveat>x</local-command-caveat>'), null)
  assert.equal(transcriptsUnknown(), null)
})

function transcriptsUnknown(): string | null {
  return new Transcripts(mkdtempSync(join(tmpdir(), 'choibuddy-projects-'))).find('../escape', null)
}
