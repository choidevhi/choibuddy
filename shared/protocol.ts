// Wire format shared by the bridge (Node), the UI and the native shells.
// Keep it to erasable TypeScript so Node can run it without a build step.

export const PROTOCOL_VERSION = 2

export const DEFAULT_PORT = 47130

export type StepKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'bash'
  | 'search'
  | 'web'
  | 'agent'
  | 'todo'
  | 'question'
  | 'plan'
  | 'mcp'
  | 'other'

export type StepStatus = 'running' | 'done' | 'failed' | 'denied'

export type LineMark = 'add' | 'del' | 'focus' | 'none'

export type CodeLine = {
  n: number | null
  text: string
  mark: LineMark
}

export type CodePreview = {
  type: 'code'
  path: string
  language: string
  lines: CodeLine[]
}

export type TerminalPreview = {
  type: 'terminal'
  command: string
  output: string
  failed: boolean
}

export type TextPreview = {
  type: 'text'
  title: string
  text: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type TodoItem = {
  content: string
  status: TodoStatus
}

export type TodoPreview = {
  type: 'todos'
  items: TodoItem[]
}

export type ImagePreview = {
  type: 'image'
  imageId: string
  name: string
}

export type Preview = CodePreview | TerminalPreview | TextPreview | TodoPreview | ImagePreview

export type ImageSource = 'file' | 'capture'

// An image Claude looked at (a file it read) or got back from a tool (a
// screenshot), kept so it can be browsed later. Bytes come from /api/image/<id>.
export type GalleryImage = {
  id: string
  sessionId: string
  sessionName: string
  name: string
  path: string | null
  source: ImageSource
  tool: string
  mime: string
  at: number
}

export type GallerySummary = {
  count: number
  latestAt: number
}

export type Step = {
  id: string
  tool: string
  kind: StepKind
  title: string
  status: StepStatus
  startedAt: number
  endedAt: number | null
  preview: Preview | null
  agent: string | null
}

export type AgentStatus = 'running' | 'done'

// A subagent (Agent/Task tool) with the tool calls it made on its own.
export type Agent = {
  id: string
  type: string
  description: string
  status: AgentStatus
  startedAt: number
  endedAt: number | null
  steps: Step[]
  message: string | null
  // The model its requests use, once the companion mod has seen one.
  model: string | null
}

// Token figures from the companion mod (turn.step / session.measure).
export type SessionUsage = {
  model: string | null
  // low, medium, high, xhigh, max, or a number; null for a model without one.
  effort: string | null
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
}

export type RateLimit = {
  kind: string
  percentUsed: number
  resetsAt: string | null
}

// Account-wide windows (five_hour, seven_day, ...), latest reading from any session.
export type Limits = {
  windows: RateLimit[]
  at: number
}

// 'note' marks something that happened in between, like the conversation
// being compacted (text 'compacted').
export type ChatRole = 'user' | 'assistant' | 'note'

// One message of a session's conversation, read from its transcript file.
export type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  at: number
}

export type Conversation = {
  sessionId: string
  title: string
  messages: ChatMessage[]
  // Index of messages[0] in the whole conversation, for loading older ones.
  start: number
  total: number
}

// A session found on disk (any time) or live right now.
export type HistoryEntry = {
  sessionId: string
  agent: AgentKind
  project: string
  cwd: string
  title: string
  updatedAt: number
  live: boolean
  // Put away by the person (ended sessions only): listed under the archive.
  archived: boolean
}

export type SessionStatus = 'thinking' | 'working' | 'waiting' | 'done' | 'idle' | 'error' | 'ended'

// Which coding agent runs the session. Codex reports through its hooks only:
// no prompts, commands or live text from a device.
export type AgentKind = 'claude' | 'codex'

export type Session = {
  id: string
  agent: AgentKind
  name: string
  cwd: string
  status: SessionStatus
  mode: string
  startedAt: number
  updatedAt: number
  turnStartedAt: number
  prompt: string | null
  message: string | null
  steps: Step[]
  todos: TodoItem[]
  subagents: number
  toolCount: number
  usage: SessionUsage | null
  agents: Agent[]
  // True while the companion mod in that session is polling, which is what
  // delivers prompts sent from the widget or the phone.
  canPrompt: boolean
  // Sent from a device and not yet read by Claude.
  queued: QueuedItem[]
  // Slash commands sent from the widget or the phone, with what they printed.
  commandLog: CommandResult[]
  // True once the mod listed the session's slash commands, so "/name" sent
  // from a device runs as a command instead of reaching Claude as text.
  canCommand: boolean
  // The session runs an older companion mod than the one installed on its
  // PC; /reload-plugins brings it up to date.
  modOutdated: boolean
}

