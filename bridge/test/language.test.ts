import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { arr, type JsonObject, objects, parseJsonObject, str } from '../src/json.ts'
import { AutoLanguage, detectLanguage, RESTATE_PROMPT } from '../src/language.ts'
import { startBridge } from '../src/server.ts'

const TOKEN = 'test-token-0123456789abcdefghijklmnop'

test('a reply is told apart by its words, not by the code and names in it', () => {
  // Korean with English names, code and a path stays Korean.
  assert.equal(detectLanguage('**→ Vite 설정을 바꿨어요.** `server.allowedHosts`에 `.ts.net`을 넣었고, C:/work/app/vite.config.ts만 고쳤어요. React 화면은 그대로예요.'), 'ko')
  assert.equal(detectLanguage('I updated the Vite config so the dev server accepts the tailnet host, and the tests still pass.'), 'en')
  assert.equal(detectLanguage("J'ai modifié la configuration de Vite pour que le serveur accepte le nom d'hôte, et les tests passent toujours."), 'fr')
  assert.equal(detectLanguage('Viteの設定を変更して、開発サーバーがホスト名を受け付けるようにしました。テストも通っています。'), 'ja')
  // Too little to tell, or only code.
  assert.equal(detectLanguage('Done.'), null)
  assert.equal(detectLanguage('```ts\nconst rate = 0.2\nexport function vatRate(invoice: Invoice): number { return rate }\n```'), null)
})

test('a reply in another language is asked again once, never the restatement', () => {
  const auto = new AutoLanguage()
  const english = 'I fixed the sorting and added three tests for the price order. All of them pass now.'

  auto.onPrompt('s1', '정렬 고쳐줘')
  assert.equal(auto.onStop('s1', english, 'ko'), RESTATE_PROMPT.ko)

  // The restatement comes back in English again: no second ask.
  auto.onPrompt('s1', RESTATE_PROMPT.ko)
  assert.equal(auto.onStop('s1', english, 'ko'), null)

  // Already in the wanted language, or turned off.
  auto.onPrompt('s1', '다음 거 해줘')
  assert.equal(auto.onStop('s1', '정렬을 고치고 가격 순서 테스트를 세 개 넣었어요. 모두 통과해요.', 'ko'), null)
  assert.equal(auto.onStop('s1', english, null), null)
})

test('turned on from a device, the bridge queues the restatement for the session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-language-'))
  const saved: string[] = []
  const bridge = await startBridge({
    config: { port: 0, token: TOKEN, pcId: 'pc-self', devices: [], trustTailnet: false, autoLanguage: null },
    saveConfig: config => saved.push(config.autoLanguage ?? 'off'),
    galleryDir: join(root, 'gallery'),
    uploadsDir: join(root, 'uploads'),
    docBackupDir: join(root, 'backups'),
    claudeDir: join(root, 'claude'),
    log: () => {},
    bindTailnet: false,
    read: () => null,
    modManifest: join(root, 'no-mod.json'),
  })
  const url = `http://127.0.0.1:${bridge.port}`
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const post = async (path: string, body: JsonObject, auth = true): Promise<JsonObject | null> =>
    parseJsonObject(await (await fetch(`${url}${path}`, { method: 'POST', headers: auth ? headers : {}, body: JSON.stringify(body) })).text())
  const hook = (payload: JsonObject): Promise<JsonObject | null> => post('/hook', { session_id: 's1', cwd: 'C:/work/app', permission_mode: 'default', ...payload }, false)
  const queued = async (): Promise<string[]> => {
    const snapshot = parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers })).text())

    return objects(arr(objects(arr(snapshot, 'sessions'))[0] ?? {}, 'queued')).map(item => str(item, 'text') ?? '')
  }

  try {
    assert.equal(str(await post('/api/auto-language', { lang: 'xx' }), 'error'), 'unknown language')
    await post('/api/auto-language', { lang: 'ko' })
    assert.deepEqual(saved, ['ko'])

    await hook({ hook_event_name: 'SessionStart', source: 'startup' })
    await post('/mod/poll', { sessionId: 's1' }, false)
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: '정렬 고쳐줘' })
    await hook({ hook_event_name: 'Stop', last_assistant_message: 'I fixed the sorting and added three tests for the price order. All of them pass now.' })
    assert.deepEqual(await queued(), [RESTATE_PROMPT.ko])

    // Claude Code takes it; the restatement that follows is left alone.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: RESTATE_PROMPT.ko })
    await hook({ hook_event_name: 'Stop', last_assistant_message: 'Sure. I fixed the sorting and added three tests for the price order.' })
    assert.deepEqual(await queued(), [])

    await post('/api/auto-language', { lang: null })
    assert.deepEqual(saved, ['ko', 'off'])
  } finally {
    await bridge.close()
  }
})
