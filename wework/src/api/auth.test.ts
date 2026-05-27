import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createAuthApi,
  getToken,
  getTokenExpire,
  isAuthenticated,
  removeToken,
  setToken,
} from './auth'

function createJwt(expSeconds: number) {
  const payload = btoa(JSON.stringify({ exp: expSeconds }))
  return `header.${payload}.signature`
}

describe('auth token lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
    document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('stores token, expiration, and cookie using Wegent keys', () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600
    const token = createJwt(expSeconds)

    setToken(token)

    expect(getToken()).toBe(token)
    expect(getTokenExpire()).toBe(expSeconds * 1000)
    expect(document.cookie).toContain(`auth_token=${encodeURIComponent(token)}`)
    expect(isAuthenticated()).toBe(true)
  })

  test('treats expired tokens as unauthenticated', () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) - 60))

    expect(isAuthenticated()).toBe(false)
  })

  test('removes token and cookie', () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) + 3600))

    removeToken()

    expect(getToken()).toBeNull()
    expect(getTokenExpire()).toBeNull()
    expect(document.cookie).not.toContain('auth_token=')
  })
})

describe('createAuthApi', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('logs in by storing access token and fetching current user', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }),
      post: vi.fn().mockResolvedValue({
        access_token: createJwt(Math.floor(Date.now() / 1000) + 3600),
        token_type: 'bearer',
      }),
      put: vi.fn(),
      delete: vi.fn(),
    }

    const user = await createAuthApi(client).login({
      user_name: 'alice',
      password: 'secret',
    })

    expect(client.post).toHaveBeenCalledWith('/auth/login', {
      user_name: 'alice',
      password: 'secret',
    })
    expect(client.get).toHaveBeenCalledWith('/users/me')
    expect(user.user_name).toBe('alice')
    expect(isAuthenticated()).toBe(true)
  })
})
