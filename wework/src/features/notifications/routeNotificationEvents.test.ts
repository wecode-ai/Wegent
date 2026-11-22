import { expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { createRouteNotificationEvents } from './routeNotificationEvents'

vi.mock('@/features/workbench/runtimeTaskSystemNotifications', () => ({
  sendSystemNotification: vi.fn(),
}))

test('a learning suggestion alerts its owner once and opens the correct role', () => {
  let stream: ChatStreamHandlers = {}
  const route = createRouteNotificationEvents()
  route.observe({
    currentUserId: 7,
    t: i18n.getFixedT('en', 'common'),
    chatStream: {
      subscribe(handlers) {
        stream = handlers
        return () => {}
      },
    },
  })
  const proposal = { userId: 8, deviceId: 'dev', roleId: 'support', proposalId: 'p' }
  stream.onStandInLearningProposal?.(proposal)
  expect(sendSystemNotification).not.toHaveBeenCalled()
  const mine = { ...proposal, userId: 7 }
  stream.onStandInLearningProposal?.(mine)
  stream.onStandInLearningProposal?.(mine)
  route.disconnect()
  stream.onStandInLearningProposal?.({ ...mine, proposalId: 'later' })
  expect(sendSystemNotification).toHaveBeenCalledTimes(1)
  expect(sendSystemNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      address: { deviceId: 'dev', taskId: 'stand-in-chat-7-role-support' },
    })
  )
})
