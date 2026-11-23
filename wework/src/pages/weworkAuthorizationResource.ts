import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { createHttpClient } from '@/api/http'
import { navigateTo } from '@/lib/navigation'

/** One account/session approval owns its result and delayed window close. */
export function createWeworkAuthorizationResource(
  sessionId: string | null,
  userId: number | undefined,
  backendUrl: string
) {
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleClose = () => {
    if (closeTimer !== undefined) return
    closeTimer = setTimeout(() => window.close(), 3000)
  }
  const resource = createAsyncResource(
    'wework-session-approval',
    async () => {
      if (userId === undefined) return 'login' as const
      const token = localStorage.getItem('wework.cloudConnection.token') || null
      const client = createHttpClient({
        baseUrl: backendUrl,
        getToken: () => token,
        redirectOnUnauthorized: false,
      })
      await client.post(`/auth/wework/sessions/${sessionId}/approve`)
      return 'approved' as const
    },
    {
      success(result) {
        if (result === 'login') {
          const returnUrl = `/auth/wework/authorize?session_id=${encodeURIComponent(sessionId!)}`
          navigateTo(`/login?redirect=${encodeURIComponent(returnUrl)}`)
        } else scheduleClose()
      },
      failure(error) {
        console.error('[WeworkAuthorize] Failed to approve session', error)
      },
    }
  )
  return {
    getSnapshot: resource.getSnapshot,
    subscribe(notify: () => void) {
      const stop = resource.subscribe(notify)
      const snapshot = resource.getSnapshot()
      if (snapshot.status === 'ready' && snapshot.data === 'approved') scheduleClose()
      return () => {
        stop()
        if (resource.hasSubscribers()) return
        clearTimeout(closeTimer)
        closeTimer = undefined
      }
    },
  }
}
