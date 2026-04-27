/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { GET } from '@wecode/api/published-apps-route'

function createRequest(username = 'yinlu') {
  return {
    headers: new Headers({
      'sec-fetch-site': 'same-origin',
      referer: 'http://127.0.0.1:3000/settings',
      host: '127.0.0.1:3000',
    }),
    nextUrl: new URL(`http://127.0.0.1:3000/api/published-apps?username=${username}`),
  } as never
}

describe('published apps API route', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = {
      ...originalEnv,
      RUNTIME_PUBLISHED_APPS_API_URL: 'http://published-apps.example.com',
      RUNTIME_PUBLISHED_APPS_API_TOKEN: 'service-token',
    }
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: 'success',
          data: { total: 0, page: 1, page_size: 20, apps: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as jest.Mock
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test('proxies current username to app list service with server-side token', async () => {
    const response = await GET(createRequest())

    expect(response.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledWith(
      'http://published-apps.example.com/app/list?username=yinlu',
      expect.objectContaining({
        method: 'GET',
        headers: expect.any(Headers),
      })
    )

    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer service-token')
  })
})
