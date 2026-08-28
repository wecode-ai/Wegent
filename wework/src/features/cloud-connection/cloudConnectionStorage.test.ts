import { afterEach, describe, expect, it } from 'vitest'
import {
  clearStoredCloudConnection,
  normalizeCloudBackendUrl,
  readStoredCloudConnection,
  saveStoredCloudConnection,
} from './cloudConnectionStorage'

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
    saveStoredCloudConnection({
      ...normalizeCloudBackendUrl('http://127.0.0.1:8000'),
      user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
      connectedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(readStoredCloudConnection()?.user.user_name).toBe('alice')
    expect(localStorage.getItem('wework.cloudConnection')).not.toContain('token')
    clearStoredCloudConnection()
    expect(readStoredCloudConnection()).toBeNull()
    expect(localStorage.getItem('auth_token')).toBe('local-token')
  })

  it('restores legacy access-token connections created by older Backends', () => {
    const token = 'header.payload.signature'
    localStorage.setItem(
      'wework.cloudConnection',
      JSON.stringify({
        ...normalizeCloudBackendUrl('https://legacy.example.com'),
        token,
        tokenExpiresAt: null,
        user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
        connectedAt: '2026-08-28T00:00:00.000Z',
      })
    )

    expect(readStoredCloudConnection()).toMatchObject({
      credentialMode: 'legacy_access_token',
      token,
      tokenExpiresAt: null,
    })
  })
})
