import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { ScrollableMessageAreaProps } from '@wegent/collaboration/conversation'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import '@/i18n'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))
vi.mock('./DesktopToolServices', () => ({
  DesktopToolServices: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./useDesktopConversationPresentation', () => ({
  useDesktopConversationPresentation: () => ({}),
}))
vi.mock('@wegent/collaboration/conversation', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration/conversation')>()),
  // Keep the real desktop search hook and controls while observing the shared
  // renderer's paging and navigation contract without mounting the full timeline.
  ScrollableMessageArea: (props: ScrollableMessageAreaProps) => (
    <section
      data-testid="visible-conversation"
      data-search-message-id={props.searchTarget?.messageId ?? ''}
      data-search-navigation-paused={String(Boolean(props.searchNavigationPaused))}
      data-history-loading-mode={props.historyLoadingMode ?? 'automatic'}
    >
      {props.hasMoreBefore ? (
        <button
          type="button"
          data-testid="context-before-control"
          disabled={props.loadingMoreBefore}
          onClick={() => void props.onLoadMoreBefore?.()}
        >
          Earlier messages
        </button>
      ) : null}
      {props.messages.map(message => (
        <p key={message.id}>{message.content}</p>
      ))}
      {props.contentFooter}
    </section>
  ),
}))

type MessageAreaProps = Parameters<typeof ScrollableMessageArea>[0]

function message(id: string, content: string): WorkbenchMessage {
  return { id, content, role: 'assistant', status: 'done', createdAt: '2026-10-14T00:00:00Z' }
}

function fixture(): MessageAreaProps {
  return {
    conversationKey: 'synthetic-conversation',
    messages: [message('live', 'Latest conversation message')],
    hasMoreBefore: true,
    contentFooter: <button type="button">Live conversation footer</button>,
    searchActive: true,
    searchPage: {
      messages: [
        message('old-first', 'needle first reply'),
        message('old-second', 'needle next reply'),
      ],
      turns: [],
      hasMoreBefore: true,
      hasMoreAfter: true,
    },
    onSearchTranscript: vi.fn().mockResolvedValue({
      matches: [
        { messageId: 'old-first', occurrence: 0, cursor: 'first-cursor' },
        { messageId: 'old-second', occurrence: 0, cursor: 'second-cursor' },
      ],
      totalMatches: 2,
      isCapped: false,
    }),
    onEnsureSearchMatch: vi.fn().mockResolvedValue(undefined),
    onLoadMoreBefore: vi.fn().mockResolvedValue(undefined),
    onLoadSearchContext: vi.fn().mockResolvedValue(undefined),
    onReleaseSearchPage: vi.fn(),
  }
}

async function openSearch() {
  fireEvent.keyDown(window, { key: 'f', metaKey: true })
  fireEvent.change(screen.getByTestId('conversation-find-input'), { target: { value: 'needle' } })
  await act(async () => vi.advanceTimersByTime(150))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('conversation search context', () => {
  test('loads only the requested context edge and restores the live conversation when closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const props = fixture()
    render(<ScrollableMessageArea {...props} />)
    expect(screen.getByText('Latest conversation message')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Live conversation footer' })).toBeInTheDocument()
    expect(screen.getByTestId('visible-conversation')).toHaveAttribute(
      'data-history-loading-mode',
      'automatic'
    )

    await openSearch()
    expect(screen.getByTestId('visible-conversation')).toHaveAttribute(
      'data-history-loading-mode',
      'manual'
    )
    expect(screen.getByText('needle first reply')).toBeInTheDocument()
    expect(screen.getByTestId('context-before-control')).toBeEnabled()
    expect(screen.getByTestId('load-newer-runtime-transcript-button')).toBeEnabled()
    expect(screen.queryByText('Latest conversation message')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Live conversation footer' })
    ).not.toBeInTheDocument()
    expect(props.onLoadSearchContext).not.toHaveBeenCalled()
    expect(props.onLoadMoreBefore).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(screen.getByTestId('context-before-control')))
    expect(props.onLoadSearchContext).toHaveBeenCalledExactlyOnceWith('before')
    await act(async () =>
      fireEvent.click(screen.getByTestId('load-newer-runtime-transcript-button'))
    )
    expect(vi.mocked(props.onLoadSearchContext!).mock.calls).toEqual([['before'], ['after']])
    expect(props.onLoadMoreBefore).not.toHaveBeenCalled()
    expect(props.onEnsureSearchMatch).not.toHaveBeenCalled()

    const releases = vi.mocked(props.onReleaseSearchPage!).mock.calls.length
    fireEvent.click(screen.getByTestId('conversation-find-close-button'))
    expect(screen.getByText('Latest conversation message')).toBeInTheDocument()
    expect(screen.getByTestId('visible-conversation')).toHaveAttribute(
      'data-history-loading-mode',
      'automatic'
    )
    expect(screen.getByRole('button', { name: 'Live conversation footer' })).toBeInTheDocument()
    expect(screen.queryByText('needle first reply')).not.toBeInTheDocument()
    expect(screen.queryByTestId('load-newer-runtime-transcript-button')).not.toBeInTheDocument()
    expect(props.onReleaseSearchPage).toHaveBeenCalledTimes(releases + 1)
    await act(async () => fireEvent.click(screen.getByTestId('context-before-control')))
    expect(props.onLoadMoreBefore).toHaveBeenCalledOnce()
    expect(props.onLoadSearchContext).toHaveBeenCalledTimes(2)
  })

  test('keeps manual context browsing in place until the search down arrow selects the next match', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const props = fixture()
    const { rerender } = render(<ScrollableMessageArea {...props} />)
    await openSearch()
    const conversation = screen.getByTestId('visible-conversation')
    expect(conversation).toHaveAttribute('data-search-message-id', 'old-first')
    expect(conversation).toHaveAttribute('data-search-navigation-paused', 'false')

    await act(async () =>
      fireEvent.click(screen.getByTestId('load-newer-runtime-transcript-button'))
    )
    rerender(
      <ScrollableMessageArea
        {...props}
        searchPage={{
          ...props.searchPage!,
          messages: [
            ...props.searchPage!.messages,
            message('new-context', 'The following context'),
          ],
          hasMoreAfter: false,
        }}
      />
    )
    expect(screen.getByText('The following context')).toBeInTheDocument()
    expect(conversation).toHaveAttribute('data-search-message-id', 'old-first')
    expect(conversation).toHaveAttribute('data-search-navigation-paused', 'true')
    expect(props.onLoadSearchContext).toHaveBeenCalledExactlyOnceWith('after')

    fireEvent.click(screen.getByTestId('conversation-find-next-button'))
    expect(conversation).toHaveAttribute('data-search-message-id', 'old-second')
    expect(conversation).toHaveAttribute('data-search-navigation-paused', 'false')
    expect(props.onLoadSearchContext).toHaveBeenCalledOnce()
    expect(props.onLoadMoreBefore).not.toHaveBeenCalled()
    expect(props.onSearchTranscript).toHaveBeenCalledOnce()
  })
})
