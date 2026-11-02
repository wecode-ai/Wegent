import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'
import type { WorkbenchMessage } from '@/types/workbench'
import '@/i18n'

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

class LayoutObserver implements ResizeObserver {
  static instances: LayoutObserver[] = []
  targets = new Set<Element>()

  constructor(private callback: ResizeObserverCallback) {
    LayoutObserver.instances.push(this)
  }

  observe = (element: Element) => this.targets.add(element)
  unobserve = (element: Element) => this.targets.delete(element)
  disconnect = () => this.targets.clear()

  static resize(element: Element) {
    const rect = element.getBoundingClientRect()
    const entry = {
      target: element,
      contentRect: rect,
      borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
    } as ResizeObserverEntry
    for (const observer of [...this.instances]) {
      if (observer.targets.has(element)) observer.callback([entry], observer)
    }
  }
}

describe.each(['start', 'end'] as const)(
  'MessageList cached pane measurements (anchor=%s)',
  virtualAnchor => {
    const heights = new Map<string, number>()
    let hidden: boolean

    beforeEach(() => {
      hidden = false
      heights.clear()
      LayoutObserver.instances = []
      vi.stubGlobal('ResizeObserver', LayoutObserver)
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
        return this.isConnected && !hidden ? 736 : 0
      })
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
        return this.getBoundingClientRect().height
      })
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
        if (!this.isConnected || hidden) return new DOMRect()
        const messageId = this.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId
        const height = this.hasAttribute('data-index') ? (heights.get(messageId ?? '') ?? 80) : 600
        return new DOMRect(0, 0, 736, height)
      })
    })

    afterEach(() => {
      clearRuntimeConversationCacheForTests()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    })

    function mountConversation() {
      const scroller = document.createElement('div')
      Object.defineProperties(scroller, {
        clientHeight: { value: 800 },
        scrollHeight: { value: 2_000 },
      })
      scroller.scrollTo = vi.fn()
      document.body.append(scroller)
      heights.set('assistant', 240)
      const messages: WorkbenchMessage[] = [
        message('user', 'user'),
        message('assistant', 'assistant', 'streaming'),
        message('guidance', 'user'),
      ]
      const props = {
        messages,
        virtualAnchor,
        conversationKey: 'cached-pane',
        scrollElementRef: { current: scroller },
      }
      const view = render(<MessageList {...props} />, { container: scroller })
      return {
        ...view,
        props,
        list: scroller.firstElementChild as HTMLElement,
        row: (id: string) =>
          scroller.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!.parentElement!,
      }
    }

    test('preserves measured row heights when a detached conversation streams in the background', () => {
      const view = mountConversation()
      const height = view.list.style.height
      view.container.remove()

      view.rerender(
        <MessageList
          {...view.props}
          messages={view.props.messages.map(item =>
            item.id === 'assistant' ? { ...item, content: 'Background streaming update' } : item
          )}
        />
      )

      expect(view.list.style.height).toBe(height)
    })

    test('does not collapse existing rows when guidance is inserted into a hidden conversation', () => {
      const view = mountConversation()
      const previousHeight = Number.parseFloat(view.list.style.height)
      hidden = true

      view.rerender(
        <MessageList
          {...view.props}
          messages={[
            view.props.messages[0],
            message('new-guidance', 'user'),
            ...view.props.messages.slice(1),
          ]}
        />
      )

      expect(Number.parseFloat(view.list.style.height)).toBeGreaterThan(previousHeight)
    })

    test('preserves measured heights when a connected pane is hidden by its parent', () => {
      const view = mountConversation()
      const height = view.list.style.height
      hidden = true

      act(() => LayoutObserver.resize(view.row('assistant')))

      expect(view.list.style.height).toBe(height)
    })

    test('measures a conversation first mounted without layout when it becomes visible', () => {
      hidden = true
      const view = mountConversation()
      hidden = false

      act(() => LayoutObserver.resize(view.container))
      act(() => LayoutObserver.resize(view.list))

      expect(view.list.style.height).toBe('472px')
    })

    test('remeasures and observes rows again after the cached pane reconnects', () => {
      const view = mountConversation()
      const row = view.row('assistant')
      view.container.remove()
      act(() => {
        LayoutObserver.resize(row)
        LayoutObserver.resize(view.list)
      })
      expect(LayoutObserver.instances.some(observer => observer.targets.has(row))).toBe(false)
      heights.set('assistant', 360)
      document.body.append(view.container)

      act(() => LayoutObserver.resize(view.list))

      const restoredRow = view.row('assistant')
      expect(LayoutObserver.instances.some(observer => observer.targets.has(restoredRow))).toBe(
        true
      )
      expect(view.list.style.height).toBe('592px')
      heights.set('assistant', 400)
      act(() => LayoutObserver.resize(restoredRow))
      expect(view.list.style.height).toBe('632px')
    })
  }
)

function message(
  id: string,
  role: WorkbenchMessage['role'],
  status: WorkbenchMessage['status'] = 'done'
): WorkbenchMessage {
  return { id, role, status, content: id, createdAt: '2026-11-02T00:00:00Z' }
}
