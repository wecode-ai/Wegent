import { act, fireEvent, render, screen } from '@testing-library/react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  AssistantMessage,
  ConversationTranslationProvider,
} from '@wegent/collaboration/conversation'
import { MarkdownServicesProvider, browserMarkdownServices } from '@wegent/collaboration/markdown'
import { CollaborationTheme } from '@wegent/collaboration/theme'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

function Scope({ children }: { children: ReactNode }) {
  return (
    <CollaborationTheme mode="dark">
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        {children}
      </ConversationTranslationProvider>
    </CollaborationTheme>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('shared conversation presentation without desktop providers', () => {
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
