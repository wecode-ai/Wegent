// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication API
 */

import { apiRequest } from './client'
import { setStorageValue, removeStorageValue, getStorageValue } from '../storage'
import type { LoginRequest, LoginResponse, User } from './types'

/**
 * Login with username and password
 */
export async function login(credentials: LoginRequest): Promise<LoginResponse> {
  const response = await apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  })

  // Store the token
  await setStorageValue('token', response.access_token)

  // Fetch and store user info
  await fetchAndStoreUser()

  return response
}

/**
 * Logout and clear stored credentials
 */
export async function logout(): Promise<void> {
  await removeStorageValue('token')
  await removeStorageValue('user')
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await getStorageValue('token')
  if (!token) return false

  try {
    // Verify token by fetching user info
    await fetchCurrentUser()
    return true
  } catch {
    // Token is invalid or expired
    await logout()
    return false
  }
}

/**
 * Fetch current user info
 */
export async function fetchCurrentUser(): Promise<User> {
  return apiRequest<User>('/users/me')
}

/**
 * Fetch and store user info
 */
async function fetchAndStoreUser(): Promise<void> {
  try {
    const user = await fetchCurrentUser()
    await setStorageValue('user', {
      id: user.id,
      user_name: user.user_name,
      avatar: user.avatar,
    })
  } catch {
    // Failed to fetch user info, but don't throw
    console.error('Failed to fetch user info')
  }
}

/**
 * Get stored user info
 */
export async function getStoredUser(): Promise<User | undefined> {
  return getStorageValue('user')
}
