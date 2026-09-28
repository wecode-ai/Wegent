import { describe, expect, test, vi } from 'vitest'

import { cloudFetch } from './cloud-http.js'

const electronMocks = vi.hoisted(() => ({ netFetch: vi.fn<typeof fetch>() }))

vi.mock('electron', () => ({ net: { fetch: electronMocks.netFetch } }))

describe('cloudFetch', () => {
  test('delegates to the Chromium network stack', async () => {
    const response = new Response('{"status":"healthy"}', { status: 200 })
    electronMocks.netFetch.mockResolvedValueOnce(response)

    await expect(
      cloudFetch('https://cloud.example.com/api/health', { method: 'GET' })
    ).resolves.toBe(response)
    expect(electronMocks.netFetch).toHaveBeenCalledWith('https://cloud.example.com/api/health', {
      method: 'GET',
    })
  })

  test('accepts URL inputs and forwards the request init', async () => {
    electronMocks.netFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await cloudFetch(new URL('https://cloud.example.com/api/auth/wework/refresh'), {
      method: 'POST',
      body: '{"refresh_token":"refresh"}',
    })

    expect(electronMocks.netFetch).toHaveBeenCalledWith(
      'https://cloud.example.com/api/auth/wework/refresh',
      { method: 'POST', body: '{"refresh_token":"refresh"}' }
    )
  })
})
