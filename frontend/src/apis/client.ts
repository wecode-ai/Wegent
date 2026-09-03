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
  errorCode?: string | number
  detail?: unknown

  constructor(message: string, status: number, errorCode?: string | number, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errorCode = errorCode
    this.detail = detail
  }
}

interface RequestOptions {
  redirectOnUnauthorized?: boolean
  signal?: AbortSignal
  cache?: RequestCache
  headers?: HeadersInit
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

  private createApiError(errorText: string, status: number): ApiError {
    let errorMsg = errorText
    let errorCode: string | number | undefined
    let detail: unknown
    try {
      // Try to parse as JSON and extract detail field
      const json = JSON.parse(errorText)
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail
      } else if (json && typeof json.detail === 'object' && json.detail !== null) {
        detail = json.detail
        errorMsg = json.detail.message || json.detail.error_code || JSON.stringify(json.detail)
      }
      if (json && (typeof json.error_code === 'string' || typeof json.error_code === 'number')) {
        errorCode = json.error_code
      } else if (
        json?.detail &&
        (typeof json.detail.error_code === 'string' || typeof json.detail.error_code === 'number')
      ) {
        errorCode = json.detail.error_code
      } else if (
        json?.detail &&
        (typeof json.detail.code === 'string' || typeof json.detail.code === 'number')
      ) {
        errorCode = json.detail.code
      }
    } catch {
      // Not JSON, use original text directly
    }
    return new ApiError(errorMsg, status, errorCode, detail)
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    requestOptions: RequestOptions = {}
  ): Promise<T> {
    const url = `${this.getBaseURL()}${endpoint}`
    const token = getToken()
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData

    const config: RequestInit = {
      ...options,
      signal: requestOptions.signal,
      cache: requestOptions.cache,
      headers: {
        ...(!isFormData && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
    }

    try {
      const response = await fetch(url, config)
      // Handle authentication errors
      if (response.status === 401) {
        if (requestOptions.redirectOnUnauthorized === false) {
          const errorText = await response.text()
          throw this.createApiError(errorText || 'Authentication failed', response.status)
        }
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
        throw this.createApiError(errorText, response.status)
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

  async get<T>(endpoint: string, requestOptions?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' }, requestOptions)
  }

  async post<T>(endpoint: string, data?: unknown, requestOptions?: RequestOptions): Promise<T> {
    return this.request<T>(
      endpoint,
      {
        method: 'POST',
        headers: requestOptions?.headers,
        body: data ? JSON.stringify(data) : undefined,
      },
      requestOptions
    )
  }

  async postForm<T>(endpoint: string, data: FormData): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data,
    })
  }

  async put<T>(endpoint: string, data?: unknown, requestOptions?: RequestOptions): Promise<T> {
    return this.request<T>(
      endpoint,
      {
        method: 'PUT',
        headers: requestOptions?.headers,
        body: data ? JSON.stringify(data) : undefined,
      },
      requestOptions
    )
  }

  async patch<T>(endpoint: string, data?: unknown, requestOptions?: RequestOptions): Promise<T> {
    return this.request<T>(
      endpoint,
      {
        method: 'PATCH',
        headers: requestOptions?.headers,
        body: data ? JSON.stringify(data) : undefined,
      },
      requestOptions
    )
  }

  async delete<T>(endpoint: string, data?: unknown, requestOptions?: RequestOptions): Promise<T> {
    return this.request<T>(
      endpoint,
      {
        method: 'DELETE',
        headers: requestOptions?.headers,
        body: data ? JSON.stringify(data) : undefined,
      },
      requestOptions
    )
  }
}

export const apiClient = new APIClient()

export default apiClient
