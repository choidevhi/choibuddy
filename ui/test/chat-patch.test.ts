import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatDraft, ChatMessage, Conversation } from '../../shared/protocol.ts'
import { nextDraft, patchConversation } from '../src/chat-patch.ts'

const said = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', text, at: 0 })

const page = (start: number, ...messages: ChatMessage[]): Conversation => ({ sessionId: 's', title: '', messages, start, total: start + messages.length })

const piece = (key: string, text: string | null, append: string | null, offset: number): ChatDraft => ({ sessionId: 's', key, text, append, offset, at: 0 })

test('a patch adds new messages and replaces a grown one', () => {
  const shown = page(10, said('a', 'one'), said('b', 'two'))

  assert.deepEqual(patchConversation(shown, { sessionId: 's', from: 12, messages: [said('c', 'three')], total: 13, reset: false })?.messages.map(m => m.id), ['a', 'b', 'c'])
  assert.deepEqual(patchConversation(shown, { sessionId: 's', from: 11, messages: [said('b', 'two, longer')], total: 12, reset: false })?.messages.map(m => m.text), ['one', 'two, longer'])
})

test('a patch that starts above the page only adds what the page lacks', () => {
  const shown = page(10, said('a', 'one'))

  assert.deepEqual(patchConversation(shown, { sessionId: 's', from: 8, messages: [said('x', ''), said('y', ''), said('a', 'one'), said('d', 'new')], total: 12, reset: false })?.messages.map(m => m.id), ['a', 'd'])
})

test('a gap or a rewritten transcript asks for the page again', () => {
  const shown = page(0, said('a', 'one'))

  assert.equal(patchConversation(shown, { sessionId: 's', from: 3, messages: [said('d', '')], total: 4, reset: false }), null)
  assert.equal(patchConversation(shown, { sessionId: 's', from: 0, messages: [], total: 0, reset: true }), null)
})

test('a draft grows by pieces, ignores a piece it cannot place, and goes', () => {
  let held = nextDraft(undefined, piece('t:0', 'Hel', null, 0)) ?? undefined

  held = nextDraft(held, piece('t:0', null, 'lo', 3)) ?? undefined
  assert.deepEqual(held, { key: 't:0', text: 'Hello' })
  // A piece after a missed one, or for another reply, changes nothing.
  assert.equal(nextDraft(held, piece('t:0', null, '!', 9)), held)
  assert.equal(nextDraft(held, piece('t:1', null, '!', 5)), held)
  assert.equal(nextDraft(held, piece('', null, null, 0)), null)
})
