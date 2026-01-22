// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ParsedSchemeURL, SchemeType } from './types'

/**
 * Parses a wegent:// URL into its components
 * @param url - The scheme URL to parse (e.g., 'wegent://open/chat?team=123')
 * @returns Parsed URL object or null if invalid
 */
export function parseSchemeURL(url: string): ParsedSchemeURL | null {
  try {
    // Validate scheme prefix
    if (!url.startsWith('wegent://')) {
      return null
    }

    // Remove scheme prefix
    const urlWithoutScheme = url.slice('wegent://'.length)

    // Split into path and query parts
    const [pathPart, queryPart] = urlWithoutScheme.split('?')

    // Parse path: type/path (e.g., 'open/chat' or 'action/send-message')
    const pathSegments = pathPart.split('/')
    if (pathSegments.length < 2) {
      return null
    }

    const [type, ...pathParts] = pathSegments
    const path = pathParts.join('/')

    // Validate type
    const validTypes: SchemeType[] = ['open', 'action', 'form', 'modal']
    if (!validTypes.includes(type as SchemeType)) {
      return null
    }

    // Parse query parameters
    const params: Record<string, string | string[]> = {}
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart)
      for (const [key, value] of searchParams.entries()) {
        // Handle multiple values for the same key
        if (params[key]) {
          if (Array.isArray(params[key])) {
            ;(params[key] as string[]).push(value)
          } else {
            params[key] = [params[key] as string, value]
          }
        } else {
          params[key] = value
        }
      }
    }

    return {
      scheme: 'wegent',
      type: type as SchemeType,
      path,
      params,
    }
  } catch (error) {
    console.error('[SchemeURL] Failed to parse URL:', url, error)
    return null
  }
}

/**
 * Validates if a URL matches the wegent scheme format
 */
export function isValidSchemeURL(url: string): boolean {
  return parseSchemeURL(url) !== null
}

/**
 * Builds a scheme URL from components
 */
export function buildSchemeURL(
  type: SchemeType,
  path: string,
  params?: Record<string, string | number>
): string {
  let url = `wegent://${type}/${path}`

  if (params && Object.keys(params).length > 0) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      query.append(key, String(value))
    }
    url += `?${query.toString()}`
  }

  return url
}
