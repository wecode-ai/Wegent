// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MessageHoverActions } from './MessageHoverActions'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

vi.mock('../markdown/MarkdownServices', () => ({
  useMarkdownServices: () => ({ copyText: async () => {} }),
}))
vi.mock('./ConversationTranslation', () => ({
  useConversationTranslation: () => ({ t: (key: string) => key }),
}))

it('retains repeated-copy feedback until an actual hide transition completes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div')
  const root = createRoot(node)
  const message = { content: 'Hello', createdAt: '' } as WorkbenchMessage
  const show = (visible: boolean) =>
    root.render(<MessageHoverActions message={message} align="left" visible={visible} />)
  const copied = () => Boolean(node.querySelector('[data-testid="copy-message-success-icon"]'))
  const transition = (propertyName: string) => {
    const event = new Event('transitionend', { bubbles: true })
    Object.defineProperty(event, 'propertyName', { value: propertyName })
    node.querySelector('[data-testid="message-hover-actions"]')!.dispatchEvent(event)
  }
  const copy = () =>
    node.querySelector<HTMLButtonElement>('[data-testid="copy-message-button"]')!.click()
  try {
    await act(async () => show(true))
    await act(async () => copy())
    expect(copied()).toBe(true)
    await act(async () => copy())
    act(() => transition('opacity'))
    expect(copied()).toBe(true)
    await act(async () => show(false))
    act(() => transition('transform'))
    expect(copied()).toBe(true)
    act(() => transition('opacity'))
    expect(copied()).toBe(false)
    await act(async () => copy())
    expect(copied()).toBe(true)
    act(() => transition('opacity'))
    expect(copied()).toBe(false)
  } finally {
    await act(async () => root.unmount())
  }
})
