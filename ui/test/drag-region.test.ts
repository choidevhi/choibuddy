import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type DragNode, inDragRegion } from '../src/drag-region.ts'

const node = (tagName: string, attributes: Record<string, string> = {}): DragNode => ({
  tagName,
  getAttribute: name => attributes[name] ?? null,
})

const bar = node('HEADER', { 'data-tauri-drag-region': '' })
const deep = node('HEADER', { 'data-tauri-drag-region': 'deep' })
const span = node('SPAN')

test('a bare or "true" region counts only when pressed itself', () => {
  assert.equal(inDragRegion([bar]), true)
  assert.equal(inDragRegion([span, bar]), false)
  assert.equal(inDragRegion([node('DIV', { 'data-tauri-drag-region': 'true' })]), true)
  assert.equal(inDragRegion([span, node('DIV', { 'data-tauri-drag-region': 'true' })]), false)
})

test('a deep region counts for its whole subtree', () => {
  assert.equal(inDragRegion([span, node('DIV'), deep]), true)
  assert.equal(inDragRegion([span, node('DIV', { 'data-tauri-drag-region': 'false' }), deep]), false)
})

test('a clickable element in between blocks the drag', () => {
  assert.equal(inDragRegion([span, node('BUTTON'), deep]), false)
  assert.equal(inDragRegion([node('DIV', { role: 'tab' }), deep]), false)
  assert.equal(inDragRegion([node('DIV', { tabindex: '0' }), deep]), false)
  assert.equal(inDragRegion([node('DIV', { contenteditable: '' }), deep]), false)

  // Not clickable after all, or a region of its own.
  assert.equal(inDragRegion([node('DIV', { tabindex: '-1' }), deep]), true)
  assert.equal(inDragRegion([node('DIV', { contenteditable: 'false' }), deep]), true)
  assert.equal(inDragRegion([node('BUTTON', { 'data-tauri-drag-region': '' })]), true)
})

test('other values and non-HTML targets are passed over, as Tauri does', () => {
  assert.equal(inDragRegion([node('DIV', { 'data-tauri-drag-region': 'yes' }), deep]), true)
  assert.equal(inDragRegion([node('DIV', { 'data-tauri-drag-region': 'yes' })]), false)

  // An SVG icon pressed inside the bar: the bar was not pressed itself.
  assert.equal(inDragRegion([null, bar]), false)
  assert.equal(inDragRegion([null, deep]), true)
  assert.equal(inDragRegion([span, node('MAIN'), null]), false)
})
