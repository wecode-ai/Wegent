// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side Configuration
 *
 * This module provides configuration values for server-side code (API routes, rewrites, etc.)
 * These values are NOT exposed to the browser.
 *
 * Environment Variables:
 * - RUNTIME_INTERNAL_API_URL: Primary URL for server-side proxy to backend
 * - RUNTIME_API_PROXY_INTERNAL_ONLY: Set to 'true' to only allow frontend page requests
 */

/**
 * Get the internal backend URL for server-side proxy.
 * This URL is used by Next.js API routes and rewrites to communicate with the backend.
 *
 * Priority: RUNTIME_INTERNAL_API_URL > NEXT_PUBLIC_API_URL > default
 *
 * @returns The backend URL for server-side use
 */
export function getInternalApiUrl(): string {
  return (
    process.env.RUNTIME_INTERNAL_API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:8000'
  )
}

/**
 * Check if API proxy is in internal-only mode.
 * When enabled, the /api/* proxy only allows requests from the frontend application
 * (same-origin requests with proper headers), blocking direct browser access.
 *
 * This is useful when you want to:
 * - Hide the backend API from direct external access
 * - But still allow frontend pages to use the proxy to reach internal backend
 *
 * Set RUNTIME_API_PROXY_INTERNAL_ONLY=true to enable this mode.
 *
 * @returns true if proxy is internal-only, false otherwise
 */
export function isApiProxyInternalOnly(): boolean {
  return process.env.RUNTIME_API_PROXY_INTERNAL_ONLY === 'true'
}
