// Feeds a running bridge with made-up Claude Code hook events so the UI can
// be looked at without a real session. Dev only.
//   node scripts/demo.ts --port 47199 --scene read
// Scenes: read, edit, bash, done, pending, question, plan, multi, agents, images, live, reply, command
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CHOIBUDDY_DEMO_LANG=en tells the made-up work in English (for English screenshots).
const english = process.env.CHOIBUDDY_DEMO_LANG === 'en'

function say(ko: string, en: string): string {
  return english ? en : ko
}

const args = process.argv.slice(2)

function arg(name: string, fallback: string): string {
  const at = args.indexOf(name)

  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}

const port = Number(arg('--port', '47130'))
const scene = arg('--scene', 'read')
// CHOIBUDDY_DEMO_DIR moves the made-up projects (for screenshots without
// personal paths); the default is the temp folder.
const base = process.env.CHOIBUDDY_DEMO_DIR ?? join(tmpdir(), 'choibuddy-demo')
const root = join(base, 'korus')
// A made-up transcript, so the conversation tab has history to show. Run the
// bridge with CLAUDE_CONFIG_DIR pointing at choibuddy-demo/claude.
const transcriptDir = join(base, 'claude', 'projects', 'korus')
const transcript = join(transcriptDir, 'demo-korus-0001.jsonl')
const file = join(root, 'src', 'invoice.ts')

mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(
  file,
  [
    '// Invoice helpers shared by the checkout and the admin pages.',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    "import { Item } from './types'",
    '',
    'const TVA = 0.196',
    '',
    'export function total(items: Item[]) {',
    '  const sum = items.reduce((s, i) => s + i.price, 0)',
    '  return sum * (1 + TVA)',
    '}',
    '',
  ].join('\n'),
)

mkdirSync(transcriptDir, { recursive: true })

const said = (role: 'user' | 'assistant', text: string, minutesAgo: number): string =>
  `${JSON.stringify({
    type: role,
    message: role === 'user' ? { role, content: text } : { id: `m-${minutesAgo}`, role, content: [{ type: 'text', text }] },
    cwd: root,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    uuid: `u-${role}-${minutesAgo}`,
  })}\n`

writeFileSync(
  transcript,
  [
    `${JSON.stringify({ type: 'ai-title', aiTitle: say('부가세율 2026 기준으로 변경', 'Update the VAT rate for 2026') })}\n`,
    said('user', say('인보이스 합계가 이상해. 원인 찾아줘', 'Invoice totals look wrong. Find out why'), 30),
    said('assistant', say('`src/invoice.ts`의 `TVA` 상수가 **0.196**으로 남아 있어서 합계가 맞지 않아요.', 'The `TVA` constant in `src/invoice.ts` is still **0.196**, so the totals are off.'), 29),
    said('user', say('부가세율을 2026년 기준으로 바꾸고 테스트 돌려줘', 'Switch the VAT rate to the 2026 value and run the tests'), 5),
    said('assistant', say('바꿀게요. 먼저 파일을 읽고, 상수를 고친 뒤 테스트를 돌릴게요.', 'On it. I\'ll read the file, fix the constant, then run the tests.'), 4),
  ].join(''),
)

type Payload = Record<string, string | number | boolean | null | Payload | Payload[] | string[]>

function post(payload: Payload, wait = true): Promise<string> {
  const request = fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: JSON.stringify(payload) }).then(res => res.text())

  return wait ? request : Promise.resolve('')
}

function session(id: string, cwd: string): (event: string, fields?: Payload, wait?: boolean) => Promise<string> {
  return (event, fields = {}, wait = true) =>
    post({ hook_event_name: event, session_id: id, cwd, permission_mode: 'default', transcript_path: id === 'demo-korus-0001' ? transcript : '', ...fields }, wait)
}

const korus = session('demo-korus-0001', root)

