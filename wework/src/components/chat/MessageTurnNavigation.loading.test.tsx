import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { expect, test, vi } from 'vitest'
import { MessageTurnNavigation } from '@wegent/collaboration/conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'

test('previews and scrolls to a failed turn without waiting for a nonexistent user item', async () => {
  const scrollRef = createRef<HTMLDivElement>()
  const contentRef = createRef<HTMLDivElement>()
  const onTargetChange = vi.fn()
  const onLoad = vi.fn()
  const failed = {
    id: 'runtime-view:failed:assistant',
    turnId: 'failed',
    role: 'assistant',
    content: '',
  }
  const latest = { id: 'latest-user', turnId: 'latest', role: 'user', content: 'Latest' }
  render(
    <>
      <div ref={scrollRef}>
        <div ref={contentRef}>
          <div data-message-id={failed.id}>Request failed</div>
          <div data-message-id={latest.id}>Latest</div>
        </div>
      </div>
      <MessageTurnNavigation
        translate={createCollaborationTranslator('zh-CN')}
        messages={[failed, latest]}
        scrollRef={scrollRef}
        contentRef={contentRef}
        turnNavigation={[
          {
            id: 'failed',
            turnId: 'failed',
            userMessageId: null,
            turnIndex: 0,
            messageIndex: 0,
            promptPreview: '',
            responsePreview: 'Request failed',
            cursor: 'failed-cursor',
          },
          {
            id: 'latest',
            turnId: 'latest',
            userMessageId: latest.id,
            turnIndex: 1,
            messageIndex: 1,
            promptPreview: 'Latest',
            cursor: 'latest-cursor',
          },
        ]}
        onLoadTurnNavigationItem={onLoad}
        onNavigationScrollTargetChange={onTargetChange}
      />
    </>
  )
  const marker = screen.getAllByTestId('message-turn-navigation-marker')[0]
  fireEvent.focus(marker)
  const preview = screen.getAllByTestId('message-turn-navigation-preview')[0]
  expect(preview).toHaveClass('opacity-100')
  expect(preview).toHaveTextContent('第 1 轮对话')
  expect(preview).toHaveTextContent('Request failed')
  fireEvent.click(marker)
  expect(onTargetChange).toHaveBeenCalledWith(failed.id)
  expect(onLoad).not.toHaveBeenCalled()
})

test('requests a virtual row before waiting for an unloaded navigation anchor to mount', async () => {
  const scrollRef = createRef<HTMLDivElement>()
  const contentRef = createRef<HTMLDivElement>()
  const onTargetChange = vi.fn()
  const onLoadingChange = vi.fn()
  const latest = { id: 'latest-user', turnId: 'latest', role: 'user', content: 'Latest' }
  const older = { id: 'older-user', turnId: 'older', role: 'user', content: 'Older' }
  const navigation = ['older', 'latest'].map((id, index) => ({
    id,
    turnId: id,
    turnIndex: index,
    messageIndex: index,
    promptPreview: id,
    cursor: `cursor-${id}`,
  }))
  const props = {
    translate: createCollaborationTranslator('en'),
    scrollRef,
    contentRef,
    turnNavigation: navigation,
    onLoadTurnNavigationItem: vi.fn(),
    onNavigationScrollTargetChange: onTargetChange,
    onNavigationLoadStateChange: onLoadingChange,
  }
  const frame = (loaded: boolean, mounted: boolean) => (
    <>
      <div ref={scrollRef}>
        <div ref={contentRef}>
          {mounted && <div data-message-id="older-user">Older request</div>}
          <div data-message-id="latest-user">Latest request</div>
        </div>
      </div>
      <MessageTurnNavigation {...props} messages={loaded ? [older, latest] : [latest]} />
    </>
  )
  const view = render(frame(false, false))
  await waitFor(() =>
    expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(2)
  )
  fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
  view.rerender(frame(true, false))
  await waitFor(() => expect(onTargetChange).toHaveBeenCalledWith('older-user'))
  view.rerender(frame(true, true))
  await waitFor(() => expect(onLoadingChange).toHaveBeenLastCalledWith(false))
})
