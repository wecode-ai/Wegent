// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { paths } from '../config/paths'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants'
import { getApiBaseUrl, fetchRuntimeConfig } from '@/lib/runtime-config'

// Token management
import { getToken, removeToken } from './user'

// Custom error class for API errors with status code
export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// HTTP Client with interceptors
class APIClient {
  private baseURL: string
  private initialized: boolean = false

  constructor() {
    // Start with default, will be updated after runtime config is fetched
    this.baseURL = '/api'
  }

  /**
   * Initialize the client with runtime configuration
   * This should be called early in app initialization
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    try {
      await fetchRuntimeConfig()
      this.baseURL = getApiBaseUrl()
      this.initialized = true
    } catch (err) {
      console.warn('[APIClient] Failed to initialize with runtime config:', err)
      // Keep using default '/api'
    }
  }

  /**
   * Get the current base URL (updates from runtime config if available)
   */
  private getBaseURL(): string {
    // Always try to get the latest from runtime config
    return getApiBaseUrl()
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.getBaseURL()}${endpoint}`
    const token = getToken()

    const config: RequestInit = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
    }

    try {
      const response = await fetch(url, config)
      // Handle authentication errors
      if (response.status === 401) {
        removeToken()
        if (typeof window !== 'undefined') {
          const loginPath = paths.auth.login.getHref()
          if (window.location.pathname === loginPath) {
            window.location.href = loginPath
          } else {
            const disallowedTargets = [loginPath, '/login/oidc']
            const currentPathWithSearch = `${window.location.pathname}${window.location.search}`
            const redirectTarget = sanitizeRedirectPath(currentPathWithSearch, disallowedTargets)
            if (redirectTarget) {
              sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget)
              window.location.href = `${loginPath}?redirect=${encodeURIComponent(redirectTarget)}`
            } else {
              sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
              window.location.href = loginPath
            }
          }
        }
        throw new Error('Authentication failed')
      }

      if (!response.ok) {
        const errorText = await response.text()
        let errorMsg = errorText
        try {
          // Try to parse as JSON and extract detail field
          const json = JSON.parse(errorText)
          if (json && typeof json.detail === 'string') {
            errorMsg = json.detail
          }
        } catch {
          // Not JSON, use original text directly
        }
        // Throw ApiError with status code for better error handling
        throw new ApiError(errorMsg, response.status)
      }

      // Handle 204 No Content responses
      if (response.status === 204) {
        return null as T
      }

      const result = await response.json()
      return result
    } catch (error) {
      throw error
    }
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' })
  }
}

export const apiClient = new APIClient()

export default apiClient
