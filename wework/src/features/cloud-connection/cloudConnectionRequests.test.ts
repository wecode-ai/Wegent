import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollWeworkAuthSession } from './cloudConnectionRequests'

const credentials = vi.hoisted(() => ({ claim: vi.fn() }))

vi.mock('@/desktop/cloudCredentials', () => ({
  claimDesktopCloudAuthorization: credentials.claim,
}))

describe('cloud authorization diagnostics', () => {
  const config = {
    backendUrl: 'https://cloud.example',
    apiBaseUrl: 'https://cloud.example/api',
    socketBaseUrl: 'https://cloud.example',
    socketPath: '/socket.io',
  }
  const session = {
    session_id: 'session',
    poll_token: 'private-poll-token',
    authorize_url: 'https://cloud.example/authorize',
    web_url: 'https://cloud.example',
    expires_at: 0,
    poll_interval_seconds: 1,
  }

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    credentials.claim.mockReset()
  })

  afterEach(() => vi.restoreAllMocks())

  it.each([false, true])(
    'keeps poll credentials out of logs and errors (failure=%s)',
    async failed => {
      if (failed) credentials.claim.mockRejectedValueOnce(new Error('Connection interrupted'))
      else credentials.claim.mockResolvedValueOnce({ status: 'pending' })

      const request = pollWeworkAuthSession(config, session, 'candidate')
      if (failed) {
        await expect(request).rejects.toThrow('/auth/wework/sessions/session/poll')
        await expect(request).rejects.not.toThrow(session.poll_token)
      } else await expect(request).resolves.toEqual({ status: 'pending' })

      expect(credentials.claim).toHaveBeenCalledWith({
        authorizationId: 'candidate',
        sessionId: session.session_id,
        pollToken: session.poll_token,
      })
      const diagnostics = JSON.stringify([
        vi.mocked(console.info).mock.calls,
        vi.mocked(console.error).mock.calls,
      ])
      expect(diagnostics).toContain('/auth/wework/sessions/session/poll')
      expect(diagnostics).not.toContain(session.poll_token)
      expect(diagnostics).not.toContain('poll_token=')
    }
  )
})
