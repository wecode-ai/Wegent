/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { APIRequestContext, Page, TestInfo } from '@playwright/test'

type Callback = (
  fixtures: { request: APIRequestContext; page: Page },
  info: TestInfo
) => Promise<void>
const mockCases: Callback[] = []
const mockBeforeAll: Callback[] = []
const mockAfterEach: Callback[] = []
const mockExpect = expect

// Exercise the actual suite callbacks with runner/browser/HTTP boundaries simulated.
jest.mock('@playwright/test', () => ({
  expect: (value: unknown) => mockExpect(value),
  test: Object.assign((_name: string, body: Callback) => mockCases.push(body), {
    describe: Object.assign((_name: string, body: () => void) => body(), {
      configure: jest.fn(),
    }),
    beforeAll: (body: Callback) => mockBeforeAll.push(body),
    afterAll: jest.fn(),
    afterEach: (body: Callback) => mockAfterEach.push(body),
  }),
}))

jest.mock('../../../e2e/config/test-users', () => ({
  ADMIN_USER: { username: 'admin', password: 'test-password' },
  REGULAR_USER: { username: 'user', password: 'test-password' },
}))

function response(body: unknown, ok = true) {
  return {
    ok: () => ok,
    status: () => (ok ? 200 : 500),
    headers: () => ({}),
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

beforeAll(async () => {
  await import('../../../e2e/tests/knowledge/dingtalk-import.spec')
})

afterEach(() => jest.restoreAllMocks())

it.each(['none', 'cleanup', 'evidence'])(
  'preserves failure evidence and still attempts cleanup when %s fails',
  async failure => {
    let documents: unknown[] = []
    let calls: unknown[] = []
    let deleted = false
    const failedDocument = { id: 7, index_status: 'failed' }
    const failedCall = { name: 'get_document_content', isError: true }
    const bodyError = new Error('Browser assertion failed')
    const attach = jest.fn().mockResolvedValue(undefined)
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    if (failure === 'evidence') attach.mockRejectedValue(new Error('Attachment failed'))
    const info = { status: 'passed', attach } as unknown as TestInfo
    const request = {
      get: jest.fn(async (url: string) => {
        if (url.endsWith('/mcp-control/calls')) return response([...calls])
        if (url.includes('/documents')) return response({ items: [...documents] })
        return response({ status: 'ok' })
      }),
      post: jest.fn(async (url: string, options?: { data?: Record<string, unknown> }) => {
        if (url.endsWith('/api/auth/login')) return response({ access_token: 'token' })
        if (url.endsWith('/api/knowledge-bases')) {
          return response({ id: 42, retrieval_config: options?.data?.retrieval_config })
        }
        if (url.endsWith('/mcp-control/reset')) calls = []
        return response({ success: true })
      }),
      put: jest.fn(async () => response({})),
      delete: jest.fn(async () => {
        deleted = true
        documents = []
        return response({}, failure !== 'cleanup')
      }),
    } as unknown as APIRequestContext
    const page = {
      goto: jest.fn(async () => {
        documents = [failedDocument]
        calls = [failedCall]
        throw bodyError
      }),
    } as unknown as Page
    const fixtures = { request, page }
    for (const callback of mockBeforeAll) await callback(fixtures, info)

    await expect(mockCases[0](fixtures, info)).rejects.toBe(bodyError)
    info.status = 'failed'
    for (const callback of mockAfterEach) await callback(fixtures, info)

    expect(attach).toHaveBeenCalledTimes(1)
    expect(JSON.parse(attach.mock.calls[0][1].body)).toEqual({
      knowledgeBaseId: 42,
      documents: [failedDocument],
      mcpCalls: [failedCall],
    })
    expect(deleted).toBe(true)
    expect(documents).toEqual([])
    expect(calls).toEqual([])
    if (failure !== 'none') expect(log).toHaveBeenCalled()
  }
)
