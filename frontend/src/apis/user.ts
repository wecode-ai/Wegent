// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * User module: encapsulates login/logout/getCurrentUser/updateUser and token management.
 * All types and logic are self-contained for cohesion.
 */

import type {
  GitInfo,
  User,
  UserPreferences,
  QuickAccessResponse,
  WelcomeConfigResponse,
} from '@/types/api'

// Type definitions
export interface LoginRequest {
  user_name: string
  password: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
}

export interface UpdateUserRequest {
  user_name?: string
  email?: string
  is_active?: boolean
  git_info?: GitInfo[]
  preferences?: UserPreferences
}

export interface SearchUsersResponse {
  users: Array<{
    id: number
    user_name: string
    email?: string
  }>
  total: number
}

const TOKEN_KEY = 'auth_token'
const TOKEN_EXPIRE_KEY = 'auth_token_expire'
const TOKEN_COOKIE_NAME = 'auth_token'

function getJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null // convert to milliseconds
  } catch {
    return null
  }
}

/**
 * Set cookie for Nginx routing (user-based load balancing)
 * Cookie is readable by Nginx to extract user_id from JWT for routing
 */
function setTokenCookie(token: string, expMs: number | null) {
  if (typeof document !== 'undefined') {
    const expires = expMs ? new Date(expMs).toUTCString() : ''
    const cookieValue = `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax${expires ? `; expires=${expires}` : ''}`
    document.cookie = cookieValue
  }
}

/**
 * Remove token cookie
 */
function removeTokenCookie() {
  if (typeof document !== 'undefined') {
    document.cookie = `${TOKEN_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`
  }
}

export function setToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(TOKEN_KEY, token)
    const exp = getJwtExp(token)
    if (exp) {
      localStorage.setItem(TOKEN_EXPIRE_KEY, String(exp))
    } else {
      localStorage.removeItem(TOKEN_EXPIRE_KEY)
    }
    // Also set cookie for Nginx routing
    setTokenCookie(token, exp)
  }
}

export function getToken(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem(TOKEN_KEY)
  }
  return null
}

export function getTokenExpire(): number | null {
  if (typeof window !== 'undefined') {
    const exp = localStorage.getItem(TOKEN_EXPIRE_KEY)
    return exp ? Number(exp) : null
  }
  return null
}

export function removeToken() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(TOKEN_EXPIRE_KEY)
    // Also remove cookie for Nginx routing
    removeTokenCookie()
  }
}

/**
 * Check if token exists and is not expired
 */
function isAuthenticated(): boolean {
  const token = getToken()
  const exp = getTokenExpire()
  if (!token || !exp) return false
  return Date.now() < exp
}

// API Client
import { apiClient } from './client'
import { paths } from '@/config/paths'

export const userApis = {
  async login(data: LoginRequest): Promise<User> {
    const res: LoginResponse = await apiClient.post('/auth/login', data)
    setToken(res.access_token)
    // Get user information after login
    return await apiClient.get('/users/me')
  },

  logout() {
    removeToken()
    if (typeof window !== 'undefined') {
      window.location.href = paths.home.getHref()
    }
  },

  async getCurrentUser(): Promise<User> {
    return apiClient.get('/users/me')
  },

  async updateUser(data: UpdateUserRequest): Promise<User> {
    return apiClient.put('/users/me', data)
  },

  async deleteGitToken(gitDomain: string, gitInfoId?: string): Promise<User> {
    const params = gitInfoId ? `?git_info_id=${encodeURIComponent(gitInfoId)}` : ''
    return apiClient.delete(`/users/me/git-token/${encodeURIComponent(gitDomain)}${params}`)
  },

  async getQuickAccess(): Promise<QuickAccessResponse> {
    return apiClient.get('/users/quick-access')
  },

  async getWelcomeConfig(): Promise<WelcomeConfigResponse> {
    return apiClient.get('/users/welcome-config')
  },

  async searchUsers(query: string): Promise<SearchUsersResponse> {
    return apiClient.get(`/users/search?q=${encodeURIComponent(query)}`)
  },

  isAuthenticated(): boolean {
    return isAuthenticated()
  },
}

export async function loginWithOidcToken(accessToken: string): Promise<void> {
  setToken(accessToken)
}
