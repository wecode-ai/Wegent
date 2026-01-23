// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { userApis } from '@/apis/user'
import type { SchemeHandlerContext } from './types'

/**
 * Auth middleware for scheme URL handlers
 * Checks if user is authenticated before allowing the action
 * @returns true if authenticated, false otherwise (silently fails)
 */
export function checkAuth(context: SchemeHandlerContext): boolean {
  // Prefer explicit user context when available.
  if (context.user) {
    return true
  }

  // Fallback: if UserProvider is not mounted on this page, still allow auth-required
  // scheme URLs when a valid token exists.
  if (typeof window !== 'undefined' && userApis.isAuthenticated()) {
    return true
  }

  console.warn('[SchemeURL] Authentication required for:', context.parsed.type, context.parsed.path)
  return false
}

/**
 * Wraps a handler with auth middleware
 */
export function withAuth(
  handler: (context: SchemeHandlerContext) => Promise<void> | void
): (context: SchemeHandlerContext) => Promise<void> | void {
  return (context: SchemeHandlerContext) => {
    if (!checkAuth(context)) {
      // Silently fail - don't interrupt user experience
      return
    }
    return handler(context)
  }
}
