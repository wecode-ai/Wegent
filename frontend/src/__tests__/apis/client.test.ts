// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ApiError, apiClient } from '@/apis/client'

jest.mock('@/apis/user', () => ({
  getToken: jest.fn(() => null),
  removeToken: jest.fn(),
}))

jest.mock('@/config/paths', () => ({
  paths: {
    auth: {
      login: {
        getHref: () => '/login',
      },
    },
  },
}))

jest.mock('@/lib/runtime-config', () => ({
  getApiBaseUrl: jest.fn(() => '/api'),
  fetchRuntimeConfig: jest.fn(),
}))

describe('apiClient', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock
  })

  test('extracts structured validation error code from detail payload', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          error_code: null,
          detail: {
            error_code: 'DUPLICATE_DOCUMENT_NAMES',
            names: ['same-name.md'],
          },
        })
      ),
    })

    await expect(apiClient.post('/knowledge-bases/1/transfer-documents', {})).rejects.toMatchObject(
      {
        name: 'ApiError',
        message: 'DUPLICATE_DOCUMENT_NAMES',
        status: 400,
        errorCode: 'DUPLICATE_DOCUMENT_NAMES',
      } satisfies Partial<ApiError>
    )
  })
})
