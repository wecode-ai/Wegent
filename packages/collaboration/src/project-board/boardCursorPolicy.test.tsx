// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { registerBoardCursorPolicy } from './boardCursorPolicy'

const cleanups: (() => void)[] = []
const boardCursorCss = readFileSync('src/project-board/board-cursor.css', 'utf8')

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach(cleanup => cleanup())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function board() {
  const ancestor = document.createElement('section')
  const element = document.createElement('div')
  ancestor.append(element)
  document.body.append(ancestor)
  cleanups.push(registerBoardCursorPolicy(element)!)
  return { ancestor, element }
}

test.each([
  ['hidden', ''],
  ['inert', ''],
  ['aria-hidden', 'true'],
  ['class', 'hidden'],
  ['style', 'display: none'],
])('releases and restores the page cursor when an ancestor changes %s', async (name, value) => {
  const { ancestor } = board()
  expect(document.body.dataset.boardCursorPolicy).toBe('arrow')
  ancestor.setAttribute(name, value)
  await Promise.resolve()
  expect(document.body.dataset.boardCursorPolicy).toBeUndefined()
  ancestor.removeAttribute(name)
  await Promise.resolve()
  expect(document.body.dataset.boardCursorPolicy).toBe('arrow')
})

test('keeps the policy until the last visible owner leaves', async () => {
  const first = board()
  const second = board()
  first.ancestor.hidden = true
  await Promise.resolve()
  expect(document.body.dataset.boardCursorPolicy).toBe('arrow')
  cleanups.pop()!()
  expect(document.body.dataset.boardCursorPolicy).toBeUndefined()
  first.ancestor.hidden = false
  await Promise.resolve()
  expect(document.body.dataset.boardCursorPolicy).toBe('arrow')
  expect(second.element.isConnected).toBe(true)
})

test('ignores descendant scroll styles and classes without reevaluating visibility', async () => {
  const { ancestor, element } = board()
  const row = document.createElement('div')
  element.append(row)
  const visibilityRead = vi.spyOn(ancestor, 'hasAttribute')
  const policyWrite = vi.spyOn(document.body, 'setAttribute')
  for (let index = 0; index < 20; index++) {
    row.style.transform = `translateY(${index * 10}px)`
    row.className = `row-${index}`
    await Promise.resolve()
  }
  expect(visibilityRead).not.toHaveBeenCalled()
  expect(policyWrite).not.toHaveBeenCalled()
})

test('applies to portaled controls and preserves drag, text and resize cursors', () => {
  const cursors = [
    'grab',
    'grabbing',
    'move',
    'text',
    'wait',
    'not-allowed',
    'col-resize',
    'row-resize',
    'ew-resize',
    'ns-resize',
  ]
  const style = document.createElement('style')
  style.textContent = `button { cursor: pointer; }
    ${cursors.map(cursor => `.cursor-${cursor} { cursor: ${cursor}; }`).join('\n')}
    ${boardCursorCss}`
  document.head.append(style)
  cleanups.push(() => style.remove())
  const portal = document.createElement('div')
  document.body.append(portal)
  const control = document.createElement('button')
  portal.append(control)
  expect(getComputedStyle(control).cursor).toBe('pointer')
  board()
  expect(getComputedStyle(control).cursor).toBe('default')
  for (const cursor of cursors) {
    control.className = `cursor-${cursor}`
    expect(getComputedStyle(control).cursor).toBe(cursor)
  }
  cleanups.pop()!()
  control.className = ''
  expect(getComputedStyle(control).cursor).toBe('pointer')
})

test('cleans up callback refs through strict mounting and unmounting', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      <StrictMode>
        <div ref={registerBoardCursorPolicy} />
      </StrictMode>
    )
  )
  expect(document.body.dataset.boardCursorPolicy).toBe('arrow')
  act(() => root.unmount())
  expect(document.body.dataset.boardCursorPolicy).toBeUndefined()
})