// What the companion mod would report: usage, limits, and a poll that marks
// the session as able to take prompts.
async function modReport(sessionId: string): Promise<void> {
  const send = (path: string, body: Payload): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body) })
  const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString()

  await send('/mod/usage', {
    sessionId,
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: inHours(2.3) },
      { kind: 'seven_day', percentUsed: 61, resetsAt: inHours(52) },
    ],
    step: { model: 'claude-opus-5-5', input_tokens: 3_200, output_tokens: 18_400, cache_read_input_tokens: 1_180_000, cache_creation_input_tokens: 64_000 },
  })
  await send('/mod/poll', { sessionId })
  await send('/mod/step', { sessionId, agentId: null, model: 'claude-opus-5-5', effort: 'xhigh' })
  await send('/mod/commands', {
    sessionId,
    commands: [
      { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
      { name: 'context', description: 'Visualize current context usage as a colored grid', source: 'builtin' },
      { name: 'cost', description: 'Show the total cost and duration of the current session', source: 'builtin' },
      { name: 'docs', description: 'Open the Claude Code documentation', source: 'builtin' },
      { name: 'effort', description: 'Set effort level for model usage', source: 'builtin' },
      { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', source: 'builtin' },
      { name: 'model', description: 'Set the AI model for Claude Code', source: 'builtin' },
      { name: 'review', description: 'Review a pull request', source: 'builtin' },
    ],
  })
}
const read = { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: file, offset: 10 } }
const edit = {
  tool_name: 'Edit',
  tool_use_id: 'e1',
  tool_input: { file_path: file, old_string: 'const TVA = 0.196', new_string: 'const TVA = 0.2 // 2026 rate' },
}
const bash = { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'pnpm vitest run src/invoice.test.ts', description: say('인보이스 테스트 실행', 'Run the invoice tests') } }

await korus('SessionStart', { source: 'startup' })
await modReport('demo-korus-0001')
await korus('UserPromptSubmit', { prompt: say('부가세율을 2026년 기준으로 바꾸고 테스트 돌려줘', 'Switch the VAT rate to the 2026 value and run the tests') })
await korus('PreToolUse', read)

if (scene !== 'read') {
  await korus('PostToolUse', { ...read, tool_response: {} })
  await korus('PreToolUse', edit)
}

if (scene === 'bash' || scene === 'done' || scene === 'pending' || scene === 'multi') {
  await korus('PostToolUse', { ...edit, tool_response: {} })
  await korus('PreToolUse', bash)
}

if (scene === 'done' || scene === 'multi') {
  await korus('PostToolUse', {
    ...bash,
    tool_response: { stdout: ' ✓ src/invoice.test.ts (4 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)', stderr: '' },
  })
  await korus('Stop', {
    last_assistant_message:
      say('**→ 부가세율을 0.2로 바꿨어요.** `src/invoice.ts`의 `TVA` 상수만 고쳤고, 인보이스 테스트 4개가 모두 통과했어요.\n\n- 바뀐 곳: `const TVA = 0.2`\n- 테스트: `pnpm vitest run src/invoice.test.ts` 통과', '**→ Changed the VAT rate to 0.2.** Only the `TVA` constant in `src/invoice.ts` changed, and all 4 invoice tests pass.\n\n- Changed: `const TVA = 0.2`\n- Tests: `pnpm vitest run src/invoice.test.ts` passed'),
  })
}

if (scene === 'multi') {
  const site = session('demo-site-0002', join(base, 'shop-web'))

  await site('UserPromptSubmit', { prompt: say('블로그 목록 정렬 고쳐줘', 'Fix the product list sorting') })
  await site('PreToolUse', { tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'sortPosts', path: 'src' } })
}

