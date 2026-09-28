import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  ConversationTranslationProvider,
  ScrollableMessageArea,
  type ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

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
  test.each(['en', 'zh-CN'] as const)('renders the native loading copy in %s', locale => {
    renderArea({ messages: [], loading: true }, locale)
    expect(screen.getByTestId('chat-loading-state')).toHaveTextContent(
      createCollaborationTranslator(locale)('conversation.workbench.loading_conversation')
    )
  })

  test('does not enable history loading without a host loader', () => {
    renderArea({ hasMoreBefore: true })
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toBeDisabled()
  })

  test('loads history through the actual host callback', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    renderArea({ hasMoreBefore: true, onLoadMoreBefore: load })
    fireEvent.click(screen.getByTestId('load-older-runtime-transcript-button'))
    expect(load).toHaveBeenCalledOnce()
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
