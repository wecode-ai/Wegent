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
 * - RUNTIME_API_URL: Fallback URL (also used by runtime-config for browser)
 * - NEXT_PUBLIC_API_URL: Build-time fallback
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
