// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * User module: encapsulates login/logout/getCurrentUser/updateUser and token management.
 * All types and logic are self-contained for cohesion.
 */

import type { GitInfo, User } from '@/types/api'

// 类型定义
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
}


// Token 管理（内部使用，不对外暴露）
const TOKEN_KEY = 'auth_token'

function setToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(TOKEN_KEY, token)
  }
}

export function getToken(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem(TOKEN_KEY)
  }
  return null
}

export function removeToken() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY)
  }
}

function isAuthenticated(): boolean {
  return !!getToken()
}

// API Client
import { apiClient } from './client'
import { paths } from '@/config/paths'

export const userApis = {
  async login(data: LoginRequest): Promise<User> {
    const res: LoginResponse = await apiClient.post("/auth/login", data)
    setToken(res.access_token)
    // 登录后获取用户信息
    return await apiClient.get('/users/me')
  },

  logout() {
    removeToken()
    if (typeof window !== 'undefined') {
      window.location.href = paths.auth.login.getHref()
    }
  },

  async getCurrentUser(): Promise<User> {
    return apiClient.get('/users/me')
  },

  async updateUser(data: UpdateUserRequest): Promise<User> {
    return apiClient.put('/users/me', data)
  },

  isAuthenticated(): boolean {
    return isAuthenticated()
  }
}