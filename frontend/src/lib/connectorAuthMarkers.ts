// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector skills end a turn with `connector_auth_required` and the app slug
 * so desktop clients can open an authorization card. Those markers are an
 * internal protocol and must never be shown as part of the reply text.
 */
const AUTH_MARKER = /connector_auth_required/
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

function isFence(line: string): boolean {
  return /^\s{0,3}(```|~~~)/.test(line)
}

/** Split a line into inline-code and ordinary Markdown segments. */
function splitInlineCode(line: string): Array<{ text: string; code: boolean }> {
  const segments: Array<{ text: string; code: boolean }> = []
  let cursor = 0
  for (const match of line.matchAll(/`+[^`]*`+/g)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ text: line.slice(cursor, start), code: false })
    segments.push({ text: match[0], code: true })
    cursor = start + match[0].length
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor), code: false })
  return segments
}

function stripMarkerLine(line: string): string {
  const segments = splitInlineCode(line)
  const withoutCode = line.replace(/`/g, '').trim()
  const protocolOnly = withoutCode.replace(/^(?:[-*+>]\s*)+/, '')
  if (
    /^(?:connector_auth_required|need_login)(?:\s+(?:connectorSlug|pluginKey)\s*[=:]\s*[A-Za-z0-9_.:-]+)*$/.test(
      protocolOnly
    )
  ) {
    return ''
  }
  const slugOnly = withoutCode.replace(/^(?:[-*+>]\s*)+/, '')
  if (/^(?:connectorSlug|pluginKey)\s*[=:]\s*[A-Za-z0-9_.:-]+$/.test(slugOnly)) return ''
  const fullyClean = segments
    .map(segment => segment.text.replace(MARKER_TOKENS, ''))
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd()
  // A standalone marker may be wrapped in code spans for display; the whole
  // line is protocol noise. Inline code inside prose stays untouched.
  if (LEFTOVER_ONLY.test(fullyClean)) return fullyClean
  return segments
    .map(segment =>
      segment.code && !/^`+(?:connector_auth_required|need_login)$/.test(segment.text)
        ? segment.text
        : segment.text.replace(MARKER_TOKENS, '')
    )
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd()
}

export function stripConnectorAuthMarkers(text: string): string {
  if (!text || !AUTH_MARKER.test(text)) return text

  const kept: string[] = []
  let inFence = false
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (isFence(line)) {
      inFence = !inFence
      kept.push(line)
      continue
    }
    if (inFence || !MARKER_HINT.test(line)) {
      kept.push(line)
      continue
    }
    const cleaned = stripMarkerLine(line)
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
  if (!text || !AUTH_MARKER.test(text)) return null
  const match = text.match(/connectorSlug`?\s*[=:]\s*`?([A-Za-z0-9_.:-]+)`?/)
  return match?.[1] ?? null
}
