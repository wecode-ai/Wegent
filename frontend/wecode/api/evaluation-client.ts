// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared API client utilities for the evaluation module.
 * Provides common fetchJson functionality and URL builders.
 */

import { getApiBaseUrl } from '@/lib/runtime-config'
import { getToken, removeToken } from '@/apis/user'
import { paths } from '@/config/paths'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants'

const BASE_API_PREFIX = '/wecode/evaluation'

/**
 * Build URL for evaluation API
 */
export function getEvaluationUrl(path: string): string {
  return `${getApiBaseUrl()}${BASE_API_PREFIX}${path}`
}

/**
 * Build URL for author API
 */
export function getAuthorUrl(path: string): string {
  return `${getApiBaseUrl()}${BASE_API_PREFIX}/author${path}`
}

/**
 * Build URL for respondent API
 */
export function getRespondentUrl(path: string): string {
  return `${getApiBaseUrl()}${BASE_API_PREFIX}/respondent${path}`
}

/**
 * Build URL for grader API
 */
export function getGraderUrl(path: string): string {
  return `${getApiBaseUrl()}${BASE_API_PREFIX}/grader${path}`
}

/**
 * Generic JSON fetch utility with authentication handling.
 */
export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getToken()

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options?.headers,
    },
  })

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
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    // Handle nested detail object (e.g., for 409 conflict with version info)
    if (error.detail && typeof error.detail === 'object') {
      throw new Error(JSON.stringify(error.detail))
    }
    throw new Error(error.detail || error.message || 'Request failed')
  }

  return response.json()
}

/**
 * Delete request utility (returns void)
 */
export async function fetchDelete(url: string): Promise<void> {
  const token = getToken()
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (response.status === 401) {
    removeToken()
    throw new Error('Authentication failed')
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    // Handle nested detail object
    if (error.detail && typeof error.detail === 'object') {
      throw new Error(JSON.stringify(error.detail))
    }
    throw new Error(error.detail || error.message || 'Request failed')
  }
}
