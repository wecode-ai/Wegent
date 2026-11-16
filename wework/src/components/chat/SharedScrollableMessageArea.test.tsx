import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  ConversationTranslationProvider,
  ScrollableMessageArea,
  type ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import { afterEach, describe, expect, test, vi } from 'vitest'

const message: WorkbenchMessage = {
  id: 'shared-scroll-user',
  role: 'user',
  content: 'Read the project history',
  status: 'done',
  createdAt: '2026-09-17T00:00:00Z',
  runtimeMessageIndex: 0,
}

function renderArea(
  overrides: Partial<ScrollableMessageAreaProps> = {},
  locale: 'en' | 'zh-CN' = 'en'
) {
  const props: ScrollableMessageAreaProps = {
    messages: [message],
    virtualize: false,
    userMessageServices: {
      images: { identity: image => String(image.id), load: vi.fn(), download: vi.fn() },
    },
    ...overrides,
  }
  return render(
    <ConversationTranslationProvider translate={createCollaborationTranslator(locale)}>
      <ScrollableMessageArea {...props} />
    </ConversationTranslationProvider>
  )
}

describe('shared conversation scroll area without desktop services', () => {
  afterEach(() => vi.unstubAllGlobals())
  test.each(['en', 'zh-CN'] as const)('renders the native loading copy in %s', locale => {
    renderArea({ messages: [], loading: true }, locale)
    expect(screen.getByTestId('chat-loading-state')).toHaveTextContent(
      createCollaborationTranslator(locale)('conversation.workbench.loading_conversation')
    )
  })

  test('does not enable history loading without a host loader', () => {
    renderArea({ hasMoreBefore: true })
    expect(screen.getByTestId('runtime-transcript-history-start')).toBeInTheDocument()
    expect(screen.queryByTestId('load-older-runtime-transcript-button')).not.toBeInTheDocument()
  })

  test('shows history loading feedback outside the transcript layout until loading finishes', () => {
    const props = { messages: [message], hasMoreBefore: true }
    const content = (loadingMoreBefore: boolean, autoScrollSuspended = false) => (
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        <ScrollableMessageArea
          {...props}
          loadingMoreBefore={loadingMoreBefore}
          autoScrollSuspended={autoScrollSuspended}
        />
      </ConversationTranslationProvider>
    )
    const view = render(content(false))
    expect(screen.queryByTestId('runtime-transcript-history-loading')).not.toBeInTheDocument()
    view.rerender(content(true))
    const indicator = screen.getByRole('status', { name: 'Loading...' })
    expect(indicator.parentElement).toHaveClass('absolute', 'pointer-events-none')
    expect(screen.getByTestId('chat-message-scroll-area')).not.toContainElement(indicator)
    expect(indicator.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-transcript-history-start')).toHaveClass('h-px')
    view.rerender(content(true, true))
    expect(screen.queryByTestId('runtime-transcript-history-loading')).not.toBeInTheDocument()
    view.rerender(content(false))
    expect(screen.queryByTestId('runtime-transcript-history-loading')).not.toBeInTheDocument()
  })

  test('loads history through the actual host callback', async () => {
    let intersect!: IntersectionObserverCallback
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback
        }
        observe() {}
        disconnect() {}
      }
    )
    const load = vi.fn().mockResolvedValue(undefined)
    renderArea({ hasMoreBefore: true, onLoadMoreBefore: load })
    await act(async () =>
      intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    )
    expect(load).toHaveBeenCalledOnce()
  })

  test('continues from an advanced native cursor when its items are already cached', async () => {
    let intersect!: IntersectionObserverCallback
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback
        }
        observe() {}
        disconnect() {}
      }
    )
    const load = vi.fn().mockResolvedValue(undefined)
    const cachedMessages = [message]
    const content = (beforeCursor: string) => (
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        <ScrollableMessageArea
          messages={cachedMessages}
          hasMoreBefore
          beforeCursor={beforeCursor}
          onLoadMoreBefore={load}
        />
      </ConversationTranslationProvider>
    )
    const view = render(content('native-item-750'))
    const showBoundary = async () =>
      act(async () =>
        intersect(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )
    await showBoundary()
    expect(load).toHaveBeenCalledOnce()

    // A latest-page read can retain earlier cached items while moving its native cursor.
    view.rerender(content('native-item-250'))
    await showBoundary()
    expect(load).toHaveBeenCalledTimes(2)

    // A completed read that advances neither cursor nor displayed history must not loop.
    await showBoundary()
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toBeEnabled()
  })

  test('shows missing history without enabling an unavailable action', () => {
    renderArea({ messages: [message, { ...message, id: 'later', runtimeMessageIndex: 8 }] })
    expect(screen.getByTestId('load-runtime-transcript-gap-button')).toBeDisabled()
    expect(screen.getByTestId('runtime-transcript-gap-marker')).toHaveTextContent(
      'Some history is not loaded'
    )
  })

  test('requests the uncovered transcript range from the host', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    renderArea({
      messages: [message, { ...message, id: 'later', runtimeMessageIndex: 8 }],
      loadedTranscriptRanges: [{ start: 0, end: 3 }],
      onLoadTranscriptGap: load,
    })
    fireEvent.click(screen.getByTestId('load-runtime-transcript-gap-button'))
    await waitFor(() => expect(load).toHaveBeenCalledWith({ start: 3, end: 8 }))
    await waitFor(() =>
      expect(screen.getByTestId('load-runtime-transcript-gap-button')).toBeEnabled()
    )
  })
})
