// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { defaultUrlTransform } from 'react-markdown'

/**
 * Creates a URL transform function that allows custom scheme protocols.
 *
 * react-markdown sanitizes URLs by default and will drop unknown protocols.
 * This utility creates a transform function that whitelists custom schemes
 * (like `wegent:`) while maintaining security by blocking dangerous protocols
 * like `javascript:` and `data:`.
 *
 * @param customProtocols Array of custom protocols to allow (e.g., ['wegent:'])
 * @returns URL transform function compatible with react-markdown
 *
 * @example
 * ```tsx
 * const urlTransform = createSchemeAwareUrlTransform(['wegent:'])
 *
 * <ReactMarkdown urlTransform={urlTransform}>
 *   {content}
 * </ReactMarkdown>
 * ```
 */
export function createSchemeAwareUrlTransform(
  customProtocols: string[] = []
): (url: string) => string {
  // Build allowlist of safe protocols
  const allowedProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:', ...customProtocols])

  return (url: string): string => {
    const trimmed = url.trim()

    // Relative URLs (including anchors) are safe to keep
    const protocolMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(trimmed)
    if (!protocolMatch) {
      return trimmed
    }

    // Check if protocol is in allowlist
    const protocol = protocolMatch[0].toLowerCase()
    if (allowedProtocols.has(protocol)) {
      return trimmed
    }

    // Fallback to react-markdown default for any other cases
    // If react-markdown deems it unsafe, it will be sanitized
    return defaultUrlTransform(trimmed)
  }
}
