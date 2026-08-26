import { describe, expect, test, vi } from 'vitest'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from './workbenchServices'
import { registerRuntimeConversationStream } from './runtimeConversationStreamCoordinator'

describe('registerRuntimeConversationStream', () => {
  test('uses one global stream consumer across retained workspace providers', () => {
    let streamHandlers: ChatStreamHandlers = {}
    const firstUnsubscribe = vi.fn()
    const firstSubscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return firstUnsubscribe
    })
    const secondSubscribe = vi.fn(() => vi.fn())
    const firstChatStream = {
      subscribe: firstSubscribe,
    } as unknown as WorkbenchServices['chatStream']
    const secondChatStream = {
      subscribe: secondSubscribe,
    } as unknown as WorkbenchServices['chatStream']
    const inactiveAction = vi.fn()
    const activeAction = vi.fn()

    const unregisterInactive = registerRuntimeConversationStream(
      firstChatStream,
      { onMessageAction: inactiveAction },
      false
    )
    const unregisterActive = registerRuntimeConversationStream(
      secondChatStream,
      { onMessageAction: activeAction },
      true
    )

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

    expect(firstSubscribe).toHaveBeenCalledTimes(1)
    expect(secondSubscribe).not.toHaveBeenCalled()
    expect(inactiveAction).not.toHaveBeenCalled()
    expect(activeAction).toHaveBeenCalledTimes(2)

    unregisterInactive()
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)
    expect(secondSubscribe).toHaveBeenCalledTimes(1)
    unregisterActive()
  })

  test('keeps one consumer while active ownership moves between streams', () => {
    let streamHandlers: ChatStreamHandlers = {}
    const unsubscribe = vi.fn()
    const firstSubscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return unsubscribe
    })
    const secondSubscribe = vi.fn(() => vi.fn())
    const firstChatStream = {
      subscribe: firstSubscribe,
    } as unknown as WorkbenchServices['chatStream']
    const secondChatStream = {
      subscribe: secondSubscribe,
    } as unknown as WorkbenchServices['chatStream']
    const firstAction = vi.fn()
    const secondAction = vi.fn()

    const unregisterFirstActive = registerRuntimeConversationStream(
      firstChatStream,
      { onMessageAction: firstAction },
      true
    )
    const unregisterSecondInactive = registerRuntimeConversationStream(
      secondChatStream,
      { onMessageAction: secondAction },
      false
    )
    const unregisterSecondActive = registerRuntimeConversationStream(
      secondChatStream,
      { onMessageAction: secondAction },
      true
    )

    streamHandlers.onBlockUpdated?.({
      taskId: 'task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      blockId: 'text-1',
      contentDelta: 'only once',
      status: 'streaming',
    })

    expect(firstSubscribe).toHaveBeenCalledTimes(1)
    expect(secondSubscribe).not.toHaveBeenCalled()
    expect(firstAction).not.toHaveBeenCalled()
    expect(secondAction).toHaveBeenCalledTimes(1)

    unregisterSecondActive()
    unregisterSecondInactive()
    unregisterFirstActive()
  })
})
