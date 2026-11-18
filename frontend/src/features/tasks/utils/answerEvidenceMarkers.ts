// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfmSafe from '@/lib/remark-gfm-safe'

export const answerEvidenceMarker =
  /\[\[(?:citation:([0-9]+)|evidence:[^\]\n]+|evidence-unavailable)\]\]/g

export interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: { hName: string; hProperties: Record<string, string> }
}

const opaqueNodes = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
])

// Raw HTML is parsed after remark. Text between raw tags must remain opaque.
export function mapEvidenceText(parent: MarkdownNode, map: (node: MarkdownNode) => MarkdownNode[]) {
  let htmlDepth = 0
  parent.children = parent.children?.flatMap(node => {
    if (node.type === 'html') {
      const value = node.value ?? ''
      if (/^<\//.test(value)) htmlDepth = Math.max(0, htmlDepth - 1)
      else if (
        /^<[a-z][^>]*>$/i.test(value) &&
        !/^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i.test(
          value
        ) &&
        !/\/>$/.test(value)
      )
        htmlDepth++
    } else if (!htmlDepth && !opaqueNodes.has(node.type)) {
      if (node.type === 'text') return map(node)
      if (node.children) mapEvidenceText(node, map)
    }
    return [node]
  })
}

const parser = unified().use(remarkParse).use(remarkGfmSafe).use(remarkMath)
export function getRenderedCitationIds(markdown: string): Set<string> {
  const ids = new Set<string>()
  if (!markdown.includes('citation')) return ids
  mapEvidenceText(parser.parse(markdown) as MarkdownNode, node => {
    for (const match of (node.value ?? '').matchAll(answerEvidenceMarker)) {
      if (match[1]) ids.add(match[1])
    }
    return [node]
  })
  return ids
}

const serializedMarker =
  /(\\*)\[\\?\[(?:citation\\?:[0-9]+|evidence\\?:[^\]\n]+?|evidence-unavailable)\\?\]\\?\]/g

// Preserve the source spelling of code, links and HTML in non-interactive exports.
export function stripAnswerEvidenceMarkers(markdown: string): string {
  if (!markdown.includes('citation') && !markdown.includes('evidence')) return markdown
  const tree = parser.parse(markdown) as MarkdownNode
  let output = ''
  let cursor = 0

  mapEvidenceText(tree, node => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined || !node.value?.match(answerEvidenceMarker)) {
      return [node]
    }

    output += markdown.slice(cursor, start)
    output += markdown
      .slice(start, end)
      .replace(serializedMarker, (_, slashes: string) =>
        slashes.slice(0, slashes.length - (slashes.length % 2))
      )
    cursor = end
    return [node]
  })

  return output + markdown.slice(cursor)
}
