import { describe, expect, it } from 'vitest'

import { weworkWebSessionScript } from './weworkWebSession'

describe('weworkWebSessionScript', () => {
  it('writes the access token and expiry into the trusted web origin', () => {
    const script = weworkWebSessionScript('token-value', 1_800_000_000_000)

    expect(script).toContain(`var token = "token-value";`)
    expect(script).toContain('var expiresAt = 1800000000000;')
    expect(script).toContain(`localStorage.setItem('auth_token', token)`)
    expect(script).toContain(`localStorage.setItem('auth_token_expire', String(expiresAt))`)
    expect(script).toContain(`document.cookie = cookie`)
  })

  it('escapes token text instead of interpolating executable source', () => {
    const script = weworkWebSessionScript(`alpha"; window.pwned = true; //`, null)

    expect(script).toContain(`var token = "alpha\\"; window.pwned = true; //";`)
    expect(script).toContain(`localStorage.removeItem('auth_token_expire')`)
  })
})
