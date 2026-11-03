import { afterEach, expect, test } from 'vitest'
import type { RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'
import {
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  replaceRuntimeConversationFromUserMessage,
  replaceRuntimeConversationSnapshot,
} from './runtimeConversationCache'

const address = { deviceId: 'device-1', taskId: 'task-1' }
const replacement: WorkbenchMessage & { role: 'user' } = {
  id: 'edited-client-message',
  taskId: address.taskId,
  role: 'user',
  content: 'Edited request',
  status: 'done',
  createdAt: '2026-10-31T18:55:16Z',
}
const history: RuntimeConversationTurn[] = [
  {
    id: 'earlier-turn',
    status: 'done',
    items: [{ id: 'earlier-answer', type: 'assistant_text', content: 'Earlier context' }],
  },
  {
    id: 'original-turn',
    clientUserMessageId: 'original-client-message',
    status: 'done',
    items: [
      {
        id: 'native-user-item',
        type: 'user_message',
        message: {
          ...replacement,
          id: 'original-client-message',
          content: 'Original request',
        },
      },
      { id: 'original-answer', type: 'assistant_text', content: 'Superseded answer' },
    ],
  },
]

afterEach(clearRuntimeConversationCacheForTests)

test('editing a canonical user message removes its native turn before rollback completes', () => {
  replaceRuntimeConversationSnapshot(address, history)
  const source = getRuntimeConversationMessages(address).find(message => message.role === 'user')!
  expect(source.id).toBe('original-client-message')
  expect(source.runtimeItemId).toBe('native-user-item')

  const messages = replaceRuntimeConversationFromUserMessage(address, source.id, replacement)

  expect(messages.map(message => message.content)).toEqual(['Earlier context', 'Edited request'])
  expect(messages.some(message => message.content === 'Superseded answer')).toBe(false)
})

test('an edit with an unknown message identity preserves the existing conversation', () => {
  replaceRuntimeConversationSnapshot(address, history)
  const before = getRuntimeConversationMessages(address)

  const messages = replaceRuntimeConversationFromUserMessage(
    address,
    'missing-message',
    replacement
  )

  expect(messages).toEqual(before)
})
