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

  it('uses the preferred socket endpoint for the configured backend', () => {
    const preferredSocket = {
      backendUrls: ['https://cloud.example.com/api'],
      socketBaseUrl: 'https://wss-cloud.example.com',
      socketPath: '/socket.io',
    }

    expect(normalizeCloudBackendUrl('https://cloud.example.com/api', preferredSocket)).toEqual({
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'https://wss-cloud.example.com',
      socketPath: '/socket.io',
    })
    expect(normalizeCloudBackendUrl('https://custom.example.com', preferredSocket)).toEqual({
      backendUrl: 'https://custom.example.com',
      apiBaseUrl: 'https://custom.example.com/api',
      socketBaseUrl: 'https://custom.example.com',
      socketPath: '/socket.io',
    })
  })

  it('ignores an invalid preferred backend URL', () => {
    expect(
      normalizeCloudBackendUrl('https://custom.example.com', {
        backendUrls: ['', '://invalid'],
        socketBaseUrl: 'https://wss-cloud.example.com',
        socketPath: '/socket.io',
      })
    ).toEqual({
      backendUrl: 'https://custom.example.com',
      apiBaseUrl: 'https://custom.example.com/api',
      socketBaseUrl: 'https://custom.example.com',
      socketPath: '/socket.io',
    })
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
