// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// API Configuration and Client
const API_BASE_URL = '/api'

// Token management
import { getToken, removeToken } from './user'

// HTTP Client with interceptors
class APIClient {
  private baseURL: string

  constructor(baseURL: string) {
    this.baseURL = baseURL
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`
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
          window.location.href = '/login'
        }
        throw new Error('Authentication failed')
      }

      if (!response.ok) {
        let errorText = await response.text()
        let errorMsg = errorText
        try {
          // Try to parse as JSON and extract detail field
          const json = JSON.parse(errorText)
          if (json && typeof json.detail === 'string') {
            errorMsg = json.detail
          }
        } catch (e) {
          // Not JSON, use original text directly
        }
        throw new Error(errorMsg)
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

  async post<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' })
  }
}

export const apiClient = new APIClient(API_BASE_URL)