// How a prompt meets a turn that is still running: steer (the turn stops once
// the running tool finishes and the prompt goes in next), queue (wait for the
// turn to end), or interrupt (stop it now).
export type PromptMode = 'steer' | 'queue' | 'interrupt'

export const PROMPT_MODES = ['steer', 'queue', 'interrupt'] as const satisfies readonly PromptMode[]

export type QueuedItem = {
  text: string
  mode: PromptMode | 'command'
}

// A slash command the session offers (built-in, plugin, MCP, skill).
export type CommandInfo = {
  name: string
  description: string
  source: string
}

export type CommandResult = {
  id: string
  command: string
  args: string
  text: string
  failed: boolean
  at: number
}

// A folder Claude Code ran in, offered when opening a new session.
export type Project = {
  cwd: string
  name: string
  lastUsed: number
}

// The bridge asks the widget for what its browser shows (Claude's
// browser_view tool); the widget answers through /api/browser/answer.
export type BrowserRequest = {
  id: string
  sessionId: string
}

export type PendingKind = 'permission' | 'question' | 'plan'

export type QuestionOption = {
  label: string
  description: string
}

export type Question = {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

export type Pending = {
  id: string
  sessionId: string
  sessionName: string
  kind: PendingKind
  tool: string
  // What is being asked about, without any wording around it (a command, a
  // file name, the first question): the UI adds the words in its language.
  detail: string
  preview: Preview | null
  canAlwaysAllow: boolean
  questions: Question[]
  plan: string | null
  createdAt: number
}

export type PromptRequest = {
  sessionId: string
  text: string
}

export type DecisionBehavior = 'allow' | 'deny' | 'always'

export type Decision = {
  id: string
  behavior: DecisionBehavior
  message: string | null
  answers: Record<string, string> | null
}

// Code or text Claude is still writing, sent while the model streams.
export type LiveStream = {
  sessionId: string
  // A tool call being written (Edit, Write…), or Claude's reply text when null.
  toolUseId: string | null
  tool: string | null
  path: string | null
  language: string
  // Only the end of a long text is sent; this many lines came before it.
  skippedLines: number
  text: string
  at: number
}

export type DocFile = {
  id: string
  label: string
  path: string
  exists: boolean
  size: number
  mtime: number
}

// Instruction files for the user (key 'user') or one project folder.
export type DocGroup = {
  key: string
  title: string
  cwd: string | null
  files: DocFile[]
}

export type ServerInfo = {
  // Stable per installation: tells two addresses of the same PC apart from two PCs.
  pcId: string
  hostName: string
  tailnetUrl: string | null
  version: string
  // Permission requests are approved without asking until then (0: off).
  autoAcceptUntil: number
  // The person's own Tailscale devices connect without a code.
  trustTailnet: boolean
  // A reply in another language is asked again in this one (ko, en, ja,
  // fr); null: off.
  autoLanguage: string | null
}

export type Snapshot = {
  protocol: number
  serverTime: number
  server: ServerInfo
  sessions: Session[]
  pending: Pending[]
  limits: Limits | null
  gallery: GallerySummary
}

export type DeviceInfo = {
  id: string
  name: string
  createdAt: number
  lastSeen: number | null
  online: boolean
}

export type AlertType = 'pending' | 'resolved' | 'done' | 'error' | 'notice' | 'auto'

// `text` is content only (a command, Claude's reply, an error), never UI
// wording, so every client can phrase the alert in its own language.
export type Alert = {
  type: AlertType
  sessionId: string
  sessionName: string
  text: string
  pendingId: string | null
  pendingKind: PendingKind | null
  at: number
}

// Text-preview titles and texts starting with this are message keys the UI
// translates (for example '@question'); anything else is shown as is.
export const KEY_PREFIX = '@'

export const PAIRING_SCHEME = 'choibuddy://pair'

export function pairingLink(baseUrl: string, token: string): string {
  return `${PAIRING_SCHEME}?u=${encodeURIComponent(baseUrl)}&t=${encodeURIComponent(token)}`
}
