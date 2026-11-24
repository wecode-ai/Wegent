import { renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { DISCONNECTED_STATE } from '@/features/cloud-connection/CloudConnectionContext'
import { useCloudIssueApis } from './useCloudIssueApis'

test('keeps Issue clients mounted while requests use the refreshed account token', async () => {
  let token = 'initial'
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ items: [] }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const connection = {
      ...DISCONNECTED_STATE,
      status: 'connected' as const,
      token,
      isConnected: true,
      apiBaseUrl: 'https://wework.example.test',
      serviceKey: 'initial',
      user: { id: 7, user_name: 'reviewer', email: '' },
      getTokenForAccount: () => token,
      connectWithAuthorization: async () => {
        throw new Error('Unexpected authorization')
      },
      refreshUser: async () => null,
      disconnect: () => undefined,
    }
    const { result, rerender } = renderHook(useCloudIssueApis, { initialProps: connection })
    const clients = result.current
    token = 'refreshed'
    rerender({ ...connection, token, serviceKey: 'refreshed' })
    expect(result.current).toBe(clients)
    await result.current?.personal.projects()
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer refreshed'
    )
  } finally {
    vi.unstubAllGlobals()
  }
})
