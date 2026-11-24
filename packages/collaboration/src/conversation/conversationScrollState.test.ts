// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import {
  createConversationScrollState,
  type ConversationScrollInput,
} from './conversationScrollState'
import type { ConversationVirtualizer } from './useConversationVirtualizer'

it('follows the measured transcript end without scrolling into temporary Markdown overflow', () => {
  const viewport = document.createElement('div')
  let scrollHeight = 1603
  let virtualSize = 1602
  Object.defineProperties(viewport, {
    clientHeight: { value: 643 },
    scrollHeight: { get: () => scrollHeight },
  })
  viewport.scrollTop = 960
  const virtualizer = {
    options: { scrollMargin: 1 },
    getTotalSize: () => virtualSize,
    cancelScroll: vi.fn(),
    scrollToOffset: (top: number) => {
      viewport.scrollTop = Math.min(top, viewport.scrollHeight - viewport.clientHeight)
    },
  } as unknown as ConversationVirtualizer
  const input: ConversationScrollInput = {
    messages: [
      {
        id: 'reply',
        role: 'assistant',
        content: 'Done',
        status: 'done',
        createdAt: '',
      },
    ],
    scrollRef: { current: viewport },
    geometry: null,
  }
  const state = createConversationScrollState(null, input)
  const dispose = state.subscribe(() => {}, input, {
    scrollRef: input.scrollRef,
    externalScrollInteractionRef: undefined,
    contentRef: { current: null },
    virtualizerRef: { current: virtualizer },
    owner: { lease: null },
  })

  // An unmeasured overscan row temporarily contributes a tall Markdown placeholder.
  scrollHeight = 1691
  state.handleVirtualLayoutChange()
  expect(viewport.scrollTop).toBe(960)

  // Real content becomes scrollable when its DOM range and virtual size catch up.
  virtualSize = 1622
  scrollHeight = 1623
  state.handleVirtualLayoutChange()
  expect(viewport.scrollTop).toBe(980)
  dispose()
})
