// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfmSafe from '@/lib/remark-gfm-safe'
import type { KnowledgeSourceAccess } from '@/types/knowledge'

export type SourceAccessMap = Readonly<Partial<Record<number, KnowledgeSourceAccess>>>

export interface EvidenceVisibility {
  visitOnly?: boolean
  sourceAccess?: SourceAccessMap
  citations?: readonly { citation_id: string; knowledge_base_id: number }[]
}

export function isSourceHidden(access?: KnowledgeSourceAccess): boolean {
  return access === 'visit-only' || access === 'denied'
}

export function shouldHideAnswerMarker(
  citationId: string | undefined,
  visibility?: EvidenceVisibility
) {
  if (visibility?.visitOnly) return true
  if (!citationId) return false
  const citation = visibility?.citations?.find(item => item.citation_id === citationId)
  return (
    citation !== undefined && isSourceHidden(visibility?.sourceAccess?.[citation.knowledge_base_id])
  )
}

export const answerEvidenceMarker =
  /\[\[(?:citation:([0-9]+)|evidence:[^\]\n]+|evidence-unavailable)\]\]/g

export const temporaryEvidenceMarkerPrefix = '[[evidence:'

export function trimPartialEvidenceMarker(value: string): string {
  const suffix = /\[{1,2}[^\[\]\n]*\]?$/.exec(value)
  if (
    suffix &&
    (temporaryEvidenceMarkerPrefix.startsWith(suffix[0]) ||
      suffix[0].startsWith(temporaryEvidenceMarkerPrefix))
  ) {
    return value.slice(0, suffix.index)
  }
  return value
}

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
const voidHtmlTags = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' ')
)
const openingHtmlTag =
  /^<([a-z][a-z0-9-]*)(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?)*\s*(\/?)>$/i
const closingHtmlTag = /^<\/([a-z][a-z0-9-]*)\s*>$/i
const foreignHtmlRoots = new Set(['svg', 'math'])

// Raw HTML is parsed after remark. Text between raw tags must remain opaque.
export function mapEvidenceText(parent: MarkdownNode, map: (node: MarkdownNode) => MarkdownNode[]) {
  const rawTags: string[] = []
  const visit = (container: MarkdownNode) => {
    container.children = container.children?.flatMap(node => {
      if (node.type === 'html') {
        const value = node.value ?? ''
        const opening = openingHtmlTag.exec(value)
        const open = opening?.[1].toLowerCase()
        const close = closingHtmlTag.exec(value)?.[1].toLowerCase()
        // Outside SVG and MathML, the HTML parser ignores a trailing slash on non-void tags.
        if (open && !voidHtmlTags.has(open) && !(foreignHtmlRoots.has(open) && opening?.[2]))
          rawTags.push(open)
        if (close) {
          const index = rawTags.lastIndexOf(close)
          if (index >= 0) rawTags.length = index
        }
      } else if (!opaqueNodes.has(node.type)) {
        if (node.type === 'text' && rawTags.length === 0) return map(node)
        if (node.children) visit(node)
      }
      return [node]
    })
  }
  visit(parent)
}

const plainParser = unified().use(remarkParse).use(remarkGfmSafe)
const parser = plainParser().use(remarkMath)
export function getRenderedCitationIds(markdown: string, hasMath = true): Set<string> {
  const ids = new Set<string>()
  if (!markdown.includes('citation')) return ids
  mapEvidenceText((hasMath ? parser : plainParser).parse(markdown) as MarkdownNode, node => {
    for (const match of (node.value ?? '').matchAll(answerEvidenceMarker)) {
      if (match[1]) ids.add(match[1])
    }
    return [node]
  })
  return ids
}

const serializedMarker =
  /(\\*)\[\\?\[(?:citation\\?:([0-9]+)|evidence\\?:[^\]\n]+?|evidence-unavailable)\\?\]\\?\]/g

// Preserve the source spelling of code, links and HTML in non-interactive exports.
export function filterAnswerEvidenceMarkers(
  markdown: string,
  visibility?: EvidenceVisibility
): string {
  if (
    !visibility?.visitOnly &&
    !visibility?.citations?.some(citation =>
      isSourceHidden(visibility.sourceAccess?.[citation.knowledge_base_id])
    )
  )
    return markdown
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
      .replace(serializedMarker, (marker, slashes: string, citationId?: string) =>
        shouldHideAnswerMarker(citationId, visibility)
          ? slashes.slice(0, slashes.length - (slashes.length % 2))
          : marker
      )
    cursor = end
    return [node]
  })

  return output + markdown.slice(cursor)
}
