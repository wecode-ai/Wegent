import { expect, test } from 'vitest'
import type { RuntimeConversationTurn } from '@wegent/chat-core/runtime-conversation'
import { runtimeTaskProgress } from './runtimeTaskProgress'

test.each([false, true])(
  'shows native reply progress before board state catches up: active=%s',
  active => {
    const turns: RuntimeConversationTurn[] = [
      {
        id: 'reply',
        status: 'streaming',
        items: [
          {
            id: 'progress',
            type: 'block',
            block: {
              id: 'progress',
              type: 'text',
              content: 'Reply running',
              status: 'done',
              createdAt: 1,
            },
          },
        ],
      },
    ]
    expect(runtimeTaskProgress(turns, active).activity).toMatchObject({
      active: true,
      processText: 'Reply running',
    })
    turns[0] = { ...turns[0]!, status: 'done' }
    expect(runtimeTaskProgress(turns, active).activity.active).toBe(false)
  }
)
