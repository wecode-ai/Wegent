// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  ExternalKnowledgeApiError,
  listExternalKnowledgeBases,
} from '@wecode/api/external-knowledge'
import { removeToken } from '@/apis/user'

jest.mock('@/lib/runtime-config', () => ({
  getApiBaseUrl: () => '',
}))

jest.mock('@/apis/user', () => ({
  getToken: () => 'wegent-token',
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

jest.mock('@/features/login/constants', () => ({
  POST_LOGIN_REDIRECT_KEY: 'post_login_redirect',
  sanitizeRedirectPath: (value: string) => value,
}))

describe('external knowledge API auth handling', () => {
  const mockFetch = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: mockFetch,
    })
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/knowledge', search: '?type=document', href: '' },
    })
  })

  it('surfaces provider unauthorized errors without logging out the Wegent user', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({
        detail: { code: 'unauthorized', message: 'AP token expired' },
      }),
    })

    await expect(listExternalKnowledgeBases('ap')).rejects.toMatchObject({
      name: 'ExternalKnowledgeApiError',
      status: 401,
      code: 'unauthorized',
      message: 'AP token expired',
    } satisfies Partial<ExternalKnowledgeApiError>)

    expect(removeToken).not.toHaveBeenCalled()
    expect(window.location.href).toBe('')
  })

  it('redirects to login when a 401 has no provider error code', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({ detail: 'Not authenticated' }),
    })

    await expect(listExternalKnowledgeBases('ap')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })

    expect(removeToken).toHaveBeenCalledTimes(1)
    expect(window.location.href).toBe('/login?redirect=%2Fknowledge%3Ftype%3Ddocument')
  })
})
