import { describe, expect, test, vi } from 'vitest'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from './workbenchServices'
import { registerRuntimeConversationStream } from './runtimeConversationStreamCoordinator'

describe('registerRuntimeConversationStream', () => {
  test('uses one global stream consumer across retained workspace providers', () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const chatStream = { subscribe } as unknown as WorkbenchServices['chatStream']
    const inactiveAction = vi.fn()
    const activeAction = vi.fn()

    registerRuntimeConversationStream(chatStream, { onMessageAction: inactiveAction }, false)
    registerRuntimeConversationStream(chatStream, { onMessageAction: activeAction }, true)

    streamHandlers.onBlockCreated?.({
      taskId: 'task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      block: {
        id: 'text-1',
        type: 'thinking',
        content: '中文流式内容',
        status: 'streaming',
      },
    })
    streamHandlers.onBlockUpdated?.({
      taskId: 'task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      blockId: 'text-1',
      contentDelta: '不得重复',
      status: 'streaming',
    })

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(inactiveAction).not.toHaveBeenCalled()
    expect(activeAction).toHaveBeenCalledTimes(2)
  })
})
