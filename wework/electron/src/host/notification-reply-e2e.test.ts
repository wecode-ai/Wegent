import { afterEach, expect, test, vi } from 'vitest'
import { HostCapabilityRouter } from './capability-router.js'
import { registerNotificationReplyE2E } from './notification-reply-e2e.js'
import { acknowledgeNotificationReply, pendingNotificationReplies } from './notification-replies.js'

afterEach(() => vi.unstubAllEnvs())

test('requires both controlled-host signals and the original capability grant', async () => {
  const router = new HostCapabilityRouter()
  const publish = vi.fn()
  registerNotificationReplyE2E(router, publish)
  const params = {
    accountKey: 'fixture-owner',
    interactionId: 'fixture-question',
    text: 'Unsent judgment',
    url: 'wework://interactions/device/task/question',
  }
  router.grant('controlled-workbench', ['e2e.enqueueNotificationReply'])
  vi.stubEnv('VITE_WEWORK_E2E', 'false')
  vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:12345')
  await expect(
    router.invoke('controlled-workbench', 'e2e.enqueueNotificationReply', params)
  ).rejects.toMatchObject({ code: 'e2e_disabled' })
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  vi.stubEnv('WEWORK_E2E_CONTROL_URL', '')
  await expect(
    router.invoke('controlled-workbench', 'e2e.enqueueNotificationReply', params)
  ).rejects.toMatchObject({ code: 'e2e_disabled' })
  vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:12345')
  await expect(
    router.invoke('ungranted-plugin', 'e2e.enqueueNotificationReply', params)
  ).rejects.toMatchObject({ code: 'capability_denied' })
  await expect(
    router.invoke('controlled-workbench', 'e2e.enqueueNotificationReply', { ...params, text: '' })
  ).rejects.toMatchObject({ code: 'invalid_params' })
  const result = (await router.invoke(
    'controlled-workbench',
    'e2e.enqueueNotificationReply',
    params
  )) as { id: string }
  expect(pendingNotificationReplies(params.accountKey)).toEqual([{ ...params, id: result.id }])
  expect(pendingNotificationReplies('another-account')).toEqual([])
  expect(publish).toHaveBeenCalledOnce()
  acknowledgeNotificationReply(result.id, params.accountKey)
})
