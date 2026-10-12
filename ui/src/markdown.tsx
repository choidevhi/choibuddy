import type { ReactNode } from 'react'

// Claude's replies are Markdown. This renders the common parts (headings,
// lists, fences, **bold**, `code`) as plain React nodes, so nothing from the
// message is ever injected as HTML.

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    const key = `${keyBase}-${index}`

    if (part === '') return null
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key}>{inline(part.slice(2, -2), key)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>

    return part
  })
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let fence: string[] | null = null
  let paragraph: string[] = []

  const flush = (): void => {
    if (paragraph.length === 0) return

    const key = `p${blocks.length}`

    blocks.push(<p key={key}>{inline(paragraph.join(' '), key)}</p>)
    paragraph = []
  }

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (fence === null) {
        flush()
        fence = []
      } else {
        blocks.push(<pre key={`f${blocks.length}`}>{fence.join('\n')}</pre>)
        fence = null
      }
      continue
    }

    if (fence !== null) {
      fence.push(line)
      continue
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)

    if (heading?.[1] !== undefined) {
      flush()

      const key = `h${blocks.length}`

      blocks.push(<h4 key={key}>{inline(heading[1], key)}</h4>)
    } else if (item?.[1] !== undefined) {
      flush()

      const key = `l${blocks.length}`

      blocks.push(
        <div className="md-item" key={key}>
          <span className="md-dot" />
          <span>{inline(item[1], key)}</span>
        </div>,
      )
    } else if (line.trim() === '') {
      flush()
    } else {
      paragraph.push(line.trim())
    }
  }

  flush()
  if (fence !== null) blocks.push(<pre key={`f${blocks.length}`}>{fence.join('\n')}</pre>)

  return <div className="md">{blocks}</div>
}
