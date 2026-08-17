import { afterEach, describe, expect, it } from 'vitest'
import {
  clearStoredCloudConnection,
  getJwtExpiry,
  normalizeCloudBackendUrl,
  readStoredCloudConnection,
  saveStoredCloudConnection,
} from './cloudConnectionStorage'

function tokenWithExp(exp: number): string {
  const payload = btoa(JSON.stringify({ exp })).replace(/=/g, '')
  return `header.${payload}.signature`
}

describe('cloudConnectionStorage', () => {
  afterEach(() => {
    clearStoredCloudConnection()
  })

  it('normalizes backend root URLs to api and socket endpoints', () => {
    expect(normalizeCloudBackendUrl('https://example.com')).toEqual({
      backendUrl: 'https://example.com',
      apiBaseUrl: 'https://example.com/api',
      socketBaseUrl: 'https://example.com',
      socketPath: '/socket.io',
    })
  })

  it('accepts /api URLs without duplicating the api path', () => {
    expect(normalizeCloudBackendUrl('https://example.com/wework/api/')).toEqual({
      backendUrl: 'https://example.com/wework',
      apiBaseUrl: 'https://example.com/wework/api',
      socketBaseUrl: 'https://example.com/wework',
      socketPath: '/socket.io',
    })
  })

  it('adds http protocol when the user enters host and port only', () => {
    expect(normalizeCloudBackendUrl('localhost:8000').apiBaseUrl).toBe('http://localhost:8000/api')
  })

  it('uses an optional Socket URL override', () => {
    expect(
      normalizeCloudBackendUrl('https://cloud.example.com/api', 'wss://wss-cloud.example.com/')
    ).toEqual({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://wss-cloud.example.com',
      socketPath: '/socket.io',
    })
  })

  it('rejects an invalid Socket URL override', () => {
    expect(() => normalizeCloudBackendUrl('https://cloud.example.com', 'not-a-url')).toThrow(
      'Socket URL is invalid'
    )
  })

  it('persists and clears the cloud connection independently from auth_token', () => {
    localStorage.setItem('auth_token', 'local-token')
    const token = tokenWithExp(2_000_000_000)
    saveStoredCloudConnection({
      ...normalizeCloudBackendUrl('http://127.0.0.1:8000'),
      token,
      tokenExpiresAt: getJwtExpiry(token),
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(readStoredCloudConnection()?.user.user_name).toBe('alice')
    clearStoredCloudConnection()
    expect(readStoredCloudConnection()).toBeNull()
    expect(localStorage.getItem('auth_token')).toBe('local-token')
  })
})
