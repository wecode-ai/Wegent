import { expect, test } from 'vitest'
import type { RuntimeConversationTurn } from '@wegent/chat-core/runtime-conversation'
import { runtimeTaskProgress } from './runtimeTaskProgress'

test.each([false, true])(
  'shows streaming native snapshot text as progress: active=%s',
  active => {
    const turns: RuntimeConversationTurn[] = [
      {
        id: 'reply',
        status: 'streaming',
        items: [
          {
            id: 'request',
            type: 'user_message',
            message: {
              id: 'request',
              role: 'user',
              content: 'Continue',
              createdAt: '2026-11-13T00:00:00Z',
            },
          },
          {
            id: 'progress',
            position: 1,
            type: 'assistant_text',
            content: 'Reply running',
            createdAt: '2026-11-13T00:00:01Z',
          },
        ],
      },
    ]
    expect(runtimeTaskProgress(turns, active).activity).toMatchObject({
      active: true,
      processText: 'Reply running',
    })
    turns[0] = { ...turns[0]!, status: 'done' }
    expect(runtimeTaskProgress(turns, active)).toMatchObject({
      activity: { active: false },
      responsePreview: 'Reply running',
    })
  }
)

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
