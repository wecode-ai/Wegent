// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const POST_LOGIN_REDIRECT_KEY = 'postLoginRedirectPath'

/**
 * Sanitizes redirect paths to prevent open redirect vulnerabilities
 *
 * Security considerations:
 * - Only allows relative paths starting with single forward slash
 * - Blocks all absolute URLs and protocol-relative URLs
 * - Prevents bypass via backslash, URL encoding, and whitespace
 * - Validates against known malicious patterns
 * - Properly handles query parameters and fragments
 *
 * @param candidate - The redirect path to validate
 * @param disallow - Array of specific paths to disallow
 * @returns Sanitized path or null if invalid
 */
export const sanitizeRedirectPath = (
  candidate: string | null | undefined,
  disallow: string[] = []
): string | null => {
  if (!candidate) return null

  // Decode any URL encoding to catch obfuscated attacks
  let decoded: string
  try {
    decoded = decodeURIComponent(candidate)
  } catch {
    // Invalid encoding
    return null
  }

  // Normalize: trim whitespace, remove tabs/newlines/carriage returns
  const normalized = decoded.trim().replace(/[\t\n\r]/g, '')

  if (!normalized) return null

  // Must start with exactly one forward slash
  if (!normalized.startsWith('/')) return null

  // Block protocol-relative URLs (//example.com)
  if (normalized.startsWith('//')) return null

  // Block backslash bypasses (\example.com or \/example.com)
  if (normalized.includes('\\')) return null

  // Block dangerous protocols (javascript:, data:, vbscript:, file:, etc.)
  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:', 'about:']
  const lowerNormalized = normalized.toLowerCase()
  if (dangerousProtocols.some(protocol => lowerNormalized.includes(protocol))) {
    return null
  }

  // Split off query parameters and fragments for separate validation
  const [pathPart] = normalized.split(/[?#]/)

  // Validate the path part doesn't try to be absolute
  try {
    // If it can be parsed as an absolute URL, it's suspicious
    const url = new URL(pathPart, 'http://localhost')

    // Ensure it's truly a relative path on the same origin
    if (url.hostname !== 'localhost') return null
    if (url.protocol !== 'http:') return null
  } catch {
    // URL parsing failed, which is fine for relative paths
    // Continue with validation
  }

  // Check against disallowed paths (use the full normalized path for this check)
  if (disallow.includes(normalized)) return null

  // Additional security: ensure path doesn't try to escape via /../
  // Normalize the path part to prevent directory traversal
  const pathParts = pathPart.split('/').filter(Boolean)
  const resolvedParts: string[] = []

  for (const part of pathParts) {
    if (part === '..') {
      // Remove last part if exists (go up one directory)
      resolvedParts.pop()
    } else if (part !== '.') {
      // Add part (ignore '.' which means current directory)
      resolvedParts.push(part)
    }
  }

  const cleanPath = '/' + resolvedParts.join('/')

  // Reconstruct the full path with query parameters and fragments
  // We preserve these as they're needed for application routing (e.g., taskShare parameter)
  // Security is already handled by earlier validation checks
  const queryStart = normalized.indexOf('?')
  const fragmentStart = normalized.indexOf('#')

  let fullPath = cleanPath

  if (queryStart !== -1) {
    if (fragmentStart !== -1 && fragmentStart > queryStart) {
      // Both query and fragment present
      fullPath =
        cleanPath +
        normalized.substring(queryStart, fragmentStart) +
        normalized.substring(fragmentStart)
    } else {
      // Only query present
      fullPath = cleanPath + normalized.substring(queryStart)
    }
  } else if (fragmentStart !== -1) {
    // Only fragment present
    fullPath = cleanPath + normalized.substring(fragmentStart)
  }

  return fullPath
}
