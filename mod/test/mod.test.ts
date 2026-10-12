import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { browserText, commandsOf, joinPrompts, needsCommands, promptsOf, stopAsked } from '../hooks/register.ts'

const NOW = Date.parse('2026-10-11T10:00:00Z')

type Sent = { url: string; body: string }

// Stands in for the engine and the bridge: records what the mod posts and
// answers polls with `queue` (and `commands`, and a stop) once.
function engineBeneath(on: On, sent: Sent[], submitted: string[], queue: string[], commands: string[] = [], ran: string[] = [], mode = 'steer', needCommands = false, stop = false): void {
  let stopping = stop

  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('http.fetch', (_, e) => {
    sent.push({ url: e.url, body: e.init?.body ?? '' })

    const isPoll = e.url.endsWith('/mod/poll')
    const prompts = isPoll ? queue.splice(0).map(text => ({ id: text, text, mode })) : []
    const queued = isPoll ? commands.splice(0).map(line => ({ id: `c-${line}`, command: line.split(' ')[0], args: line.split(' ').slice(1).join(' ') })) : []
    const stopNow = isPoll && stopping

    if (isPoll) stopping = false

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, stop: stopNow, prompts, commands: queued, needCommands: isPoll && needCommands }) } }
  })
  on('command.list', () => ({ value: [{ name: 'effort', description: 'Set effort', source: 'builtin' }] }))
  on('command.run', (_, e) => {
    ran.push(`${e.command} ${e.args}`.trim())

    return { text: `ran ${e.command}` }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })
}

test('사용량을 세션 id와 함께 브리지로 보낸다', async ($, on) => {
  const sent: Sent[] = []

  mock.clock(on, { now: NOW })
  engineBeneath(on, sent, [], [])
  await $.session.measure({
    context: { window: 200_000, tokens: 88_000, percent: 44 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 55, resetsAt: '2026-10-11T12:00:00Z' }],
    changed: ['context', 'rateLimits'],
  })

  const usage = sent.find(item => item.url === 'http://127.0.0.1:47130/mod/usage')

  expect(usage).toBeDefined()
  expect(usage?.body).toContain('"sessionId":"sess-1"')
  expect(usage?.body).toContain('"percentUsed":55')
  expect(usage?.body).toContain('"percent":44')
})

test('위젯에서 보낸 프롬프트를 사용자 말로 이 세션에 넣는다', async ($, on) => {
  const sent: Sent[] = []
  const submitted: string[] = []
  const clock = mock.clock(on, { now: NOW })

  engineBeneath(on, sent, submitted, ['테스트 돌려줘'])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1600)

  expect(submitted).toEqual(['테스트 돌려줘'])

  await clock.advance(1600)
  expect(submitted).toEqual(['테스트 돌려줘'])
  expect(sent.filter(item => item.url.endsWith('/mod/poll')).length).toBeGreaterThan(1)
})

test('브리지 답에서 글자 프롬프트만 꺼낸다', () => {
  expect(promptsOf('{"prompts":[{"id":"1","text":"a"},{"text":""},{"x":1},{"id":"2","text":"b","mode":"queue"}]}')).toEqual([
    { id: '1', text: 'a', mode: 'steer' },
    { id: '2', text: 'b', mode: 'queue' },
  ])
  expect(promptsOf('not json')).toEqual([])
})

test('코드를 쓰는 중인 도구 입력을 브리지로 흘려보낸다', async ($, on) => {
  const sent: Sent[] = []

  mock.clock(on, { now: NOW })
  engineBeneath(on, sent, [], [])
  on('turn.step', async function* (_, e) {
    yield { kind: 'tool', ref: 1, index: 1, id: 'tu1', name: 'Write' }
    yield { kind: 'input', ref: 2, index: 1, json: '{"file_path":"a.ts","content":"he' }
    yield { kind: 'input', ref: 3, index: 1, json: 'llo"}' }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })

  for await (const chunk of stream) {
    expect(chunk).toBeDefined()
  }

  const streamed = sent.filter(item => item.url.endsWith('/mod/stream')).map(item => item.body)

  expect(streamed.length).toBeGreaterThan(0)
  expect(streamed.at(-1)).toContain('"toolUseId":"tu1"')
  expect(streamed.at(-1)).toContain('hello')
})

test('브리지 답에서 슬래시 명령을 꺼낸다', () => {
  expect(commandsOf('{"commands":[{"id":"1","command":"effort","args":"high"},{"id":"2","command":""},{"command":"x"}]}')).toEqual([
    { id: '1', command: 'effort', args: 'high' },
  ])
  expect(commandsOf('nope')).toEqual([])
})

test('위젯에서 보낸 슬래시 명령을 실행하고 결과를 브리지로 보낸다', async ($, on) => {
  const sent: Sent[] = []
  const ran: string[] = []
  const clock = mock.clock(on, { now: NOW })

  engineBeneath(on, sent, [], [], ['effort high'], ran)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1600)

  expect(ran).toEqual(['effort high'])

  const result = sent.find(item => item.url.endsWith('/mod/command-result'))

  expect(result?.body).toContain('"id":"c-effort high"')
  expect(result?.body).toContain('"text":"ran effort"')
  expect(sent.some(item => item.url.endsWith('/mod/commands') && item.body.includes('"name":"effort"'))).toBe(true)
})

