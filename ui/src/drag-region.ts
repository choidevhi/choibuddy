// Tauri's rule for data-tauri-drag-region (its drag.js), kept apart from the
// DOM so it can be tested: a bare or "true" value counts only on the element
// itself, "deep" for its whole subtree, "false" blocks; a clickable element
// in between blocks too. Any other value is passed over, as Tauri does.

// What the rule reads of an element on the event's path. null stands for a
// target that is not an HTML element (an SVG icon, the document): skipped.
export type DragNode = {
  tagName: string
  getAttribute(name: string): string | null
}

const CLICKABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'])
const ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'])

function clickable(node: DragNode): boolean {
  const editable = node.getAttribute('contenteditable')
  const tabindex = node.getAttribute('tabindex')

  return CLICKABLE.has(node.tagName) || (editable !== null && editable !== 'false') || (tabindex !== null && tabindex !== '-1') || ROLES.has(node.getAttribute('role') ?? '')
}

// path runs from the pressed target up, as composedPath() gives it.
export function inDragRegion(path: readonly (DragNode | null)[]): boolean {
  for (const [index, node] of path.entries()) {
    if (node === null) continue

    const value = node.getAttribute('data-tauri-drag-region')

    if (value === null && clickable(node)) return false
    if (value === 'false') return false
    if (value === 'deep') return true
    if (value === '' || value === 'true') return index === 0
  }

  return false
}
