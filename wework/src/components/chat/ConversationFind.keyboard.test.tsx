import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useConversationFind } from './useConversationFind'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))
const props = { conversationKey: 'a', messages: [], loading: false }
function inputIn(tag = 'div') {
  const parent = document.createElement(tag)
  parent.dataset.keyboardFixture = ''
  const input = document.createElement('input')
  parent.append(input)
  document.body.append(parent)
  return { parent, input }
}
afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-keyboard-fixture]').forEach(node => node.remove())
  vi.restoreAllMocks()
})

test('native open dialogs retain their own Cmd+F and Escape events', () => {
  const { result } = renderHook(() => useConversationFind(props, true))
  const { parent, input } = inputIn('dialog')
  parent.setAttribute('open', '')
  const command = new KeyboardEvent('keydown', {
    key: 'f',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  fireEvent(input, command)
  expect(command.defaultPrevented).toBe(false)
  expect(result.current.open).toBe(false)
  act(() => {
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
  })
  expect(result.current.open).toBe(true)
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  fireEvent(input, escape)
  expect(escape.defaultPrevented).toBe(false)
  expect(result.current.open).toBe(true)
})

test.each([
  'cm-editor',
  'xterm',
  'data-editor-search-surface',
  'data-pierre-editor-surface',
  'workspace-browser-find-bar',
  'dialog-role',
])('preserves search ownership for %s', surface => {
  const { result } = renderHook(() => useConversationFind(props, true))
  const { parent, input } = inputIn()
  if (surface === 'cm-editor' || surface === 'xterm') parent.className = surface
  else if (surface === 'dialog-role') parent.setAttribute('role', 'dialog')
  else if (surface === 'workspace-browser-find-bar') parent.dataset.testid = surface
  else parent.setAttribute(surface, '')
  fireEvent.keyDown(input, { key: 'f', metaKey: true })
  expect(result.current.open).toBe(false)
})

test('IME and previously consumed shortcuts do not open find', () => {
  const { result } = renderHook(() => useConversationFind(props, true))
  fireEvent.keyDown(window, { key: 'f', metaKey: true, isComposing: true })
  expect(result.current.open).toBe(false)
  const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
  event.preventDefault()
  fireEvent(window, event)
  expect(result.current.open).toBe(false)
})

test('repeated Cmd+F retains the original focus owner and closing restores it', () => {
  const { result } = renderHook(() => useConversationFind(props, true))
  const opener = inputIn().input
  const search = inputIn().input
  opener.focus()
  fireEvent.keyDown(opener, { key: 'f', metaKey: true })
  search.focus()
  fireEvent.keyDown(search, { key: 'f', metaKey: true })
  expect(result.current.focusRequest).toBe(2)
  act(() => result.current.close())
  expect(opener).toHaveFocus()
})

test('conversation changes do not restore a previous conversation focus owner', () => {
  const { result, rerender } = renderHook(
    ({ conversationKey }) => useConversationFind({ ...props, conversationKey }, true),
    {
      initialProps: { conversationKey: 'a' },
    }
  )
  const old = inputIn().input
  const current = inputIn().input
  old.focus()
  fireEvent.keyDown(old, { key: 'f', metaKey: true })
  rerender({ conversationKey: 'b' })
  current.focus()
  act(() => result.current.close())
  expect(current).toHaveFocus()
})

test('inactive panes ignore shortcuts and unmount releases the keyboard binding', () => {
  const add = vi.spyOn(window, 'addEventListener')
  const remove = vi.spyOn(window, 'removeEventListener')
  const { result, rerender, unmount } = renderHook(
    ({ active }) => useConversationFind(props, active),
    { initialProps: { active: false } }
  )
  fireEvent.keyDown(window, { key: 'f', metaKey: true })
  expect(result.current.open).toBe(false)
  rerender({ active: true })
  fireEvent.keyDown(window, { key: 'f', metaKey: true })
  expect(result.current.open).toBe(true)
  const handler = add.mock.calls.find(([event]) => event === 'keydown')?.[1]
  expect(handler).toBeDefined()
  unmount()
  expect(
    remove.mock.calls.some(([event, listener]) => event === 'keydown' && listener === handler)
  ).toBe(true)
  const after = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
  fireEvent(window, after)
  expect(after.defaultPrevented).toBe(false)
})
