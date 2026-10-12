import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachedName, attachmentNote, splitAttachments } from '../src/attachments.ts'

test("a prompt's attachment list reads back as its words and file paths", () => {
  const paths = ['C:\\Users\\me\\.choibuddy\\uploads\\2026-10-12\\1a2b3c4d-pasted.png', 'C:\\Users\\me\\.choibuddy\\uploads\\2026-10-12\\5e6f7a8b-notes.txt']
  const text = `이 화면 고쳐줘${attachmentNote(paths)}`

  assert.deepEqual(splitAttachments(text), { body: '이 화면 고쳐줘', paths })
  // Only files: no words left.
  assert.deepEqual(splitAttachments(attachmentNote(paths).trim()), { body: '', paths })
  // Words only.
  assert.deepEqual(splitAttachments('그냥 질문'), { body: '그냥 질문', paths: [] })
  assert.equal(attachedName(paths[0] ?? ''), 'pasted.png')
})
