// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API Client for browser extension
 * Handles all HTTP requests to the Wegent backend
 */

import { getStorageValue } from '../storage'
import type { ApiError } from './types'

const DEFAULT_SERVER_URL = 'http://localhost:8000'
const DEFAULT_FRONTEND_URL = 'http://localhost:3000'

export class ExtensionApiError extends Error {
  status: number
  errorCode?: string

  constructor(message: string, status: number, errorCode?: string) {
    super(message)
    this.name = 'ExtensionApiError'
    this.status = status
    this.errorCode = errorCode
  }
}

/**
 * Get the configured server URL (backend API)
 */
export async function getServerUrl(): Promise<string> {
  const url = await getStorageValue('serverUrl')
  return url || DEFAULT_SERVER_URL
}

/**
 * Get the configured frontend URL (web UI)
 */
export async function getFrontendUrl(): Promise<string> {
  const url = await getStorageValue('frontendUrl')
  return url || DEFAULT_FRONTEND_URL
}

/**
 * Get the stored authentication token
 */
export async function getToken(): Promise<string | undefined> {
  return getStorageValue('token')
}

/**
 * Make an authenticated API request
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const serverUrl = await getServerUrl()
  const token = await getToken()

  const url = `${serverUrl}/api${endpoint}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const config: RequestInit = {
    ...options,
    headers,
  }

  try {
    const response = await fetch(url, config)

    if (!response.ok) {
      let errorMessage = `Request failed with status ${response.status}`
      let errorCode: string | undefined

      try {
        const errorData: ApiError = await response.json()
        if (typeof errorData.detail === 'string') {
          errorMessage = errorData.detail
        } else if (errorData.detail && typeof errorData.detail === 'object') {
          errorMessage = errorData.detail.message
          errorCode = errorData.detail.error_code
        }
      } catch {
        // Failed to parse error response, use default message
      }

      throw new ExtensionApiError(errorMessage, response.status, errorCode)
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return null as T
    }

    return response.json()
  } catch (error) {
    if (error instanceof ExtensionApiError) {
      throw error
    }
    throw new ExtensionApiError(
      error instanceof Error ? error.message : 'Network error',
      0,
    )
  }
}

/**
 * Upload a file to the server
 */
export async function uploadFile(
  endpoint: string,
  file: File | Blob,
  filename: string,
): Promise<Response> {
  const serverUrl = await getServerUrl()
  const token = await getToken()

  const url = `${serverUrl}/api${endpoint}`

  const formData = new FormData()
  formData.append('file', file, filename)

  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  })

  if (!response.ok) {
    let errorMessage = `Upload failed with status ${response.status}`
    try {
      const errorData: ApiError = await response.json()
      if (typeof errorData.detail === 'string') {
        errorMessage = errorData.detail
      } else if (errorData.detail && typeof errorData.detail === 'object') {
        errorMessage = errorData.detail.message
      }
    } catch {
      // Failed to parse error response
    }
    throw new ExtensionApiError(errorMessage, response.status)
  }

  return response
}
