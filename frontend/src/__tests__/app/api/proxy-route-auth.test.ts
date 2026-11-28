/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/[...path]/route'

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

  test('forwards the cross-site Connector OAuth callback and its result page', async () => {
    const path = ['connector-apps', 'oauth', 'callback']
    const query = '?code=provider-code&state=oauth-state'
    const request = new NextRequest('https://wegent.example.test/api/' + path.join('/') + query, {
      headers: { 'sec-fetch-site': 'cross-site', 'accept-language': 'zh-CN' },
    })
    jest.mocked(fetch).mockResolvedValueOnce(
      new Response('<h1>连接器已连接</h1>', {
        headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
      })
    )

    const response = await GET(request, { params: Promise.resolve({ path }) })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('<h1>连接器已连接</h1>')
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/' + path.join('/') + query,
      expect.objectContaining({ method: 'GET' })
    )
  })

  test.each([
    ['GET', GET, ['connector-apps']],
    ['GET', GET, ['connector-apps', 'oauth', 'callback-extra']],
    ['POST', POST, ['connector-apps', 'oauth', 'callback']],
  ] as const)(
    'blocks cross-site %s to other Connector routes',
    async (method, handler, segments) => {
      const path = [...segments]
      const request = new NextRequest('https://wegent.example.test/api/' + path.join('/'), {
        method,
        headers: { 'sec-fetch-site': 'cross-site' },
      })

      const response = await handler(request, { params: Promise.resolve({ path }) })

      expect(response.status).toBe(404)
      expect(fetch).not.toHaveBeenCalled()
    }
  )
})
