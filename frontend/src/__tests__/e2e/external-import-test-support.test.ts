// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { APIRequestContext } from '@playwright/test'

import { cleanupExternalImportScenario } from '../../../e2e/utils/external-import-test-support'
import {
  configureDingTalkService,
  resetMockMcp,
} from '../../../e2e/utils/provider-native-test-support'

jest.mock('@playwright/test', () => ({
  expect: (actual: unknown, message?: string) => ({
    toBeTruthy: () => {
      if (!actual) throw new Error(message ?? 'Expected a truthy value')
    },
  }),
}))

jest.mock('../../../e2e/config/test-users', () => ({
  ADMIN_USER: { username: 'admin', password: 'password' },
}))

jest.mock('../../../e2e/utils/provider-native-test-support', () => ({
  configureDingTalkService: jest.fn(),
  PROVIDER_NATIVE_API_URL: 'http://backend.test',
  PROVIDER_NATIVE_MOCK_URL: 'http://mock.test',
  resetMockMcp: jest.fn(),
}))

const mockConfigureDingTalkService = jest.mocked(configureDingTalkService)
const mockResetMockMcp = jest.mocked(resetMockMcp)

function response(options: { ok: boolean; body?: unknown }) {
  return {
    ok: () => options.ok,
    status: () => (options.ok ? 200 : 500),
    text: async () => JSON.stringify(options.body ?? {}),
    json: async () => options.body ?? {},
  }
}

function requestContext(
  options: { deleteResults?: boolean[]; documents?: Array<{ id: number }> } = {}
): APIRequestContext {
  const deleteRequest = jest.fn()
  for (const ok of options.deleteResults ?? [true]) {
    deleteRequest.mockResolvedValueOnce(response({ ok }))
  }
  return {
    get: jest
      .fn()
      .mockResolvedValue(response({ ok: true, body: { items: options.documents ?? [] } })),
    delete: deleteRequest,
  } as unknown as APIRequestContext
}

const scenario = {
  token: 'token',
  knowledgeBaseId: 42,
  knowledgeBaseName: 'Test KB',
  prefix: 'test',
}

describe('cleanupExternalImportScenario', () => {
  beforeEach(() => {
    mockConfigureDingTalkService.mockReset().mockResolvedValue(undefined)
    mockResetMockMcp.mockReset().mockResolvedValue(undefined)
  })

  it('fails when a cleanup request returns a non-success response', async () => {
    const request = requestContext({
      documents: [{ id: 7 }],
      deleteResults: [false, true],
    })

    await expect(cleanupExternalImportScenario(request, scenario)).rejects.toThrow()
    expect(request.delete).toHaveBeenCalledTimes(2)
  })

  it('fails when restoring the shared provider state fails', async () => {
    mockConfigureDingTalkService.mockRejectedValue(new Error('restore failed'))

    await expect(cleanupExternalImportScenario(requestContext(), scenario)).rejects.toThrow(
      'External import E2E cleanup failed'
    )
    expect(mockResetMockMcp).toHaveBeenCalledTimes(1)
  })
})
