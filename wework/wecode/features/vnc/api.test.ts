import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createHttpClient } from '@/api/http'
import { getVncConfig } from './api'

vi.mock('@/api/http', () => ({ createHttpClient: vi.fn() }))

const getMock = vi.fn()

describe('getVncConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createHttpClient).mockReturnValue({ get: getMock } as never)
    getMock.mockResolvedValue({
      sandbox_id: 'sandbox-1',
      signature: 'signature',
      wss_url: 'wss://cloud.example.com/vnc',
    })
  })

  test('uses the active connection token and an encoded device ID', async () => {
    const response = await getVncConfig(
      {
        apiBaseUrl: 'https://cloud.example.com/api',
        isConnected: true,
        socketBaseUrl: 'https://cloud.example.com',
        token: 'cloud-token',
      },
      'device/1'
    )

    expect(response.sandbox_id).toBe('sandbox-1')
    expect(createHttpClient).toHaveBeenCalledWith({
      baseUrl: 'https://cloud.example.com/api',
      getToken: expect.any(Function),
      redirectOnUnauthorized: false,
    })
    const options = vi.mocked(createHttpClient).mock.calls[0][0]
    expect(options.getToken?.()).toBe('cloud-token')
    expect(getMock).toHaveBeenCalledWith('/cloud-devices/device%2F1/vnc-config')
  })

  test.each([
    [{ isConnected: false, token: null }],
    [{ isConnected: true, token: 'cloud-token' }],
    [{ apiBaseUrl: 'https://cloud.example.com/api', isConnected: true, token: null }],
  ])('rejects an incomplete cloud connection before creating a client', async connection => {
    await expect(getVncConfig(connection, 'device-1')).rejects.toThrow(
      'Cloud connection is required'
    )
    expect(createHttpClient).not.toHaveBeenCalled()
  })
})
