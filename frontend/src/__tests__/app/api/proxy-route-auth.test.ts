/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { GET } from '@/app/api/[...path]/route'

jest.mock('@/lib/server-config', () => ({
  getInternalApiUrl: jest.fn(() => 'http://localhost:8000'),
}))

type ProxyRequestOptions = {
  authorization?: string
  tokenCookie?: string
}

function createProxyRequest({ authorization, tokenCookie }: ProxyRequestOptions = {}) {
  const headers = new Headers({
    'sec-fetch-site': 'same-origin',
    referer: 'http://127.0.0.1:3001/chat?taskId=2941',
  })

  if (authorization) {
    headers.set('Authorization', authorization)
  }

  return {
    method: 'GET',
    headers,
    nextUrl: new URL(
      'http://127.0.0.1:3001/api/tasks/2941/remote-workspace/file?path=%2Fhome%2Fuser%2Fabc.txt&disposition=inline'
    ),
    cookies: {
      get: (name: string) => {
        if (name === 'auth_token' && tokenCookie) {
          return { name, value: tokenCookie }
        }
        return undefined
      },
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as never
}

describe('API proxy auth forwarding', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('ok', {
        status: 200,
      })
    ) as jest.Mock
  })

  test('injects Authorization header from auth_token cookie when header is missing', async () => {
    const token = 'abc.def.ghi'
    const request = createProxyRequest({ tokenCookie: encodeURIComponent(token) })

    await GET(request, {
      params: Promise.resolve({
        path: ['tasks', '2941', 'remote-workspace', 'file'],
      }),
    })

    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    const forwardedHeaders = init.headers as Headers

    expect(forwardedHeaders.get('Authorization')).toBe(`Bearer ${token}`)
  })

  test('does not override existing Authorization header', async () => {
    const request = createProxyRequest({
      authorization: 'Bearer explicit.header.token',
      tokenCookie: encodeURIComponent('cookie.token'),
    })

    await GET(request, {
      params: Promise.resolve({
        path: ['tasks', '2941', 'remote-workspace', 'file'],
      }),
    })

    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    const forwardedHeaders = init.headers as Headers

    expect(forwardedHeaders.get('Authorization')).toBe('Bearer explicit.header.token')
  })
})
