// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector skills end a turn with `connector_auth_required` and the app slug
 * so desktop clients can open an authorization card. Those markers are an
 * internal protocol and must never be shown as part of the reply text.
 */
const MARKER_HINT = /connector_auth_required|need_login|connectorSlug`?\s*[=:]|pluginKey`?\s*[=:]/
const MARKER_TOKENS = new RegExp(
  [
    '`?connector_auth_required`?',
    '`?need_login`?',
    '`?connectorSlug`?\\s*[=:]\\s*`?[A-Za-z0-9_.:-]+`?',
    '`?pluginKey`?\\s*[=:]\\s*`?[A-Za-z0-9_.:-]+`?',
  ].join('|'),
  'g'
)
const LEFTOVER_ONLY = /^[\s>*\-–—:：`]*$/

export function stripConnectorAuthMarkers(text: string): string {
  if (!text || !MARKER_HINT.test(text)) return text

  const kept: string[] = []
  for (const line of text.split('\n')) {
    if (!MARKER_HINT.test(line)) {
      kept.push(line)
      continue
    }
    const cleaned = line
      .replace(MARKER_TOKENS, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trimEnd()
    if (!LEFTOVER_ONLY.test(cleaned)) {
      kept.push(cleaned)
    }
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Return the connector slug carried by an authorization marker, if any. */
export function connectorAuthSlug(text: string): string | null {
  if (!text || !MARKER_HINT.test(text)) return null
  const match = text.match(/connectorSlug`?\s*[=:]\s*`?([A-Za-z0-9_.:-]+)`?/)
  return match?.[1] ?? null
}
