// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { adminApis } from '@/apis/admin'
import { apiClient } from '@/apis/client'
import {
  authorizeConnectorApp,
  CONNECTOR_AUTHORIZATION_CHANGED_EVENT,
} from '@/features/settings/connectorOAuth'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    createConnectorOAuthSession: jest.fn(),
    pollConnectorOAuthSession: jest.fn(),
  },
}))

jest.mock('@/apis/client', () => ({
  apiClient: { getCacheScope: jest.fn() },
}))

const mockedAdminApis = jest.mocked(adminApis)
const mockedScope = jest.mocked(apiClient.getCacheScope)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('authorizeConnectorApp lifecycle', () => {
  const session = () => ({
    session_id: 'session-1',
    poll_token: 'poll-token',
    authorize_url: 'https://oauth.example.test/authorize',
    expires_at: Math.floor(Date.now() / 1000) + 60,
    poll_interval_seconds: 0,
  })
  let popup: Window
  let close: jest.Mock
  let replace: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    mockedScope.mockReturnValue('original-account-and-backend')
    mockedAdminApis.createConnectorOAuthSession.mockResolvedValue(session())
    mockedAdminApis.pollConnectorOAuthSession.mockResolvedValue({ status: 'success' })
    close = jest.fn()
    replace = jest.fn()
    popup = { closed: false, opener: window, close, location: { replace } } as unknown as Window
    jest.spyOn(window, 'open').mockReturnValue(popup)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it.each(['another-account', 'another-backend'])(
    'does not navigate or poll after switching to %s during session creation',
    async nextScope => {
      const pendingSession =
        deferred<Awaited<ReturnType<typeof adminApis.createConnectorOAuthSession>>>()
      mockedAdminApis.createConnectorOAuthSession.mockReturnValueOnce(pendingSession.promise)
      const flow = authorizeConnectorApp('app')
      const cancelled = expect(flow).rejects.toMatchObject({ name: 'AbortError' })

      mockedScope.mockReturnValue(nextScope)
      pendingSession.resolve(session())
      await cancelled

      expect(replace).not.toHaveBeenCalled()
      expect(mockedAdminApis.pollConnectorOAuthSession).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalled()
      expect(window.open).toHaveBeenCalledTimes(1)
    }
  )

  it('stops before polling when its dialog closes', async () => {
    let active = true
    const flow = authorizeConnectorApp('app', { isCurrent: () => active })
    const cancelled = expect(flow).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()

    active = false
    await jest.advanceTimersByTimeAsync(500)
    await cancelled

    expect(replace).toHaveBeenCalledWith(session().authorize_url)
    expect(mockedAdminApis.pollConnectorOAuthSession).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('ignores a late successful poll from the previous account', async () => {
    const pendingPoll = deferred<Awaited<ReturnType<typeof adminApis.pollConnectorOAuthSession>>>()
    mockedAdminApis.pollConnectorOAuthSession.mockReturnValueOnce(pendingPoll.promise)
    const dispatch = jest.spyOn(window, 'dispatchEvent')
    const flow = authorizeConnectorApp('app')
    const cancelled = expect(flow).rejects.toMatchObject({ name: 'AbortError' })
    await jest.advanceTimersByTimeAsync(500)
    expect(mockedAdminApis.pollConnectorOAuthSession).toHaveBeenCalledTimes(1)

    mockedScope.mockReturnValue('another-account')
    pendingPoll.resolve({ status: 'success' })
    await cancelled

    expect(dispatch).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('does not start an authorization for an inactive dialog', async () => {
    await expect(authorizeConnectorApp('app', { isCurrent: () => false })).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(window.open).not.toHaveBeenCalled()
    expect(mockedAdminApis.createConnectorOAuthSession).not.toHaveBeenCalled()
  })

  it('closes the fallback popup when the authorization is cancelled', async () => {
    jest.mocked(window.open).mockReturnValueOnce(null).mockReturnValueOnce(popup)
    let active = true
    const flow = authorizeConnectorApp('app', { isCurrent: () => active })
    const cancelled = expect(flow).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(window.open).toHaveBeenLastCalledWith(session().authorize_url, '_blank')

    active = false
    await jest.advanceTimersByTimeAsync(500)
    await cancelled

    expect(close).toHaveBeenCalledTimes(1)
    expect(mockedAdminApis.pollConnectorOAuthSession).not.toHaveBeenCalled()
  })

  it('notifies listeners when authorization completes in the current scope', async () => {
    const dispatch = jest.spyOn(window, 'dispatchEvent')
    const flow = authorizeConnectorApp('app')

    await jest.advanceTimersByTimeAsync(500)
    await flow

    expect(mockedAdminApis.pollConnectorOAuthSession).toHaveBeenCalledWith(
      'session-1',
      'poll-token'
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: CONNECTOR_AUTHORIZATION_CHANGED_EVENT })
    )
    expect(close).not.toHaveBeenCalled()
  })
})
