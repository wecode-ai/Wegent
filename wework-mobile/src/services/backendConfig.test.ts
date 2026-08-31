import { afterEach, describe, expect, it } from 'vitest'

import { configuredBackendUrl, normalizeBackendUrl } from './backendConfig'

const originalBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL

afterEach(() => {
  if (originalBackendUrl === undefined) delete process.env.EXPO_PUBLIC_BACKEND_URL
  else process.env.EXPO_PUBLIC_BACKEND_URL = originalBackendUrl
})

describe('configuredBackendUrl', () => {
  it('has no implicit Backend when the build parameter is omitted', () => {
    delete process.env.EXPO_PUBLIC_BACKEND_URL

    expect(configuredBackendUrl()).toBeNull()
  })

  it('uses and trims the optional build-time Backend', () => {
    process.env.EXPO_PUBLIC_BACKEND_URL = '  https://example.com/wegent  '

    expect(configuredBackendUrl()).toBe('https://example.com/wegent')
  })
})

describe('normalizeBackendUrl', () => {
  it('derives the same REST and Socket paths as Wework', () => {
    expect(normalizeBackendUrl('http://localhost:8000')).toEqual({
      backendUrl: 'http://localhost:8000',
      apiBaseUrl: 'http://localhost:8000/api',
      socketBaseUrl: 'http://localhost:8000',
      socketPath: '/socket.io',
    })
  })

  it('preserves a reverse-proxy base path and strips an explicit API suffix', () => {
    expect(normalizeBackendUrl('https://example.com/wegent/api')).toMatchObject({
      backendUrl: 'https://example.com/wegent',
      apiBaseUrl: 'https://example.com/wegent/api',
      socketBaseUrl: 'https://example.com/wegent',
    })
  })
})
