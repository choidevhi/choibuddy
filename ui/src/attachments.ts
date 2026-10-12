// Claude Code takes no files from a plugin's prompt, so attachments are
// uploaded to the session's PC and the prompt lists their paths for Claude
// to open. The chat reads the list back to show the files as pictures.
const ATTACHED_HEAD = 'Attached files (open them with the Read tool):'

export function attachmentNote(paths: string[]): string {
  return paths.length === 0 ? '' : `\n\n${ATTACHED_HEAD}\n${paths.map(path => `- ${path}`).join('\n')}`
}

// A prompt's own words and the files listed under them.
export function splitAttachments(text: string): { body: string; paths: string[] } {
  const at = text.lastIndexOf(ATTACHED_HEAD)

  if (at === -1) return { body: text, paths: [] }

  const paths = text
    .slice(at + ATTACHED_HEAD.length)
    .split(/\r?\n/)
    .flatMap(line => (line.startsWith('- ') ? [line.slice(2).trim()] : []))

  return { body: text.slice(0, at).trimEnd(), paths }
}

// The name a file was attached with (uploads get an 8-character prefix on the PC).
export function attachedName(path: string): string {
  return (path.split(/[\\/]/).at(-1) ?? path).replace(/^[0-9a-f]{8}-/, '')
}
