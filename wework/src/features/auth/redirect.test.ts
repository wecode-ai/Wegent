import { describe, expect, test } from 'vitest'
import { sanitizeRedirectPath } from './redirect'

describe('sanitizeRedirectPath', () => {
  test('allows safe local paths with query strings', () => {
    expect(sanitizeRedirectPath('/?task=1')).toBe('/?task=1')
  })

  test('rejects external and login-loop redirects', () => {
    expect(sanitizeRedirectPath('https://evil.test')).toBeNull()
    expect(sanitizeRedirectPath('//evil.test')).toBeNull()
    expect(sanitizeRedirectPath('/login', ['/login', '/login/oidc'])).toBeNull()
    expect(sanitizeRedirectPath('/login/oidc', ['/login', '/login/oidc'])).toBeNull()
  })
})
