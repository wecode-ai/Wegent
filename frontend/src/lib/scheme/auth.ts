// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SchemeHandlerContext } from './types'

/**
 * Auth middleware for scheme URL handlers
 * Checks if user is authenticated before allowing the action
 * @returns true if authenticated, false otherwise (silently fails)
 */
export function checkAuth(context: SchemeHandlerContext): boolean {
  // Check if user is authenticated
  // In Next.js, we'll check this via the user context
  if (!context.user) {
    console.warn(
      '[SchemeURL] Authentication required for:',
      context.parsed.type,
      context.parsed.path
    )
    return false
  }

  return true
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
