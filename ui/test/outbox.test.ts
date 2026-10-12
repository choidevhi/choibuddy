import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage } from '../../shared/protocol.ts'
import { outPrompt, SENDING_MS, SENT_HOLD_MS, syncOutbox } from '../src/outbox.ts'

const said = (id: string, text: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ id, role, text, at: 0 })

const keys = (): (() => string) => {
  let n = 0

  return () => `k${(n += 1)}`
}

test('a sent prompt stays one bubble from sending to the transcript', () => {
  const newKey = keys()
  const before = [said('1', 'hello'), said('2', 'hi there', 'assistant')]
  let box = [outPrompt('mine', 'fix the test', 'steer', before, 1000)]

  // The queue lists it: still the same bubble, now queued.
  box = syncOutbox(box, [{ text: 'fix the test', mode: 'steer' }], before, 1100, newKey)
  assert.equal(box.length, 1)
  assert.equal(box[0]?.key, 'mine')
  assert.equal(box[0]?.leftAt, null)

  // Claude Code took it, the transcript does not have it yet: shown as sent.
  box = syncOutbox(box, [], before, 2000, newKey)
  assert.equal(box[0]?.key, 'mine')
  assert.equal(box[0]?.leftAt, 2000)

  // The transcript has it: the bubble goes, the transcript's takes its place.
  box = syncOutbox(box, [], [...before, said('3', 'fix the test')], 2500, newKey)
  assert.deepEqual(box, [])
})

test('prompts joined into one message both settle', () => {
  const newKey = keys()
  let box = syncOutbox([], [{ text: 'first', mode: 'queue' }, { text: 'second', mode: 'queue' }], [], 0, newKey)

  assert.deepEqual(
    box.map(item => item.key),
    ['k1', 'k2'],
  )

  box = syncOutbox(box, [], [], 500, newKey)
  assert.equal(box.length, 2)

  box = syncOutbox(box, [], [said('9', 'first\n\nsecond')], 900, newKey)
  assert.deepEqual(box, [])
})

test('words said before do not settle a new prompt', () => {
  const newKey = keys()
  const before = [said('1', 'ok'), said('2', 'done', 'assistant')]
  let box = syncOutbox([], [{ text: 'ok', mode: 'steer' }], before, 0, newKey)

  box = syncOutbox(box, [], before, 100, newKey)
  assert.equal(box.length, 1, 'the old "ok" is not this one')

  box = syncOutbox(box, [], [...before, said('3', 'ok')], 200, newKey)
  assert.deepEqual(box, [])
})

test('a prompt the queue never listed waits, then shows as sent, then gives up', () => {
  const newKey = keys()
  let box = [outPrompt('mine', 'quick one', null, [], 0)]

  box = syncOutbox(box, [], [], SENDING_MS - 1, newKey)
  assert.equal(box[0]?.leftAt, null)

  box = syncOutbox(box, [], [], SENDING_MS, newKey)
  assert.equal(box[0]?.leftAt, SENDING_MS)

  box = syncOutbox(box, [], [], SENDING_MS + SENT_HOLD_MS, newKey)
  assert.deepEqual(box, [])
})

test('nothing new hands back the same list', () => {
  const newKey = keys()
  const box = syncOutbox([], [{ text: 'wait', mode: 'queue' }], [], 0, newKey)

  assert.equal(syncOutbox(box, [{ text: 'wait', mode: 'queue' }], [], 50, newKey), box)
})
