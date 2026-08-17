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

  test('preserves structured capability reference errors for localized messages', async () => {
    const detail = {
      code: 'CAPABILITY_REFERENCE_IN_USE',
      message: "Cannot unbind Shell 'shared-shell' because it is used by Bots",
      referenced_bots: [{ name: '智能体 A' }, { name: '智能体 B' }],
    }
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      text: jest.fn().mockResolvedValue(JSON.stringify({ detail })),
    })

    await expect(apiClient.delete('/resource-library/listings/1/install')).rejects.toMatchObject({
      name: 'ApiError',
      message: detail.message,
      status: 409,
      errorCode: 'CAPABILITY_REFERENCE_IN_USE',
      detail,
    } satisfies Partial<ApiError>)
  })
})
