import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  AssistantMessage,
  ConversationTranslationProvider,
} from '@wegent/collaboration/conversation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

describe('cancelled context compaction presentation', () => {
  test.each([
    ['pending', 'Context compaction did not complete'],
    ['done', 'Context compacted'],
    ['error', 'Context compaction did not complete'],
  ] as const)('preserves the result of a %s compaction in a cancelled turn', (status, label) => {
    const message: WorkbenchMessage = {
      id: 'assistant',
      subtaskId: 'turn',
      role: 'assistant',
      content: '',
      status: 'done',
      runtimeStatus: 'cancelled',
      createdAt: '2026-09-24T00:00:00Z',
      blocks: [
        {
          id: 'compact',
          subtaskId: 'turn',
          type: 'tool',
          toolName: 'context_compaction',
          status,
          createdAt: 1,
        },
      ],
    }
    render(
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        <AssistantMessage
          message={message}
          devices={[]}
          imageServices={{ identity: image => String(image.id), load: vi.fn(), download: vi.fn() }}
        />
      </ConversationTranslationProvider>
    )
    expect(screen.getByTestId('context-compaction-indicator')).toHaveTextContent(label)
    expect(screen.queryByText('Compacting context')).not.toBeInTheDocument()
    if (status !== 'done') expect(screen.queryByText('Context compacted')).not.toBeInTheDocument()
  })
})
