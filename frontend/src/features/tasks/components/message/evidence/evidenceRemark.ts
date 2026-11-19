// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { prepareMarkdown } from '@/components/common/EnhancedMarkdown'
import {
  answerEvidenceMarker,
  getRenderedCitationIds,
  mapEvidenceText,
  temporaryEvidenceMarkerPrefix,
  trimPartialEvidenceMarker,
  type MarkdownNode,
} from '../../../utils/answerEvidenceMarkers'

export function getDisplayedCitationIds(markdown: string | readonly string[]) {
  const ids = new Set<string>()
  for (const text of typeof markdown === 'string' ? [markdown] : markdown) {
    if (!text.includes('citation')) continue
    const { contentParts, hasMath } = prepareMarkdown(text)
    for (const part of contentParts) {
      if (part.type !== 'markdown') continue
      for (const id of getRenderedCitationIds(part.content, hasMath)) ids.add(id)
    }
  }
  return ids
}

// Work on Markdown text nodes before raw HTML is parsed. Code and links are opaque.
export function evidenceRemark(token: string, streaming?: boolean) {
  return (tree: unknown) => {
    const root = tree as MarkdownNode
    mapEvidenceText(root, node => {
      const value = node.value ?? ''
      const parts: MarkdownNode[] = []
      let start = 0
      for (const match of value.matchAll(answerEvidenceMarker)) {
        parts.push({ type: 'text', value: value.slice(start, match.index) })
        if (!streaming || !match[0].startsWith(temporaryEvidenceMarkerPrefix)) {
          parts.push({
            type: 'text',
            value: '',
            data: {
              hName: 'answer-citation',
              hProperties: { citationId: match[1] || '', evidenceToken: token },
            },
          })
        }
        start = match.index + match[0].length
      }
      const tail = value.slice(start)
      const end = node.position?.end.offset
      const visibleTail =
        streaming && end !== undefined && end === root.position?.end.offset
          ? trimPartialEvidenceMarker(tail)
          : tail
      if (!start && visibleTail === value) return [node]
      parts.push({ type: 'text', value: visibleTail })
      return parts
    })
  }
}