if (scene === 'agents') {
  await korus('PreToolUse', { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: say('로그에서 오류 원인 찾기', 'Find the error in the logs'), subagent_type: 'Explore', prompt: 'x' } })
  await korus('PreToolUse', { tool_name: 'Agent', tool_use_id: 'a2', tool_input: { description: say('테스트 실패 분석', 'Analyse the failing tests'), subagent_type: 'general-purpose', prompt: 'x' } })
  await korus('PreToolUse', { tool_name: 'Agent', tool_use_id: 'a3', tool_input: { description: say('변경 검토', 'Review the change'), subagent_type: 'code-reviewer', prompt: 'x' } })
  await korus('SubagentStart', { agent_id: 'ag-1', agent_type: 'Explore' })
  await korus('SubagentStart', { agent_id: 'ag-2', agent_type: 'general-purpose' })
  await korus('SubagentStart', { agent_id: 'ag-3', agent_type: 'code-reviewer' })

  for (const [agentId, model] of [['ag-1', 'claude-haiku-5-5'], ['ag-2', 'claude-sonnet-5-5'], ['ag-3', 'claude-opus-5-5']]) {
    await fetch(`http://127.0.0.1:${port}/mod/step`, { method: 'POST', body: JSON.stringify({ sessionId: 'demo-korus-0001', agentId, model, effort: 'medium' }) })
  }
  await korus('PreToolUse', { agent_id: 'ag-1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'ag1-g', tool_input: { pattern: 'TypeError', path: 'logs' } })
  await korus('PreToolUse', { agent_id: 'ag-2', agent_type: 'general-purpose', tool_name: 'Read', tool_use_id: 'ag2-r', tool_input: { file_path: file } })
  await korus('PreToolUse', { agent_id: 'ag-3', agent_type: 'code-reviewer', tool_name: 'Read', tool_use_id: 'ag3-r', tool_input: { file_path: file } })
  await korus('PostToolUse', { agent_id: 'ag-3', agent_type: 'code-reviewer', tool_name: 'Read', tool_use_id: 'ag3-r', tool_input: { file_path: file }, tool_response: {} })
  await korus('SubagentStop', { agent_id: 'ag-3', agent_type: 'code-reviewer', last_assistant_message: say('문제없어요. TVA 상수만 바뀌었고 테스트 기대값도 맞아요.', 'Looks good. Only the TVA constant changed and the test expectations match.') })
  await korus('PreToolUse', { tool_name: 'TodoWrite', tool_use_id: 't1', tool_input: { todos: [
    { content: say('세율 바꾸기', 'Change the rate'), status: 'completed', activeForm: say('세율 바꾸는 중', 'Changing the rate') },
    { content: say('오류 원인 찾기', 'Find the error'), status: 'in_progress', activeForm: say('오류 원인 찾는 중', 'Finding the error') },
    { content: say('테스트 고치기', 'Fix the tests'), status: 'pending', activeForm: say('테스트 고치는 중', 'Fixing the tests') },
  ] } })
  await korus('PostToolUse', { tool_name: 'TodoWrite', tool_use_id: 't1', tool_input: {}, tool_response: {} })
}

if (scene === 'images') {
  const pictures = join(root, 'shots')
  // The Android app's buddy pictures stand in for screenshots.
  const art = join(import.meta.dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable-night-nodpi')

  mkdirSync(pictures, { recursive: true })

  for (const [index, name] of ['buddy_done.png', 'buddy_search.png', 'buddy_web.png'].entries()) {
    const target = join(pictures, `screen-${index + 1}.png`)

    writeFileSync(target, readFileSync(join(art, name)))
    await korus('PreToolUse', { tool_name: 'Read', tool_use_id: `img${index}`, tool_input: { file_path: target } })
    await korus('PostToolUse', { tool_name: 'Read', tool_use_id: `img${index}`, tool_input: { file_path: target }, tool_response: {} })
  }

  const capture = readFileSync(join(art, 'buddy_edit.png')).toString('base64')

  await korus('PreToolUse', { tool_name: 'mcp__chrome__screenshot', tool_use_id: 'cap1', tool_input: { tabId: 1 } })
  await korus('PostToolUse', {
    tool_name: 'mcp__chrome__screenshot',
    tool_use_id: 'cap1',
    tool_input: { tabId: 1 },
    tool_response: [{ type: 'image', data: capture, mimeType: 'image/png' }],
  })
}

if (scene === 'pending') {
  await korus(
    'PermissionRequest',
    {
      tool_name: 'Bash',
      tool_input: { command: 'pnpm vitest run src/invoice.test.ts', description: say('인보이스 테스트 실행', 'Run the invoice tests') },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm vitest:*' }], behavior: 'allow', destination: 'localSettings' }],
    },
    false,
  )
}

if (scene === 'question') {
  await korus(
    'PermissionRequest',
    {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: say('부가세율을 어디에 두면 좋을까요?', 'Where should the VAT rate live?'),
            header: say('설정 위치', 'Setting'),
            multiSelect: false,
            options: [
              { label: say('코드 상수 (추천)', 'Code constant (recommended)'), description: say('지금처럼 invoice.ts에 두고 값만 바꿔요', 'Keep it in invoice.ts and just change the value') },
              { label: say('환경 변수', 'Environment variable'), description: say('VAT_RATE로 빼서 배포마다 바꿀 수 있게 해요', 'Move it to VAT_RATE so each deploy can set it') },
            ],
          },
        ],
      },
    },
    false,
  )
}

if (scene === 'plan') {
  await korus(
    'PermissionRequest',
    {
      tool_name: 'ExitPlanMode',
      tool_input: { plan: say('## 부가세 변경 계획\n\n1. `TVA` 상수를 0.2로 바꾼다\n2. 테스트 기대값을 새 세율로 고친다\n3. `pnpm vitest run`으로 확인한다', '## VAT change plan\n\n1. Change the `TVA` constant to 0.2\n2. Update the test expectations to the new rate\n3. Check with `pnpm vitest run`') },
    },
    false,
  )
}

// Instruction files for the docs tab: one for the user, some for the project.
const claudeHome = join(base, 'claude')

