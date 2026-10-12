import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Docs } from '../src/docs.ts'
import { liveField, partialField, streamTail } from '../src/partial.ts'

test('code is read out of tool input that is still being written', () => {
  assert.equal(partialField('{"file_path":"C:\\\\a.ts","new_string":"const a = 1\\nconst b', 'new_string'), 'const a = 1\nconst b')
  assert.equal(partialField('{"file_path":"C:\\\\a.ts","new_str', 'new_string'), null)
  assert.equal(partialField('{"content":"say \\"hi\\" \\u00e9', 'content'), 'say "hi" é')
  // A cut-off escape is left out until the rest arrives.
  assert.equal(partialField('{"content":"tab\\', 'content'), 'tab')
  assert.equal(partialField('{"file_path":"C:\\\\work\\\\a.ts","content":"x"}', 'file_path'), 'C:\\work\\a.ts')
  assert.equal(liveField('Write'), 'content')
  assert.equal(liveField('Edit'), 'new_string')
  assert.equal(liveField('Bash'), null)
})

test('only the end of a long text is streamed, from a line start', () => {
  assert.deepEqual(streamTail('a\nb', 10), { text: 'a\nb', skippedLines: 0 })
  assert.deepEqual(streamTail('line1\nline2\nline3\nline4', 12), { text: 'line3\nline4', skippedLines: 2 })
  assert.deepEqual(streamTail('x'.repeat(20), 5), { text: 'xxxxx', skippedLines: 0 })
})

test('instruction files are listed per project, edited with a backup, and guarded against overwrites', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'choibuddy-claude-'))
  const project = mkdtempSync(join(tmpdir(), 'choibuddy-project-'))
  const backups = join(claudeDir, 'backups')

  writeFileSync(join(claudeDir, 'CLAUDE.md'), '# me\n')
  mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(project, '.claude', 'agents', 'reviewer.md'), 'review')

  const docs = new Docs(claudeDir, backups)
  const groups = docs.list([project, project])
  const labels = groups.map(group => group.files.map(file => `${file.label}${file.exists ? '' : '?'}`))

  assert.equal(groups.length, 2)
  assert.deepEqual(labels, [['CLAUDE.md'], ['CLAUDE.md?', 'AGENTS.md?', '.claude/agents/reviewer.md']])

  const user = groups[0]?.files[0]
  const agentsMd = groups[1]?.files[1]

  assert.ok(user !== undefined && agentsMd !== undefined)
  assert.equal(docs.read(user.id)?.text, '# me\n')

  // Creating a missing AGENTS.md.
  const created = docs.write(agentsMd.id, '# agents\n', 0)

  assert.equal(created.ok, true)
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), '# agents\n')

  // Someone else changed CLAUDE.md since it was opened: refuse.
  const stale = docs.write(user.id, 'mine', user.mtime - 10_000)

  assert.equal(stale.ok, false)

  const saved = docs.write(user.id, '# me, edited\n', user.mtime)

  assert.equal(saved.ok, true)
  assert.equal(readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf8'), '# me, edited\n')
  assert.equal(readdirSync(backups).length, 1)

  // Ids not handed out by list() reach nothing.
  assert.equal(docs.read('0000000000000000'), null)
  assert.equal(docs.write('0000000000000000', 'x', 0).ok, false)
})

test('a session in the home folder does not list the user CLAUDE.md twice', () => {
  const home = mkdtempSync(join(tmpdir(), 'choibuddy-home-'))
  const claudeDir = join(home, '.claude')

  mkdirSync(claudeDir)
  writeFileSync(join(claudeDir, 'CLAUDE.md'), '# me\n')

  const groups = new Docs(claudeDir, join(home, 'backups')).list([home])
  const labels = groups.map(group => group.files.map(file => file.label))

  assert.deepEqual(labels, [['CLAUDE.md'], ['CLAUDE.md', 'AGENTS.md']])
})
