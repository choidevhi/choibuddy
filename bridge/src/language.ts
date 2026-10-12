// Auto language: when Claude finishes a reply in another language than the
// person's, the bridge asks the session once to say it again in theirs.

export const LANGS = ['ko', 'en', 'ja', 'fr'] as const

export type Lang = (typeof LANGS)[number]

export function parseLang(value: string | null): Lang | null {
  return LANGS.find(lang => lang === value) ?? null
}

// Fewer weighted letters than this is too little to tell ("Done.").
const MIN_WEIGHT = 20
// A reply counts as Korean or Japanese once that script makes up this share,
// so English names and terms inside it do not flip it.
const SCRIPT_SHARE = 0.3
// Latin letters per Hangul syllable or kana, roughly, to weigh them alike.
const LETTERS_PER_SYLLABLE = 3

const FRENCH = new Set(['le', 'la', 'les', 'des', 'du', 'une', 'est', 'et', 'pour', 'que', 'qui', 'pas', 'vous', 'avec', 'sur', 'dans', 'ce', 'cette', 'sont', 'il', 'elle', 'au', 'aux', 'je', 'ne', 'mais', 'ou'])
const ENGLISH = new Set(['the', 'and', 'is', 'to', 'of', 'in', 'for', 'it', 'that', 'with', 'you', 'this', 'are', 'on', 'be', 'was', 'not', 'but', 'or', 'as', 'have', 'has', 'can', 'will', 'i'])

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

// Code, paths and links say nothing about the language of the words around them.
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S*[\\/]\S*/g, ' ')
}

// Which of the app's languages a reply is written in; null when it is too
// short, or mostly code, to tell.
export function detectLanguage(text: string): Lang | null {
  const words = prose(text)
  const hangul = count(words, /[가-힣ᄀ-ᇿ㄰-㆏]/g)
  const kana = count(words, /[぀-ヿ]/g)
  const han = count(words, /[一-鿿]/g)
  const latin = count(words, /[A-Za-zÀ-ÿ]/g) / LETTERS_PER_SYLLABLE
  const japanese = kana > 0 ? kana + han : 0
  const total = hangul + japanese + latin

  if (total < MIN_WEIGHT) return null
  if (hangul / total >= SCRIPT_SHARE) return 'ko'
  if (japanese / total >= SCRIPT_SHARE) return 'ja'

  let french = 0
  let english = 0

  for (const word of words.toLowerCase().match(/[a-zà-ÿ']+/g) ?? []) {
    if (FRENCH.has(word)) french += 1
    if (ENGLISH.has(word)) english += 1
  }

  french += count(words, /[àâçèéêëîïôùûœ]/g) / 4

  return french > english ? 'fr' : 'en'
}

// What the bridge sends, in the language wanted.
export const RESTATE_PROMPT: Record<Lang, string> = {
  ko: '방금 한 답변을 한국어로 다시 알려 주세요. 작업은 다시 하지 말고 내용만 옮겨 주세요.',
  en: 'Please give me your last reply again in English. Do not redo any work, just restate it.',
  ja: '今の回答を日本語でもう一度伝えてください。作業はやり直さず、内容だけ訳してください。',
  fr: 'Redonne-moi ta dernière réponse en français, s’il te plaît. Ne refais aucun travail, reformule-la seulement.',
}

// Follows each session's turns: a reply in another language asks for a
// restatement, but never the reply to a restatement (no loop).
export class AutoLanguage {
  readonly #restating = new Set<string>()

  // A prompt went in; the turn it starts is a restatement or not.
  onPrompt(sessionId: string, prompt: string): void {
    if (LANGS.some(lang => RESTATE_PROMPT[lang] === prompt.trim())) this.#restating.add(sessionId)
    else this.#restating.delete(sessionId)
  }

  // The turn ended with `reply`: the prompt to send, or null.
  onStop(sessionId: string, reply: string, wanted: Lang | null): string | null {
    const restated = this.#restating.delete(sessionId)

    if (wanted === null || restated) return null

    const said = detectLanguage(reply)

    return said === null || said === wanted ? null : RESTATE_PROMPT[wanted]
  }
}
