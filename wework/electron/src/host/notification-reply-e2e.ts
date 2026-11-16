import { HostCapabilityError, type HostCapabilityRouter } from './capability-router.js'
import { enqueueNotificationReply } from './notification-replies.js'

/** OS-input fixture only: queue ownership, delivery and persistence remain production code. */
export function registerNotificationReplyE2E(
  router: HostCapabilityRouter,
  publish: () => void
): void {
  router.register('e2e.enqueueNotificationReply', params => {
    if (process.env.VITE_WEWORK_E2E !== 'true' || !process.env.WEWORK_E2E_CONTROL_URL?.trim())
      throw new HostCapabilityError(
        'e2e_disabled',
        'Native reply fixtures require a controlled E2E host'
      )
    const required = (key: string) => {
      const value = params[key]
      if (typeof value !== 'string' || !value.trim())
        throw new HostCapabilityError('invalid_params', `Missing notification reply ${key}`)
      return value
    }
    const url = required('url')
    if (!url.startsWith('wework://'))
      throw new HostCapabilityError('invalid_params', 'Notification replies require a Wework URL')
    const id = enqueueNotificationReply({
      accountKey: required('accountKey'),
      interactionId: required('interactionId'),
      text: required('text'),
      url,
    })
    publish()
    return { id }
  })
}
