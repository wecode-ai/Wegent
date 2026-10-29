// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AllowElement, ExtraProps } from 'react-markdown'
import { isDocumentFileLink } from './documentLinkResource'

type Element = NonNullable<ExtraProps['node']>
type Parent = NonNullable<Parameters<AllowElement>[2]>
type Child = Element['children'][number]

const formattingTags = new Set(['strong', 'em', 'del', 'span'])
const inlineContainers = new Set(['table', 'pre', 'code', 'a', 'button'])

function isSpacing(node: Child): boolean {
  return (
    (node.type === 'text' && !node.value.trim()) ||
    (node.type === 'element' && node.tagName === 'br')
  )
}

function fileResource(node: Child): Element | undefined {
  if (node.type !== 'element') return undefined
  if (node.tagName === 'a' || node.tagName === 'img') {
    const url = node.properties[node.tagName === 'img' ? 'src' : 'href']
    return typeof url === 'string' && isDocumentFileLink(url) ? node : undefined
  }
  if (!formattingTags.has(node.tagName)) return undefined
  const children = node.children.filter(child => !isSpacing(child))
  return children.length === 1 ? fileResource(children[0]) : undefined
}

function occupiesOwnLine(node: Child, paragraph: Element, source: string): boolean {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return false
  const before = source.slice(paragraph.position?.start.offset ?? 0, start)
  const after = source.slice(end, paragraph.position?.end.offset ?? source.length)
  return !before.slice(before.lastIndexOf('\n') + 1).trim() && !after.split('\n', 1)[0].trim()
}

function splitResourceBlock(block: Element, source: string): Element[] {
  const isHeading = block.tagName !== 'p'
  const onlyChild = block.children.filter(child => !isSpacing(child)).length === 1
  const result: Element[] = []
  let pending: Child[] = []
  let changed = false
  const flush = () => {
    while (pending.length && isSpacing(pending[0])) pending.shift()
    while (pending.length && isSpacing(pending[pending.length - 1])) pending.pop()
    if (pending.length) result.push({ ...block, children: pending })
    pending = []
  }

  for (const child of block.children) {
    const resource = fileResource(child)
    const shouldPromote =
      resource &&
      (isHeading ? resource.tagName === 'img' : onlyChild || occupiesOwnLine(child, block, source))
    if (!shouldPromote) {
      pending.push(child)
      continue
    }
    flush()
    // The existing paragraph renderer turns this resource-only paragraph into a card.
    // Drop phrasing wrappers so a card never becomes a child of strong/em/span.
    result.push({
      type: 'element',
      tagName: 'p',
      properties: isHeading ? {} : block.properties,
      children: [resource],
      position: child.position,
    })
    changed = true
  }
  flush()
  return changed ? result : [block]
}

/**
 * Opt-in knowledge-document layout. Promote resource-only lines and images
 * appended to headings. Keep prose, heading links, and tables unchanged.
 */
export function rehypeDocumentResources() {
  return (tree: Parent, file: { toString(): string }) => {
    const source = file.toString()
    const visit = (parent: Parent) => {
      for (let index = parent.children.length - 1; index >= 0; index--) {
        const node = parent.children[index]
        if (node.type !== 'element' || inlineContainers.has(node.tagName)) continue
        if (node.tagName === 'p' || /^h[1-6]$/.test(node.tagName)) {
          parent.children.splice(index, 1, ...splitResourceBlock(node, source))
        } else {
          visit(node)
        }
      }
    }
    visit(tree)
  }
}
