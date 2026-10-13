import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatDraft, ChatMessage, ChatPatch } from '../../shared/protocol.ts'
import { LEGACY, LiveChats } from '../src/live-chat.ts'

// A transcript the test grows by hand, and every event the bridge would send.
function setup() {
  const messages: ChatMessage[] = []
  // Which event went out, in order, and each kind's data.
  const order: Array<'chat' | 'draft'> = []
  const patchList: ChatPatch[] = []
  const draftList: ChatDraft[] = []
  let clock = 1000
  const chats = new LiveChats({
    messages: () => messages,
    emit: (event, data) => {
      order.push(event)
      if (event === 'chat') patchList.push(JSON.parse(data))
      else draftList.push(JSON.parse(data))
    },
    now: () => clock,
  })
  const say = (role: ChatMessage['role'], text: string): void => {
    messages.push({ id: `m${messages.length}`, role, text, at: clock })
  }
  const drafts = (): ChatDraft[] => draftList
  const patches = (): ChatPatch[] => patchList

  return { messages, order, chats, say, drafts, patches, tick: (ms: number) => (clock += ms) }
}

test('a reply streams as pieces and goes only once the transcript holds it', () => {
  const { chats, say, drafts, patches, order } = setup()

  say('user', '인보이스 합계가 이상해')
  chats.tick(['s'])
  assert.equal(patches()[0]?.messages.length, 1, 'the first look sends the last messages')

  chats.write('s', 't1:0', 1, '원인은')
  chats.write('s', 't1:0', 2, '원인은 TVA 상수예요.')
  assert.deepEqual(drafts().map(draft => [draft.text, draft.append, draft.offset]), [
    ['원인은', null, 0],
    [null, ' TVA 상수예요.', 3],
  ])

  chats.finish('s', 't1:0', '원인은 TVA 상수예요.')
  chats.tick(['s'])
  assert.equal(drafts().length, 2, 'still shown: the transcript does not have it yet')

  // Claude Code writes it, with its own line breaks.
  say('assistant', '원인은\n\nTVA 상수예요.')
  chats.tick(['s'])

  assert.deepEqual(order.slice(-2), ['chat', 'draft'], 'the message comes first, then the draft goes')
  assert.equal(patches().at(-1)?.from, 1)
  assert.equal(drafts().at(-1)?.text, null)
  assert.equal(drafts().at(-1)?.append, null)
})

test('pieces arriving out of order never take the text back', () => {
  const { chats, drafts } = setup()

  chats.write('s', 't1:0', 1, 'a')
  chats.write('s', 't1:0', 3, 'abc')
  chats.write('s', 't1:0', 2, 'ab')
  assert.deepEqual(
    drafts().map(draft => draft.text ?? `+${draft.append}`),
    ['a', '+bc'],
  )
})

test('a late piece of a settled reply does not show it twice', () => {
  const { chats, say, drafts } = setup()

  chats.tick(['s'])
  chats.write('s', 't1:0', 1, 'done here')
  chats.finish('s', 't1:0', 'done here')
  say('assistant', 'done here')
  chats.tick(['s'])

  const count = drafts().length

  chats.write('s', 't1:0', 1, 'done here')
  assert.equal(drafts().length, count)
})

test('an older mod repeating text the transcript has adds no draft', () => {
  const { chats, say, drafts } = setup()

  say('assistant', 'already written')
  chats.tick(['s'])
  chats.write('s', LEGACY, null, 'already written')
  assert.equal(drafts().length, 0)
})

test('a short reply that matches an earlier message waits for its own', () => {
  const { chats, say, drafts } = setup()

  say('assistant', 'OK')
  chats.tick(['s'])
  chats.write('s', 't2:0', 1, 'OK, 고칠게요')
  chats.write('s', 't2:0', 2, 'OK, 고칠게요')
  assert.equal(drafts().at(-1)?.text, 'OK, 고칠게요', 'not taken for the old "OK"')
})

test('a reply growing the last message is patched in place', () => {
  const { chats, say, messages, patches } = setup()

  say('assistant', 'first block')
  chats.tick(['s'])
  messages[0] = { ...messages[0]!, text: 'first block\n\nsecond block' }
  chats.tick(['s'])
  assert.deepEqual(patches().at(-1), { sessionId: 's', from: 0, messages: [messages[0]], total: 1, reset: false })
})

test('a step that ends with no text, or never reaches the transcript, goes', () => {
  const { chats, drafts, tick } = setup()

  chats.tick(['s'])
  chats.write('s', 't1:0', 1, 'stopped midway')
  chats.end('s')
  chats.tick(['s'])
  assert.notEqual(drafts().at(-1)?.text, null, 'kept while the transcript may still come')
  tick(31_000)
  chats.tick(['s'])
  assert.equal(drafts().at(-1)?.text, null)
})

test('a screen that connects gets every draft whole', () => {
  const { chats } = setup()

  chats.write('s', 't1:0', 1, 'ab')
  chats.write('s', 't1:0', 2, 'abcd')
  assert.deepEqual(
    chats.drafts().map(draft => [draft.sessionId, draft.text, draft.append]),
    [['s', 'abcd', null]],
  )
})

test('a reply written in blocks shows once: as the draft until all of it is in', () => {
  const { chats, say, messages, patches, drafts } = setup()

  chats.tick(['s'])
  chats.write('s', 't1:0', 1, 'First block. Second block.')
  chats.finish('s', 't1:0', 'First block. Second block.')
  say('assistant', 'First block.')
  chats.tick(['s'])
  assert.equal(patches().length, 1, 'the first block alone is not sent')
  assert.equal(drafts().at(-1)?.text, 'First block. Second block.')

  messages[0] = { ...messages[0]!, text: 'First block.\n\nSecond block.' }
  chats.tick(['s'])
  assert.deepEqual(patches().at(-1)?.messages.map(message => message.text), ['First block.\n\nSecond block.'])
  assert.equal(drafts().at(-1)?.text, null)
})
