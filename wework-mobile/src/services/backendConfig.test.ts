import { describe, expect, it } from 'vitest'

import { normalizeBackendUrl } from './backendConfig'

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
