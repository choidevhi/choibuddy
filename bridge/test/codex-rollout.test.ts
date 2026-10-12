import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { CodexRollouts } from '../src/codex-rollout.ts'
import type { JsonObject } from '../src/json.ts'
import { Gallery } from '../src/gallery.ts'
import { parseHookInput, Store } from '../src/store.ts'

// A 1×1 PNG, enough for the gallery to take it as a picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64')

function line(type: string, payload: JsonObject, at = '2026-10-12T05:00:00.000Z'): string {
  return `${JSON.stringify({ timestamp: at, type, payload })}\n`
}

test("Codex's record gives the model, effort, usage, the account's windows and its pictures, read a piece at a time", () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-rollout-'))
  const made = join(root, 'exec-1.png')
  const looked = join(root, '보기 사진.png')
  const rollout = join(root, 'rollout.jsonl')

  writeFileSync(made, PNG)
  writeFileSync(looked, PNG)
  writeFileSync(
    rollout,
    line('session_meta', { id: 'cx1', cwd: 'C:/work' }) +
      line('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-sol', reasoning_effort: 'high' } }) +
      line('event_msg', {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 30000, cached_input_tokens: 20000, output_tokens: 400 }, last_token_usage: { total_tokens: 25840 }, model_context_window: 258400 },
        rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1791700062 }, secondary: { used_percent: 28, window_minutes: 10080, resets_at: 1792022241 } },
      }),
  )

  const rollouts = new CodexRollouts()
  const first = rollouts.read(rollout)

  assert.ok(first)
  assert.equal(first.model, 'gpt-6-sol')
  assert.equal(first.effort, 'high')
  assert.equal(first.contextTokens, 25840)
  assert.equal(first.contextWindow, 258400)
  assert.equal(first.inputTokens, 30000)
  assert.equal(first.cachedTokens, 20000)
  assert.deepEqual(
    first.windows.map(window => `${window.kind}:${window.percentUsed}`),
    ['five_hour:12.5', 'seven_day:28'],
  )
  assert.equal(rollouts.read(rollout), null)

  // A picture made, then one opened, its line cut in the middle of a Korean
  // character by a read that came too early.
  appendFileSync(rollout, line('event_msg', { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id: 'exec-1', savedPath: made } }, '2026-10-12T05:01:00.000Z'))

  const viewed = Buffer.from(line('event_msg', { type: 'item_completed', item: { type: 'ImageView', id: 'v1', path: pathToFileURL(looked).href } }, '2026-10-12T05:02:00.000Z'))
  const cut = viewed.indexOf(Buffer.from('사진')) + 1

  appendFileSync(rollout, viewed.subarray(0, cut))

  const second = rollouts.read(rollout)

  assert.deepEqual(
    second?.pictures.map(picture => [picture.path, picture.tool, new Date(picture.at).toISOString()]),
    [[made, 'image_gen', '2026-10-12T05:01:00.000Z']],
  )

  appendFileSync(rollout, viewed.subarray(cut))
  assert.deepEqual(
    rollouts.read(rollout)?.pictures.map(picture => [picture.path, picture.tool]),
    [[looked, 'view_image']],
  )
})

test("a Codex reading goes on the session, the Codex account's windows, and the gallery once", () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-rollout-store-'))
  const made = join(root, 'exec-2.png')
  let now = 1_000

  writeFileSync(made, PNG)

  const gallery = new Gallery(join(root, 'gallery'), () => now, () => `g${now++}`)
  const store = new Store({ read: () => null, now: () => now, newId: () => `id${now++}`, gallery })
  const input = parseHookInput({ hook_event_name: 'SessionStart', session_id: 'cx2', cwd: 'C:/work', agent: 'codex', source: 'startup' })

  assert.ok(input)
  store.apply(input)

  const reading = {
    model: 'gpt-6-sol',
    effort: 'medium',
    contextTokens: 50_000,
    contextWindow: 200_000,
    inputTokens: 9_000,
    cachedTokens: 6_000,
    outputTokens: 700,
    windows: [{ kind: 'five_hour', percentUsed: 40, resetsAt: null }],
    pictures: [{ path: made, at: 500, tool: 'image_gen' }],
  }

  assert.equal(store.applyCodexReading('cx2', reading), true)
  assert.equal(store.applyCodexReading('cx2', { ...reading, model: null, effort: null, contextTokens: null, inputTokens: null, outputTokens: null, windows: [] }), false)

  const usage = store.snapshot({ pcId: 'pc', hostName: 'pc', tailnetUrl: null, version: 'test', autoAcceptUntil: 0, trustTailnet: false, autoLanguage: null }).sessions[0]?.usage

  assert.equal(usage?.model, 'gpt-6-sol')
  assert.equal(usage?.effort, 'medium')
  assert.equal(usage?.contextPercent, 25)
  assert.equal(usage?.inputTokens, 3_000)
  assert.equal(usage?.cacheReadTokens, 6_000)
  assert.equal(usage?.outputTokens, 700)
  assert.deepEqual(store.codexLimits?.windows, [{ kind: 'five_hour', percentUsed: 40, resetsAt: null }])
  assert.equal(store.limits, null)
  assert.deepEqual(
    gallery.list().map(image => [image.sessionId, image.tool, image.at]),
    [['cx2', 'image_gen', 500]],
  )
})
