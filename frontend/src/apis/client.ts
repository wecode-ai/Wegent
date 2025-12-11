// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { paths } from '../config/paths';
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants';

// API Configuration and Client
const API_BASE_URL = '/api';

// Token management
import { getToken, removeToken } from './user';

// HTTP Client with interceptors
class APIClient {
  private baseURL: string;

  constructor(baseURL: string) {
    this.baseURL = baseURL;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    const token = getToken();

    const config: RequestInit = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);
      // Handle authentication errors
      if (response.status === 401) {
        removeToken();
        if (typeof window !== 'undefined') {
          const loginPath = paths.auth.login.getHref();
          if (window.location.pathname === loginPath) {
            window.location.href = loginPath;
          } else {
            const disallowedTargets = [loginPath, '/login/oidc'];
            const currentPathWithSearch = `${window.location.pathname}${window.location.search}`;
            const redirectTarget = sanitizeRedirectPath(currentPathWithSearch, disallowedTargets);
            if (redirectTarget) {
              sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget);
              window.location.href = `${loginPath}?redirect=${encodeURIComponent(redirectTarget)}`;
            } else {
              sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
              window.location.href = loginPath;
            }
          }
        }
        throw new Error('Authentication failed');
      }

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = errorText;
        try {
          // Try to parse as JSON and extract detail field
          const json = JSON.parse(errorText);
          if (json && typeof json.detail === 'string') {
            errorMsg = json.detail;
          }
        } catch {
          // Not JSON, use original text directly
        }
        throw new Error(errorMsg);
      }

      // Handle 204 No Content responses
      if (response.status === 204) {
        return null as T;
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw error;
    }
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  async post<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async put<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }
}

export const apiClient = new APIClient(API_BASE_URL);
