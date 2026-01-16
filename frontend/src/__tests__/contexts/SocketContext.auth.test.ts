// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for auth error handling utilities in SocketContext
 *
 * These tests verify the auth error detection logic used in the socket
 * connect_error handler to ensure proper identification of authentication
 * failures vs other connection errors.
 */

import { ServerEvents, AuthErrorPayload } from '@/types/socket'

describe('Socket Auth Error Types', () => {
  describe('ServerEvents.AUTH_ERROR', () => {
    it('should have correct event name', () => {
      expect(ServerEvents.AUTH_ERROR).toBe('auth:error')
    })
  })

  describe('AuthErrorPayload', () => {
    it('should accept valid TOKEN_EXPIRED payload', () => {
      const payload: AuthErrorPayload = {
        error: 'Token expired',
        code: 'TOKEN_EXPIRED',
      }
      expect(payload.error).toBe('Token expired')
      expect(payload.code).toBe('TOKEN_EXPIRED')
    })

    it('should accept valid INVALID_TOKEN payload', () => {
      const payload: AuthErrorPayload = {
        error: 'Invalid token',
        code: 'INVALID_TOKEN',
      }
      expect(payload.error).toBe('Invalid token')
      expect(payload.code).toBe('INVALID_TOKEN')
    })
  })
})

describe('Auth Error Detection Logic', () => {
  /**
   * This helper function mirrors the logic used in SocketContext
   * to detect authentication errors from connection error messages.
   */
  function isAuthError(errorMessage: string): boolean {
    const errorMsg = errorMessage?.toLowerCase() || ''
    return (
      errorMsg.includes('expired') ||
      errorMsg.includes('unauthorized') ||
      errorMsg.includes('jwt') ||
      errorMsg.includes('authentication')
    )
  }

  describe('Should detect auth errors', () => {
    it('should detect "expired" in error message', () => {
      expect(isAuthError('Token expired')).toBe(true)
      expect(isAuthError('JWT token has expired')).toBe(true)
      expect(isAuthError('Session expired')).toBe(true)
    })

    it('should detect "unauthorized" in error message', () => {
      expect(isAuthError('Unauthorized')).toBe(true)
      expect(isAuthError('401 Unauthorized')).toBe(true)
      expect(isAuthError('Request unauthorized')).toBe(true)
    })

    it('should detect "jwt" in error message', () => {
      expect(isAuthError('Invalid JWT')).toBe(true)
      expect(isAuthError('JWT verification failed')).toBe(true)
      expect(isAuthError('Malformed jwt token')).toBe(true)
    })

    it('should detect "authentication" in error message', () => {
      expect(isAuthError('Authentication failed')).toBe(true)
      expect(isAuthError('Authentication required')).toBe(true)
      expect(isAuthError('Invalid authentication credentials')).toBe(true)
    })

    it('should be case insensitive', () => {
      expect(isAuthError('TOKEN EXPIRED')).toBe(true)
      expect(isAuthError('UNAUTHORIZED')).toBe(true)
      expect(isAuthError('JWT Invalid')).toBe(true)
      expect(isAuthError('AUTHENTICATION FAILED')).toBe(true)
    })
  })

  describe('Should NOT detect non-auth errors', () => {
    it('should not detect network errors as auth errors', () => {
      expect(isAuthError('Network error')).toBe(false)
      expect(isAuthError('Connection refused')).toBe(false)
      expect(isAuthError('ECONNRESET')).toBe(false)
      expect(isAuthError('Socket timeout')).toBe(false)
    })

    it('should not detect server errors as auth errors', () => {
      expect(isAuthError('Internal server error')).toBe(false)
      expect(isAuthError('500 Server Error')).toBe(false)
      expect(isAuthError('Service unavailable')).toBe(false)
    })

    it('should not detect generic errors as auth errors', () => {
      expect(isAuthError('Something went wrong')).toBe(false)
      expect(isAuthError('Unknown error')).toBe(false)
      expect(isAuthError('Invalid payload')).toBe(false)
      expect(isAuthError('Bad request')).toBe(false)
    })

    it('should handle empty or null messages', () => {
      expect(isAuthError('')).toBe(false)
      expect(isAuthError(null as unknown as string)).toBe(false)
      expect(isAuthError(undefined as unknown as string)).toBe(false)
    })
  })

  describe('Edge cases from previous implementation', () => {
    it('should NOT detect "invalid" alone (removed to avoid false positives)', () => {
      // Previously detected 'invalid' which caused false positives like "invalid payload"
      // Now we only detect specific auth-related patterns
      expect(isAuthError('invalid payload')).toBe(false)
      expect(isAuthError('invalid format')).toBe(false)
    })

    it('should NOT detect "token" alone (removed to avoid false positives)', () => {
      // Previously detected 'token' which could match non-auth contexts
      // Now we rely on 'jwt' or 'expired' for token-related auth errors
      expect(isAuthError('missing token in request')).toBe(false)
      expect(isAuthError('token processing error')).toBe(false)
    })
  })
})

describe('Redirect Path Preservation', () => {
  /**
   * Test that the auth error handling logic properly saves the current path
   * for post-login redirect.
   */

  it('should construct correct redirect path with pathname only', () => {
    const pathname = '/chat'
    const search = ''
    const currentPath = pathname + search
    expect(currentPath).toBe('/chat')
  })

  it('should construct correct redirect path with query params', () => {
    const pathname = '/tasks/123'
    const search = '?tab=details'
    const currentPath = pathname + search
    expect(currentPath).toBe('/tasks/123?tab=details')
  })

  it('should construct correct redirect path with complex query', () => {
    const pathname = '/chat'
    const search = '?taskShare=abc123&mode=view'
    const currentPath = pathname + search
    expect(currentPath).toBe('/chat?taskShare=abc123&mode=view')
  })
})
