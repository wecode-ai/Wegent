// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { MarkdownCodeBlock } from '../markdown/MarkdownCodeBlock'
import { MarkdownServicesProvider, browserMarkdownServices } from '../markdown/MarkdownServices'
import { readConversationSearchContent } from './conversationSearchHighlightBinding'

test('keeps fenced code at its indexed offset when copy controls render help text', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(() =>
      root.render(
        <MarkdownServicesProvider value={browserMarkdownServices}>
          <MarkdownCodeBlock lang="txt">CORE_FENCE</MarkdownCodeBlock>
        </MarkdownServicesProvider>
      )
    )
    expect(readConversationSearchContent(container).text).toBe('CORE_FENCE')
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
