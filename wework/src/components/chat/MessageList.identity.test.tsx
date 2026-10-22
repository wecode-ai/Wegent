import { render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import '@/i18n'
import { MessageList } from './MessageList'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  replaceRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'

afterEach(clearRuntimeConversationCacheForTests)

test('keeps streamed code DOM when terminal history replaces synthetic reasoning items', () => {
  const address = { deviceId: 'device-1', taskId: 'code-identity', workspacePath: '/workspace' }
  const content = ['```sql', ...Array.from({ length: 110 }, (_, i) => `SELECT ${i};`), '```'].join(
    '\n'
  )
  applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: 'turn-1' })
  applyRuntimeConversationAction(address, {
    type: 'assistant_chunk',
    subtaskId: 'turn-1',
    reasoningChunk: 'Inspecting the SQL',
  })
  applyRuntimeConversationAction(address, {
    type: 'assistant_chunk',
    subtaskId: 'turn-1',
    itemId: 'answer-1',
    content,
  })
  const { rerender } = render(<MessageList messages={getRuntimeConversationMessages(address)} />)
  const code = screen.getByTestId('markdown-code-block').querySelector('code')
  expect(code).not.toBeNull()

  const messages = replaceRuntimeConversationSnapshot(address, [
    {
      id: 'turn-1',
      status: 'done',
      items: [
        {
          id: 'canonical-reasoning',
          type: 'block',
          block: {
            id: 'canonical-reasoning',
            type: 'thinking',
            content: 'Inspecting the SQL',
            status: 'done',
            createdAt: 1,
          },
        },
        { id: 'answer-1', type: 'assistant_text', content },
      ],
    },
  ])
  rerender(<MessageList messages={messages} />)

  expect(screen.getByTestId('markdown-code-block').querySelector('code')).toBe(code)
})
