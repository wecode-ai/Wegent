// @vitest-environment node

import { expect, it } from 'vitest'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { DeviceInfo } from '@/types/api'
import { notificationCommentFocus } from './notificationCommentFocus'

const address = { deviceId: 'device', taskId: 'execution' }
const message = (messageId: string, triggerMessageId: string, taskId = 'execution') =>
  ({
    messageId,
    triggerMessageId,
    sender: { type: 'agent' },
    runtimeAddress: { ...address, taskId },
    content: 'Identical business text',
  }) as ProjectChatMessage

it('selects the exact originating AI response rather than the root or a newer message', () => {
  const messages = [message('answer-1', 'source-1'), message('answer-2', 'source-2')]
  expect(notificationCommentFocus(messages, address, ['source-1'], [])).toBe('answer-1')
  expect(notificationCommentFocus(messages, address, ['answer-2'], [])).toBe('answer-2')
})

it('does not target another execution with the same trigger or infer an ambiguous response', () => {
  expect(
    notificationCommentFocus(
      [
        {
          ...message('other-device', 'source'),
          runtimeAddress: { ...address, deviceId: 'another-device' },
        },
      ],
      address,
      ['source'],
      []
    )
  ).toBeNull()
  expect(
    notificationCommentFocus([message('other', 'source', 'other-task')], address, ['source'], [])
  ).toBeNull()
  expect(
    notificationCommentFocus(
      [message('first', 'source'), message('second', 'source')],
      address,
      ['source'],
      []
    )
  ).toBeNull()
  expect(notificationCommentFocus([message('first', 'source')], address, undefined, [])).toBeNull()
})

it('uses the existing device resolver for a persisted socket alias', () => {
  const device = { device_id: 'device', socket_device_id: 'app-record-73' } as DeviceInfo
  const original = {
    ...message('original-ai', 'source'),
    runtimeAddress: { ...address, deviceId: 'app-record-73' },
  }
  expect(notificationCommentFocus([original], address, ['source'], [device])).toBe('original-ai')
})
