import type { User } from '@/types/api'
import type { HttpClient } from './http'

export interface LoginRequest {
  user_name: string
  password: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
}

const TOKEN_KEY = 'auth_token'
const TOKEN_EXPIRE_KEY = 'auth_token_expire'
const TOKEN_COOKIE_NAME = 'auth_token'

function getJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function setTokenCookie(token: string, expMs: number | null) {
  const expires = expMs ? new Date(expMs).toUTCString() : ''
  document.cookie = `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax${expires ? `; expires=${expires}` : ''}`
}

function removeTokenCookie() {
  document.cookie = `${TOKEN_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
  const exp = getJwtExp(token)
  if (exp) {
    localStorage.setItem(TOKEN_EXPIRE_KEY, String(exp))
  } else {
    localStorage.removeItem(TOKEN_EXPIRE_KEY)
  }
  setTokenCookie(token, exp)
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getTokenExpire(): number | null {
  const exp = localStorage.getItem(TOKEN_EXPIRE_KEY)
  return exp ? Number(exp) : null
}

export function removeToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXPIRE_KEY)
  removeTokenCookie()
}

export function isAuthenticated(): boolean {
  const token = getToken()
  const exp = getTokenExpire()
  if (!token || !exp) return false
  return Date.now() < exp
}

export function createAuthApi(client: HttpClient) {
  return {
    async login(data: LoginRequest): Promise<User> {
      const res = await client.post<LoginResponse>('/auth/login', data)
      setToken(res.access_token)
      return client.get('/users/me')
    },
    async setupAdminPassword(password: string): Promise<User> {
      const res = await client.post<LoginResponse>('/auth/admin-password/setup', { password })
      setToken(res.access_token)
      return client.get('/users/me')
    },
    logout() {
      removeToken()
    },
    getCurrentUser(): Promise<User> {
      return client.get('/users/me')
    },
    getCurrentUserWithoutAuthRedirect(): Promise<User> {
      return client.get('/users/me', { redirectOnUnauthorized: false })
    },
    async loginWithOidcToken(accessToken: string): Promise<void> {
      setToken(accessToken)
    },
  }
}
