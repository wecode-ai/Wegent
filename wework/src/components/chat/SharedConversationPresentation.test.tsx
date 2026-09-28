import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CodeCommentContext } from '@wegent/chat-core/code-comment'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  AssistantMessage,
  CodeCommentPreview,
  ConversationTranslationProvider,
  ImSourceBadge,
} from '@wegent/collaboration/conversation'
import { CollaborationTheme, resolveThemeVariables } from '@wegent/collaboration/theme'
import { MarkdownServicesProvider, browserMarkdownServices } from '@wegent/collaboration/markdown'
import type { ReactNode } from 'react'

const comment: CodeCommentContext = {
  id: 'comment-1',
  fileName: 'app.ts',
  filePath: '/workspace/app.ts',
  startLine: 2,
  endLine: 4,
  selectedText: 'const selected = true',
  comment: 'Keep this selection',
  createdAt: '2026-09-17T00:00:00Z',
}

function Scope({ children }: { children: ReactNode }) {
  return (
    <CollaborationTheme mode="dark">
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        {children}
      </ConversationTranslationProvider>
    </CollaborationTheme>
  )
}

function Preview({ getRightBoundary }: { getRightBoundary?: () => number }) {
  return (
    <Scope>
      <CodeCommentPreview
        comments={[comment]}
        testId="comment-preview"
        getRightBoundary={getRightBoundary}
      >
        <button data-testid="preview-trigger">Comment</button>
      </CodeCommentPreview>
    </Scope>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('shared conversation presentation without desktop providers', () => {
  test('keeps the Web theme on the portaled comment preview and closes with Escape', () => {
    const { container } = render(<Preview />)
    fireEvent.focus(screen.getByTestId('preview-trigger'))
    const preview = screen.getByTestId('comment-preview')
    expect(container.contains(preview)).toBe(false)
    expect(preview).toHaveAttribute('data-theme', 'dark')
    for (const [key, value] of Object.entries(resolveThemeVariables('dark'))) {
      expect(preview.style.getPropertyValue(key)).toBe(value)
    }
    expect(preview).toHaveTextContent('app.ts:2-4')
    expect(preview).toHaveTextContent('Selection:')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('comment-preview')).not.toBeInTheDocument()
  })

  test('respects the host right boundary and places a tall preview below its trigger', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.testid === 'comment-preview'
        ? new DOMRect(0, 0, 300, 200)
        : new DOMRect(650, 100, 30, 20)
    })
    render(<Preview getRightBoundary={() => 750} />)
    fireEvent.focus(screen.getByTestId('preview-trigger'))
    expect(screen.getByTestId('comment-preview')).toHaveStyle({ left: '450px', top: '124px' })
  })

  test('keeps the preview open while the pointer crosses into it', () => {
    vi.useFakeTimers()
    render(<Preview />)
    const trigger = screen.getByTestId('preview-trigger').parentElement!
    fireEvent.pointerEnter(trigger)
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(screen.getByTestId('comment-preview'))
    act(() => vi.advanceTimersByTime(150))
    expect(screen.getByTestId('comment-preview')).toBeInTheDocument()
    fireEvent.pointerLeave(screen.getByTestId('comment-preview'))
    act(() => vi.advanceTimersByTime(120))
    expect(screen.queryByTestId('comment-preview')).not.toBeInTheDocument()
  })

  test('uses localized source labels and preserves authoritative channel labels', () => {
    render(
      <Scope>
        <ImSourceBadge source={{ source: 'im', channel_type: 'dingtalk' }} testId="dingtalk" />
        <ImSourceBadge source={{ source: 'im', channel_label: ' My channel ' }} testId="custom" />
        <ImSourceBadge source="web" testId="web" />
      </Scope>
    )
    expect(screen.getByTestId('dingtalk')).toHaveTextContent('DingTalk')
    expect(screen.getByTestId('custom')).toHaveTextContent('My channel')
    expect(screen.queryByTestId('web')).not.toBeInTheDocument()
  })

  test('renders errors with real retry and clipboard services without desktop imports', async () => {
    const message: WorkbenchMessage = {
      id: 'failed-1',
      role: 'assistant',
      content: 'Partial answer',
      status: 'failed',
      error: 'A network connection failed',
      errorType: 'network_error',
      createdAt: '2026-09-17T00:00:00Z',
    }
    const retry = vi.fn()
    const copyText = vi.fn().mockResolvedValue(undefined)
    render(
      <Scope>
        <MarkdownServicesProvider value={{ ...browserMarkdownServices, copyText }}>
          <AssistantMessage
            message={message}
            devices={[]}
            onRetryFailedMessage={retry}
            imageServices={{
              identity: image => String(image.id),
              load: vi.fn(),
              download: vi.fn(),
            }}
          />
        </MarkdownServicesProvider>
      </Scope>
    )
    expect(screen.getByTestId('assistant-message-content')).toHaveTextContent('Partial answer')
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('assistant-error-retry'))
    expect(retry).toHaveBeenCalledWith(message)
    fireEvent.pointerEnter(screen.getByTestId('message-hover-region'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
    expect(copyText).toHaveBeenCalledWith('Partial answer')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