test('브리지가 명령 목록을 잃었다고 하면 다시 보낸다', async ($, on) => {
  const sent: Sent[] = []
  const clock = mock.clock(on, { now: NOW })

  expect(needsCommands('{"needCommands":true}')).toBe(true)
  expect(needsCommands('{"ok":true}')).toBe(false)
  expect(needsCommands('nope')).toBe(false)

  engineBeneath(on, sent, [], [], [], [], 'steer', true)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const atStart = sent.filter(item => item.url.endsWith('/mod/commands')).length

  // One poll.
  await clock.advance(500)

  expect(sent.filter(item => item.url.endsWith('/mod/commands')).length).toBe(atStart + 1)
})

test('요청마다 모델과 effort가 바뀔 때만 알린다', async ($, on) => {
  const sent: Sent[] = []

  mock.clock(on, { now: NOW })
  engineBeneath(on, sent, [], [])
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', ref: 1, index: 0, text: 'hi' }

    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  for (let index = 0; index < 2; index += 1) {
    for await (const chunk of $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) {
      expect(chunk).toBeDefined()
    }
  }

  const steps = sent.filter(item => item.url.endsWith('/mod/step'))

  expect(steps.length).toBe(1)
  expect(steps[0]?.body).toContain('"model":"claude-opus-5-5"')
  expect(steps[0]?.body).toContain('"effort":"high"')
})

test('브라우저 답을 Claude가 읽을 글로 바꾼다', () => {
  expect(browserText(null)).toContain('not running')
  expect(browserText('{"ok":false,"error":"The ChoiBuddy browser is not open."}')).toBe('The ChoiBuddy browser is not open.')

  const text = browserText('{"ok":true,"url":"http://localhost:5173/","title":"Shop","imagePath":"C:/u/shot.png","picked":"button.buy"}')

  expect(text).toContain('http://localhost:5173/ (Shop)')
  expect(text).toContain('C:/u/shot.png')
  expect(text).toContain('button.buy')
})

test('작업 중에 보낸 말은 도구가 끝나면 턴을 멈추고 다음 프롬프트로 들어간다', async ($, on) => {
  const sent: Sent[] = []
  const submitted: string[] = []
  const aborted: string[] = []
  const clock = mock.clock(on, { now: NOW })

  engineBeneath(on, sent, submitted, ['테스트도 추가해'])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)

    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'file text' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '고쳐줘', turnId: 't1' })
  await clock.advance(1600)

  // Nothing is cut off while the tool runs.
  expect(submitted).toEqual([])
  expect(aborted).toEqual([])

  const result = await $.tool.call({ tool: 'Read', file_path: '/tmp/a.ts' })

  // The tool's own result is untouched.
  expect(result.context).toBeUndefined()
  await clock.advance(100)
  expect(aborted).toEqual(['t1'])
  expect(submitted).toEqual(['테스트도 추가해'])
  expect(sent.some(item => item.url.endsWith('/mod/steered') && item.body.includes('테스트도 추가해'))).toBe(true)
})

test('읽기 전에 턴이 끝나면 그 말로 다음 턴을 시작한다', async ($, on) => {
  const submitted: string[] = []
  const clock = mock.clock(on, { now: NOW })

  engineBeneath(on, [], submitted, ['이것도 해줘'])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '고쳐줘', turnId: 't1' })
  await clock.advance(1600)
  expect(submitted).toEqual([])
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(submitted).toEqual(['이것도 해줘'])
})

test('멈추고 보내기는 돌고 있는 턴을 멈추고 바로 보낸다', async ($, on) => {
  const submitted: string[] = []
  const aborted: string[] = []
  const clock = mock.clock(on, { now: NOW })

  engineBeneath(on, [], submitted, ['그만하고 이거 해줘'], [], [], 'interrupt')
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)

    return { value: undefined }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '고쳐줘', turnId: 't2' })
  await clock.advance(1600)
  expect(aborted).toEqual(['t2'])
  expect(submitted).toEqual(['그만하고 이거 해줘'])
})

test('중지를 누르면 돌고 있는 턴을 Esc처럼 바로 멈춘다', async ($, on) => {
  const submitted: string[] = []
  const aborted: string[] = []
  const clock = mock.clock(on, { now: NOW })

  engineBeneath(on, [], submitted, [], [], [], 'steer', false, true)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)

    return { value: undefined }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '고쳐줘', turnId: 't3' })
  await clock.advance(600)
  expect(aborted).toEqual(['t3'])
  expect(submitted).toEqual([])
})

test('브리지 답에서 중지 요청을 읽는다', () => {
  expect(stopAsked('{"stop":true,"prompts":[]}')).toBe(true)
  expect(stopAsked('{"stop":false}')).toBe(false)
  expect(stopAsked('{"prompts":[]}')).toBe(false)
  expect(stopAsked('not json')).toBe(false)
})

test('작업 중에 보낸 말 여러 개는 보낸 순서대로 한 프롬프트가 된다', () => {
  expect(
    joinPrompts([
      { id: '1', text: ' 색을 파랑으로 ', mode: 'steer' },
      { id: '2', text: '버튼도 키워', mode: 'steer' },
    ]),
  ).toBe('색을 파랑으로\n\n버튼도 키워')
})
