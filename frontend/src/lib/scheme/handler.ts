// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { SchemeHandlerContext } from './types'
import { parseSchemeURL } from './parser'
import { findMatchingScheme } from './registry'
import { withAuth } from './auth'

/**
 * Main handler for processing scheme URLs
 * This is the entry point for all wegent:// URLs
 */
export async function handleSchemeURL(
  url: string,
  router: AppRouterInstance,
  user?: unknown
): Promise<void> {
  try {
    // Parse the URL
    const parsed = parseSchemeURL(url)
    if (!parsed) {
      console.warn('[SchemeURL] Invalid scheme URL:', url)
      return
    }

    // Find matching handler
    const registration = findMatchingScheme(parsed.type, parsed.path)
    if (!registration) {
      console.warn('[SchemeURL] No handler found for:', parsed.type, parsed.path)
      return
    }

    // Build context
    const context: SchemeHandlerContext = {
      url,
      parsed,
      params: parsed.params, // Add shortcut for easy access
      router,
      user,
    }

    // Apply auth middleware if required
    let handler = registration.handler
    if (registration.requireAuth) {
      handler = withAuth(handler)
    }

    // Execute handler
    await handler(context)
  } catch (error) {
    // Silently fail - log error but don't interrupt user experience
    console.error('[SchemeURL] Handler execution failed:', url, error)
  }
}

/**
 * Creates a link handler for scheme URLs
 * Use this in onClick handlers for links
 */
export function createSchemeLinkHandler(url: string, router: AppRouterInstance, user?: unknown) {
  return (e: React.MouseEvent) => {
    e.preventDefault()
    handleSchemeURL(url, router, user)
  }
}