writeFileSync(join(claudeHome, 'CLAUDE.md'), say('# 언어 규칙\n\n- 답은 한국어로 쓴다.\n- 코드와 명령어는 원문 그대로 둔다.\n\n# 커밋\n\n- 작성자는 `choidevhi`로 한다.\n', '# Language\n\n- Answer in English.\n- Keep code and commands as they are.\n\n# Commits\n\n- Author: `choidevhi`.\n'))
mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
writeFileSync(join(root, 'CLAUDE.md'), say('# korus\n\n결제 화면과 관리자 화면이 함께 쓰는 인보이스 모듈.\n\n## 명령\n\n- 테스트: `pnpm vitest run`\n- 타입 검사: `pnpm tsc --noEmit`\n', '# korus\n\nInvoice module shared by checkout and the admin pages.\n\n## Commands\n\n- Tests: `pnpm vitest run`\n- Types: `pnpm tsc --noEmit`\n'))
writeFileSync(join(root, '.claude', 'agents', 'reviewer.md'), say('---\nname: reviewer\ndescription: 바뀐 코드를 읽고 위험한 곳을 짚는다\n---\n\n변경된 파일만 읽고, 고칠 곳을 3개 이내로 말한다.\n', '---\nname: reviewer\ndescription: Reads the changed code and points out what is risky\n---\n\nRead only the changed files and name at most three things to fix.\n'))

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const stream = (body: Payload): Promise<Response> => fetch(`http://127.0.0.1:${port}/mod/stream`, { method: 'POST', body: JSON.stringify(body) })

// What the mod sends while Claude types: the tool input as raw JSON so far,
// or the reply text so far. Once typed, the whole text is sent again now and
// then so it stays on screen until `seconds` are up.
async function typeOut(full: string, chunk: (sofar: string) => Payload, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000

  for (let length = 8; length < full.length && Date.now() < until; length += 12) {
    await stream(chunk(full.slice(0, length)))
    await sleep(120)
  }

  while (Date.now() < until) {
    await stream(chunk(full))
    await sleep(2000)
  }
}

const vatFile = join(root, 'src', 'vat.ts')
const vatCode = [
  '// VAT rates by year, so old invoices keep the rate they were issued with.',
  "import type { Invoice } from './types'",
  '',
  'const RATES: Record<number, number> = {',
  '  2024: 0.196,',
  '  2025: 0.196,',
  '  2026: 0.2,',
  '}',
  '',
  'export function vatRate(invoice: Invoice): number {',
  '  const year = new Date(invoice.issuedAt).getFullYear()',
  '',
  '  return RATES[year] ?? RATES[2026]',
  '}',
  '',
].join('\n')

if (scene === 'live') {
  await korus('PostToolUse', { ...read, tool_response: {} })
  await typeOut(
    vatCode,
    sofar => ({ sessionId: 'demo-korus-0001', toolUseId: 'w1', tool: 'Write', json: JSON.stringify({ file_path: vatFile, content: sofar }).slice(0, -2) }),
    Number(arg('--hold', '20')),
  )
}

// A slash command sent from the widget, and what it printed.
if (scene === 'command') {
  await korus('PostToolUse', { ...read, tool_response: {} })
  await korus('Stop', { last_assistant_message: say('`src/invoice.ts`를 읽었어요.', 'I read `src/invoice.ts`.') })
  await fetch(`http://127.0.0.1:${port}/mod/command-result`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'demo-korus-0001', id: 'cmd-1', command: 'effort', args: 'max', text: 'Set effort level to max', failed: false }),
  })
}

if (scene === 'reply') {
  await korus('PostToolUse', { ...read, tool_response: {} })
  await typeOut(
    say('`src/invoice.ts`를 읽어 봤어요. **`TVA` 상수가 0.196으로 고정**돼 있어서 2026년 인보이스도 옛 세율로 계산돼요.\n\n- 연도별 세율 표를 `src/vat.ts`로 빼고\n- `total()`이 인보이스 발행 연도의 세율을 쓰게 바꿀게요.', 'I read `src/invoice.ts`. **The `TVA` constant is fixed at 0.196**, so 2026 invoices still use the old rate.\n\n- I will move the rates per year into `src/vat.ts`\n- and make `total()` use the rate of the invoice year.'),
    sofar => ({ sessionId: 'demo-korus-0001', text: sofar }),
    Number(arg('--hold', '20')),
  )
}

console.log(`scene ${scene} sent to port ${port}`)

// A pending request lives as long as its hook call is open, so those scenes
// keep the process (and the request) around for a while.
const holdSeconds = Number(arg('--hold', '60'))

setTimeout(() => process.exit(0), scene === 'pending' || scene === 'question' || scene === 'plan' ? holdSeconds * 1000 : 0)
