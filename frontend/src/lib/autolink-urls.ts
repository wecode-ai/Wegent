import type { Element, Root, RootContent, Text } from 'hast'
import { decodeString } from 'micromark-util-decode-string'

// GFM autolink literals are disabled for iOS 16.
const URL_REGEX =
  /(?:https?:\/\/|www\.)[^\s<>\[\]()\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]*[^\s<>\[\]()\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF.,;:!?'")\]}>]/gi
const URL_PREFIX_REGEX = new RegExp(`^${URL_REGEX.source}`, 'i')
const TRAILING_REFERENCE = /&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});$/i

const NON_LINKABLE_ELEMENTS = new Set([
  'a',
  'button',
  'code',
  'math',
  'pre',
  'script',
  'style',
  'svg',
  'textarea',
  'title',
])

type SourcePart<Child> = { node: Child; start: number; end: number }

function decodeText(value: string): string {
  return decodeString(value.replace(/\r\n?/g, '\n'))
}

function sourcePart<Child extends RootContent>(
  node: Child,
  source: string
): SourcePart<Child> | undefined {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined || start >= end) return
  if (node.type === 'text' && decodeText(source.slice(start, end)) === node.value) {
    return { node, start, end }
  }
  if (
    node.type === 'element' &&
    (node.tagName === 'em' || node.tagName === 'strong') &&
    (source[start] === '*' || source[start] === '_')
  ) {
    return { node, start, end }
  }
}

function createLink(url: string): Element {
  return {
    type: 'element',
    tagName: 'a',
    properties: { href: /^www\./i.test(url) ? `https://${url}` : url },
    children: [{ type: 'text', value: url }],
  }
}

function includeReferenceTerminator(value: string, start: number, end: number): number {
  if (value[end] !== ';') return end
  const reference = TRAILING_REFERENCE.exec(value.slice(Math.max(start, end - 32), end + 1))?.[0]
  return reference && decodeString(reference) !== reference ? end + 1 : end
}

function linkRun<Child extends RootContent>(
  parts: SourcePart<Child>[],
  source: string,
  visit: (node: Child) => Child
): Array<Child | Element | Text> {
  const first = parts[0]
  const limit = parts[parts.length - 1].end
  const value = source.slice(first.start, limit)
  const matcher = new RegExp(URL_REGEX)
  const output: Array<Child | Element | Text> = []
  let cursor = first.start
  let partIndex = 0

  const advance = (end: number, keepText: boolean) => {
    while (cursor < end) {
      const part = parts[partIndex]
      const next = Math.min(end, part.end)
      if (keepText) {
        if (cursor === part.start && next === part.end) {
          output.push(visit(part.node))
        } else {
          output.push({ type: 'text', value: decodeText(source.slice(cursor, next)) })
        }
      }
      cursor = next
      if (cursor === part.end) partIndex++
    }
  }

  let positionOffset = first.start
  let line = first.node.position?.start.line ?? 1
  let column = first.node.position?.start.column ?? 1
  let startIndex = 0
  for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
    const start = first.start + match.index
    matcher.lastIndex = includeReferenceTerminator(value, match.index, matcher.lastIndex)
    let end = first.start + matcher.lastIndex

    // A URL starts in text. It may consume paired delimiters inside its own path
    // when it covers the whole emphasis node, but never borrow an outer delimiter.
    while (parts[startIndex].end <= start) startIndex++
    const startPart = parts[startIndex]
    if (startPart.node.type !== 'text') {
      matcher.lastIndex = startPart.end - first.start
      continue
    }

    let endIndex = startIndex
    while (parts[endIndex].end < end) endIndex++
    const endPart = parts[endIndex]
    if (endPart.node.type === 'element' && end < endPart.end) {
      const beforeEmphasis = source.slice(start, endPart.start)
      const prefix = URL_PREFIX_REGEX.exec(beforeEmphasis)?.[0]
      matcher.lastIndex = endPart.end - first.start
      if (!prefix) continue
      end = start + includeReferenceTerminator(beforeEmphasis, 0, prefix.length)
    }

    advance(start, true)
    advance(end, false)
    const link = createLink(decodeText(source.slice(start, end)))
    const before = source.slice(positionOffset, start).split(/\r\n?|\n/)
    line += before.length - 1
    column = before.length === 1 ? column + before[0].length : before[before.length - 1].length + 1
    link.position = {
      start: { line, column, offset: start },
      end: { line, column: column + end - start, offset: end },
    }
    positionOffset = end
    column += end - start
    output.push(link)
  }
  advance(limit, true)
  return output
}

function linkRenderedText(node: Text): Array<Text | Element> {
  const output: Array<Text | Element> = []
  let cursor = 0
  for (const { 0: url, index } of node.value.matchAll(URL_REGEX)) {
    if (cursor < index) output.push({ type: 'text', value: node.value.slice(cursor, index) })
    output.push(createLink(url))
    cursor = index + url.length
  }
  if (cursor === 0) return [node]
  if (cursor < node.value.length) output.push({ type: 'text', value: node.value.slice(cursor) })
  return output
}

function autolinkChildren<Child extends RootContent>(
  children: Child[],
  source: string
): Array<Child | Element | Text> {
  const output: Array<Child | Element | Text> = []
  const run: SourcePart<Child>[] = []
  const visit = (child: Child) => {
    if (child.type === 'element' && !NON_LINKABLE_ELEMENTS.has(child.tagName)) {
      const { className } = child.properties
      if (!Array.isArray(className) || !className.includes('katex')) {
        child.children = autolinkChildren(child.children, source)
      }
    }
    return child
  }
  const flush = () => {
    if (run.length === 0) return
    for (const node of linkRun(run, source, visit)) output.push(node)
    run.length = 0
  }

  for (const child of children) {
    const part = sourcePart(child, source)
    if (run.length && part?.start !== run[run.length - 1].end) flush()
    if (part) {
      run.push(part)
    } else if (child.type === 'text') {
      for (const node of linkRenderedText(child)) output.push(node)
    } else {
      output.push(visit(child))
    }
  }
  flush()
  return output
}

export function rehypeAutolinkUrls() {
  return (tree: Root, file: { toString(): string }) => {
    tree.children = autolinkChildren(tree.children, file.toString())
  }
}
