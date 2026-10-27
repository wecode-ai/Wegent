import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  AssistantMessage,
  ConversationTranslationProvider,
  ToolInteractionServicesProvider,
} from '@wegent/collaboration/conversation'
import { MarkdownServicesProvider, browserMarkdownServices } from '@wegent/collaboration/markdown'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

describe('MCP App placement', () => {
  it('keeps an app mounted while the completed processing history is collapsed or expanded', () => {
    const renderApp = vi.fn(block => <div data-testid="app-surface">{block.id}</div>)
    const message: WorkbenchMessage = {
      id: 'message',
      role: 'assistant',
      status: 'done',
      content: 'Dashboard ready',
      createdAt: new Date().toISOString(),
      blocks: [
        {
          id: 'call',
          type: 'tool',
          mcpServer: 'dashboard',
          toolName: 'dashboard.show',
          status: 'done',
          subtaskId: 'turn',
          createdAt: Date.now(),
        },
      ],
    }
    render(
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        <MarkdownServicesProvider value={browserMarkdownServices}>
          <ToolInteractionServicesProvider value={{ renderMcpApp: renderApp }}>
            <AssistantMessage
              message={message}
              devices={[]}
              imageServices={{
                identity: image => String(image.id),
                load: vi.fn(),
                download: vi.fn(),
              }}
            />
          </ToolInteractionServicesProvider>
        </MarkdownServicesProvider>
      </ConversationTranslationProvider>
    )
    const app = screen.getByTestId('app-surface')
    const toggle = screen.getByTestId('final-processing-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(app).toBeVisible()
    fireEvent.click(toggle)
    expect(screen.getByTestId('app-surface')).toBe(app)
    fireEvent.click(toggle)
    expect(screen.getByTestId('app-surface')).toBe(app)
    expect(app).toBeVisible()
  })
})
