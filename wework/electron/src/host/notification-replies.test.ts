import { expect, test } from 'vitest'
import {
  acknowledgeNotificationReply,
  enqueueNotificationReply,
  pendingNotificationReplies,
} from './notification-replies'

test('retains native replies until the owning account acknowledges them', () => {
  enqueueNotificationReply({
    accountKey: 'a',
    interactionId: 'question',
    text: 'Keep behavior',
    url: 'wework://interactions/device/task/question',
  })
  const [reply] = pendingNotificationReplies('a')
  expect(reply.text).toBe('Keep behavior')
  expect(pendingNotificationReplies('b')).toEqual([])
  acknowledgeNotificationReply(reply.id, 'b')
  expect(pendingNotificationReplies('a')).toEqual([reply])
  acknowledgeNotificationReply(reply.id, 'a')
  expect(pendingNotificationReplies('a')).toEqual([])
})
