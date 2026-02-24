// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js Middleware for API Security
 *
 * This middleware runs before rewrites and provides security checks:
 * - Blocks direct browser access to /api/* endpoints (returns 404)
 * - Allows whitelisted paths (OIDC callbacks, webhooks) from external sources
 *
 * Note: API proxying is handled by rewrites in next.config.js for better performance.
 * This middleware only handles security checks.
 */

import { NextRequest, NextResponse } from 'next/server'

/**
 * Paths that bypass same-origin check and allow external access.
 */
const ALLOWED_EXTERNAL_PATHS = [
  '/api/auth/oidc/callback',
  '/api/auth/oidc/cli-callback',
  '/api/auth/oauth/callback',
  '/api/flows/webhook/',
]

/**
 * Check if the request path is in the allowed external paths list
 */
function isAllowedExternalPath(pathname: string): boolean {
  return ALLOWED_EXTERNAL_PATHS.some(allowedPath => pathname.startsWith(allowedPath))
}

/**
 * Check if the request is a same-origin request from the frontend application.
 */
function isSameOriginRequest(request: NextRequest): boolean {
  // Check sec-fetch-site header (modern browsers)
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (secFetchSite === 'same-origin') {
    return true
  }

  // Check Referer header
  const referer = request.headers.get('referer')
  if (referer) {
    try {
      const refererUrl = new URL(referer)
      const requestHost = request.headers.get('host') || ''
      if (refererUrl.host === requestHost) {
        return true
      }
    } catch {
      // Invalid referer URL
    }
  }

  return false
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  // Only apply to /api/* routes
  if (pathname.startsWith('/api/')) {
    // Allow whitelisted external paths
    if (isAllowedExternalPath(pathname)) {
      return NextResponse.next()
    }

    // Block non-same-origin requests
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'Not Found' }, { status: 404 })
    }
  }

  return NextResponse.next()
}

// Configure which paths the middleware runs on
export const config = {
  matcher: '/api/:path*',
}
