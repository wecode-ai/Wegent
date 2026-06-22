/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { GET } from '@/app/runtime-config/route'
import {
  clearRuntimeConfigCache,
  fetchRuntimeConfig,
  getPublicApiBaseUrl,
} from '@/lib/runtime-config'

describe('runtime config caching', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    clearRuntimeConfigCache()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        apiUrl: '',
        publicApiUrl: '',
        socketDirectUrl: '',
        enableChatContext: true,
        loginMode: 'all',
        oidcLoginText: '',
        enableDisplayQuotas: false,
        enableWiki: true,
        enableCodeKnowledgeAddRepo: true,
        vscodeLinkTemplate: '',
        feedbackUrl: 'https://github.com/wecode-ai/wegent/issues/new',
        docsUrl: 'https://wecode-ai.github.io/wegent-docs',
        otelEnabled: false,
        otelServiceName: 'wegent-frontend',
        otelCollectorEndpoint: 'http://localhost:4318',
        bindGroupDesc: '',
        bindGroupSteps: '{"variables":{"botName":"机器人"},"steps":[]}',
        appVersion: 'dev',
        weworkCodeUrl: '',
      }),
    }) as typeof fetch
  })

  afterEach(() => {
    jest.clearAllMocks()
    clearRuntimeConfigCache()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  test('fetchRuntimeConfig uses default cache in non-development mode', async () => {
    await fetchRuntimeConfig()

    // In test/production mode, no cache override is applied
    expect(global.fetch).toHaveBeenCalledWith('/runtime-config', {})
  })

  test('runtime config route returns caching headers in non-development mode', async () => {
    const response = await GET()

    // In test/production mode, uses caching strategy
    expect(response.headers.get('Cache-Control')).toBe('max-age=60, stale-while-revalidate=300')
  })

  test('runtime config route exposes Wework code URL from runtime env only', async () => {
    const previousRuntimeUrl = process.env.RUNTIME_WEWORK_CODE_URL
    const previousPublicUrl = process.env.NEXT_PUBLIC_WEWORK_CODE_URL

    try {
      process.env.RUNTIME_WEWORK_CODE_URL = 'https://wework.example.com/coding'
      process.env.NEXT_PUBLIC_WEWORK_CODE_URL = 'https://public.example.com/ignored'

      const response = await GET()
      const body = await response.json()

      expect(body.weworkCodeUrl).toBe('https://wework.example.com/coding')

      delete process.env.RUNTIME_WEWORK_CODE_URL

      const fallbackResponse = await GET()
      const fallbackBody = await fallbackResponse.json()

      expect(fallbackBody.weworkCodeUrl).toBe('')
    } finally {
      if (previousRuntimeUrl === undefined) {
        delete process.env.RUNTIME_WEWORK_CODE_URL
      } else {
        process.env.RUNTIME_WEWORK_CODE_URL = previousRuntimeUrl
      }

      if (previousPublicUrl === undefined) {
        delete process.env.NEXT_PUBLIC_WEWORK_CODE_URL
      } else {
        process.env.NEXT_PUBLIC_WEWORK_CODE_URL = previousPublicUrl
      }
    }
  })

  test('getPublicApiBaseUrl uses the public backend URL from runtime config', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        apiUrl: '',
        publicApiUrl: 'http://1.1.1.1:8000',
        socketDirectUrl: '',
        enableChatContext: true,
        loginMode: 'all',
        oidcLoginText: '',
        enableDisplayQuotas: false,
        enableWiki: true,
        enableCodeKnowledgeAddRepo: true,
        vscodeLinkTemplate: '',
        feedbackUrl: 'https://github.com/wecode-ai/wegent/issues/new',
        docsUrl: 'https://wecode-ai.github.io/wegent-docs',
        otelEnabled: false,
        otelServiceName: 'wegent-frontend',
        otelCollectorEndpoint: 'http://localhost:4318',
        bindGroupDesc: '',
        bindGroupSteps: '{"variables":{"botName":"机器人"},"steps":[]}',
        appVersion: 'dev',
        weworkCodeUrl: '',
      }),
    }) as typeof fetch

    await fetchRuntimeConfig()

    expect(getPublicApiBaseUrl()).toBe('http://1.1.1.1:8000/api')
  })
})
