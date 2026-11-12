// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { collectMarkdownLiteralRanges } from '@wegent/collaboration/markdown/composerReferenceMarkdown'

const AUTH_MARKER = /\bconnector_auth_required\b/
const FIELD = '`?(?:connectorSlug|pluginKey)`?\\s*[=:]\\s*`?[A-Za-z0-9_.:-]+`?'
const TOKEN = `(?:\`?connector_auth_required\`?|\`?need_login\`?|${FIELD})`
const PROTOCOL_LINE = new RegExp(`^[ \\t]*(?:[-*+>]\\s*)*${TOKEN}(?:[ \\t]+${TOKEN})*[ \\t]*$`)
const INLINE_MARKER = new RegExp(
  `\\bconnector_auth_required\\b(?:[ \\t]+(?:${FIELD}|need_login))*`,
  'g'
)
const SLUG = /connectorSlug`?\s*[=:]\s*`?([A-Za-z0-9_.:-]+)`?/
const CODE_ATOM = /^`[A-Za-z0-9_.:=-]+`$/

interface MarkerLine {
  original: string
  visible: string
  protocol: boolean
}

/** Use the renderer's Markdown parser, including nested and incomplete code. */
function markerLines(text: string): MarkerLine[] {
  const literals = collectMarkdownLiteralRanges(text)
  let offset = 0
  let literalIndex = 0
  return text.split('\n').map(original => {
    const start = offset
    const end = start + original.length
    offset = end + 1
    while (literals[literalIndex]?.end <= start) literalIndex += 1
    let visible = original
    let wrappedAtoms = true
    for (let index = literalIndex; literals[index]?.start < end; index += 1) {
      const range = literals[index]
      const from = Math.max(range.start, start) - start
      const to = Math.min(range.end, end) - start
      visible = visible.slice(0, from) + ' '.repeat(to - from) + visible.slice(to)
      wrappedAtoms &&= CODE_ATOM.test(text.slice(range.start, range.end))
    }
    // Actual protocol output may wrap individual atoms in single backticks.
    // A complete code example or a fenced/indented block is never protocol.
    const protocol = wrappedAtoms && PROTOCOL_LINE.test(original)
    return { original, visible: protocol ? original : visible, protocol }
  })
}

/** Classify display removal and authorization links through the same context. */
function authorizationMarkers(text: string): { content: string; slug: string | null } {
  if (!AUTH_MARKER.test(text)) return { content: text, slug: null }
  const lines = markerLines(text)
  const removed = new Set<number>()
  const replacements = new Map<number, string>()
  let slug: string | null = null
  const captureSlug = (marker: string) => {
    slug ??= marker.match(SLUG)?.[1] ?? null
  }
  for (const [index, line] of lines.entries()) {
    if (!AUTH_MARKER.test(line.visible)) continue
    if (line.protocol) {
      removed.add(index)
      captureSlug(line.visible)
    } else {
      let cleaned = line.original
      const matches = [...line.visible.matchAll(INLINE_MARKER)]
      matches.forEach(match => captureSlug(match[0]))
      for (const match of matches.reverse()) {
        const start = match.index ?? 0
        const left = cleaned.slice(0, start).trimEnd()
        const right = cleaned.slice(start + match[0].length).trimStart()
        cleaned = left + (left && right ? ' ' : '') + right
      }
      replacements.set(index, cleaned)
    }
    // Only adjacent standalone protocol fields belong to a preceding marker.
    // Unrelated prose, code examples and other paragraphs remain byte-exact.
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = lines[next]
      if (!following.original.trim()) continue
      if (!following.protocol) break
      removed.add(next)
      captureSlug(following.visible)
    }
  }
  if (!removed.size && !replacements.size) return { content: text, slug: null }
  const kept = lines.flatMap((line, index) =>
    removed.has(index) ? [] : [replacements.get(index) ?? line.original]
  )
  if (removed.has(lines.length - 1)) {
    while (kept.at(-1)?.trim() === '') kept.pop()
  }
  return { content: kept.join('\n'), slug }
}

export function stripConnectorAuthMarkers(text: string): string {
  return authorizationMarkers(text).content
}

/** Return only a slug belonging to an actual authorization marker. */
export function connectorAuthSlug(text: string): string | null {
  return authorizationMarkers(text).slug
}
