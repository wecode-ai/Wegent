import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeSendRequest } from '@/types/api'
import {
  beginRuntimeConversationHydration,
  clearRuntimeConversationCacheForTests,
  completeRuntimeConversationHydration,
  getRuntimeConversationMessages,
} from './runtimeConversationCache'
import { sendOptimisticRuntimeUserMessage } from './runtimeConversationSend'

const request: RuntimeSendRequest = {
  address: {
    deviceId: 'local-device',
    taskId: 'task-with-pr',
    workspacePath: '/repo/Wegent',
  },
  message: '继续当前任务，修复 PR #2875。',
  source: { source: 'manual' },
}

describe('sendOptimisticRuntimeUserMessage', () => {
  afterEach(clearRuntimeConversationCacheForTests)

  test('shows a programmatic user message and forwards its client id', async () => {
    const sendRuntimePaneMessage = vi.fn().mockResolvedValue(true)

    await expect(sendOptimisticRuntimeUserMessage(request, sendRuntimePaneMessage)).resolves.toBe(
      true
    )

    const messages = getRuntimeConversationMessages(request.address)
    expect(messages).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^runtime-local-pane-/),
        role: 'user',
        content: request.message,
      }),
    ])
    expect(sendRuntimePaneMessage).toHaveBeenCalledWith({
      ...request,
      clientUserMessageId: messages[0].id,
    })
  })

  test('removes the optimistic message when the send is rejected', async () => {
    const sendRuntimePaneMessage = vi.fn().mockResolvedValue(false)

    await expect(sendOptimisticRuntimeUserMessage(request, sendRuntimePaneMessage)).resolves.toBe(
      false
    )

    expect(getRuntimeConversationMessages(request.address)).toEqual([])
  })

  test('removes the optimistic message when the sender throws', async () => {
    const error = new Error('transport failed')
    const sendRuntimePaneMessage = vi.fn().mockRejectedValue(error)

    await expect(sendOptimisticRuntimeUserMessage(request, sendRuntimePaneMessage)).rejects.toBe(
      error
    )

    expect(getRuntimeConversationMessages(request.address)).toEqual([])
  })

  test('removes a rejected message buffered during transcript hydration', async () => {
    const hydration = beginRuntimeConversationHydration(request.address)
    const sendRuntimePaneMessage = vi.fn().mockResolvedValue(false)

    await sendOptimisticRuntimeUserMessage(request, sendRuntimePaneMessage)
    completeRuntimeConversationHydration(request.address, hydration, [])

    expect(getRuntimeConversationMessages(request.address)).toEqual([])
  })
})
