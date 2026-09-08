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
  requestId?: string
  skillName?: string
  tokenCookie?: string
}

function createProxyRequest({
  authorization,
  requestId,
  skillName,
  tokenCookie,
}: ProxyRequestOptions = {}) {
  const headers = new Headers({
    'sec-fetch-site': 'same-origin',
    referer: 'http://127.0.0.1:3001/chat?taskId=2941',
  })

  if (authorization) {
    headers.set('Authorization', authorization)
  }
  if (requestId) {
    headers.set('X-Request-ID', requestId)
  }
  if (skillName) {
    headers.set('X-Wegent-Skill-Name', encodeURIComponent(skillName))
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

describe('API proxy Skill download observability', () => {
  test('logs safe upstream fields and returns gateway timing headers', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('zip-data', {
        status: 200,
        headers: {
          'Content-Length': '8',
          'X-Request-ID': 'skill-request-42',
          'X-Wegent-Backend-Time-Ms': '12.5',
          'X-Wegent-Skill-Bytes': '8',
          'X-Wegent-Skill-Cache-Source': 'skill_binary',
          'X-Wegent-Skill-Name': 'wegent-knowledge',
        },
      })
    ) as jest.Mock
    const info = jest.spyOn(console, 'info').mockImplementation()
    const request = createProxyRequest({
      authorization: 'Bearer must-not-be-logged',
      requestId: 'skill-request-42',
      skillName: 'wegent-knowledge',
    })

    const response = await GET(request, {
      params: Promise.resolve({
        path: ['v1', 'kinds', 'skills', '42', 'download'],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Wegent-Gateway-Upstream-Time-Ms')).not.toBeNull()
    expect(response.headers.get('X-Wegent-Gateway-Upstream-Status')).toBe('200')
    const observation = JSON.parse(info.mock.calls[0][1])
    expect(info.mock.calls[0][0]).toBe('[Skill Download]')
    expect(observation).toEqual(
      expect.objectContaining({
        component: 'gateway',
        skill_id: '42',
        skill_name: 'wegent-knowledge',
        cache_source: 'skill_binary',
        bytes: 8,
        result: 'success',
        inflight: 1,
        upstream_status: 200,
        backend_time_ms: 12.5,
        request_id: 'skill-request-42',
      })
    )
    expect(JSON.stringify(info.mock.calls)).not.toContain('must-not-be-logged')
    info.mockRestore()
  })

  test('records an upstream 504 without response content or credentials', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 504 })) as jest.Mock
    const info = jest.spyOn(console, 'info').mockImplementation()
    const request = createProxyRequest({
      authorization: 'Bearer gateway-secret',
      skillName: 'wegent-knowledge',
    })

    const response = await GET(request, {
      params: Promise.resolve({
        path: ['v1', 'kinds', 'skills', '110603', 'download'],
      }),
    })

    expect(response.status).toBe(504)
    const observation = JSON.parse(info.mock.calls[0][1])
    expect(info.mock.calls[0][0]).toBe('[Skill Download]')
    expect(observation).toEqual(
      expect.objectContaining({
        skill_id: '110603',
        skill_name: 'wegent-knowledge',
        cache_source: 'none',
        bytes: 0,
        result: 'http_error',
        inflight: 1,
        upstream_status: 504,
      })
    )
    expect(JSON.stringify(info.mock.calls)).not.toContain('gateway-secret')
    info.mockRestore()
  })

  test('captures concurrent upstream downloads in the inflight field', async () => {
    const resolvers: Array<(response: Response) => void> = []
    global.fetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          resolvers.push(resolve)
        })
    ) as jest.Mock
    const info = jest.spyOn(console, 'info').mockImplementation()

    const first = GET(createProxyRequest({ skillName: 'first-skill' }), {
      params: Promise.resolve({ path: ['v1', 'kinds', 'skills', '1', 'download'] }),
    })
    const second = GET(createProxyRequest({ skillName: 'second-skill' }), {
      params: Promise.resolve({ path: ['v1', 'kinds', 'skills', '2', 'download'] }),
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(resolvers).toHaveLength(2)
    resolvers[1](new Response('second', { status: 200 }))
    await second
    resolvers[0](new Response('first', { status: 200 }))
    await first

    const observations = info.mock.calls.map(call => JSON.parse(call[1]))
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skill_id: '1', inflight: 1 }),
        expect.objectContaining({ skill_id: '2', inflight: 2 }),
      ])
    )
    info.mockRestore()
  })
})
