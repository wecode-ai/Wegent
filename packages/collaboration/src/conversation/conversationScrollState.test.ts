// @vitest-environment jsdom
import { expect, it } from 'vitest'

import {
  createConversationScrollState,
  type ConversationScrollInput,
} from './conversationScrollState'

it('follows the bottom as an automatically loaded transcript gap expands the history', async () => {
  const viewport = document.createElement('div')
  let scrollHeight = 600
  Object.defineProperties(viewport, {
    clientHeight: { value: 300 },
    scrollHeight: { get: () => scrollHeight },
  })
  viewport.scrollTo = options => {
    if (typeof options === 'object' && options.top !== undefined) viewport.scrollTop = options.top
  }
  const scrollRef = { current: viewport }
  const input: ConversationScrollInput = {
    messages: [
      {
        id: 'cached-tail',
        role: 'assistant',
        content: 'Cached reply',
        status: 'done',
        createdAt: '2026-11-20T06:17:24Z',
      },
    ],
    scrollRef,
    geometry: {},
    onLoadTranscriptGap: async () => {
      scrollHeight += 200
    },
  }
  const state = createConversationScrollState('automatic-transcript-gap', input)
  const unbind = state.subscribe(() => {}, input, {
    scrollRef,
    externalScrollInteractionRef: undefined,
    owner: { lease: null },
    contentRef: { current: null },
    virtualizerRef: { current: null },
  })

  try {
    expect(viewport.scrollTop).toBe(300)
    await state.loadTranscriptGap({ start: 10, end: 20 }, 'visible')
    state.handleContentLayoutChange()
    expect(viewport.scrollTop).toBe(500)
  } finally {
    unbind()
  }
})
