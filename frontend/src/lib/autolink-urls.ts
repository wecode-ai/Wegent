import type { Element, Root, RootContent, Text } from 'hast'

// GFM autolink literals are disabled for iOS 16. Match URLs in parsed text so
// Markdown emphasis and literal asterisks retain their meaning.
const URL_REGEX =
  /(?:https?:\/\/|www\.)[^\s<>\[\]()\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]*[^\s<>\[\]()\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF.,;:!?'")\]}>]/gi

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

function autolinkText(node: Text, source: string): Array<Text | Element> {
  const children: Array<Text | Element> = []
  const start = node.position?.start
  const offset = start?.offset
  // Keep source positions for consumers that lay out links on their own lines.
  const sourceOffset =
    offset !== undefined &&
    node.position?.end.offset === offset + node.value.length &&
    source.startsWith(node.value, offset)
      ? offset
      : undefined
  let line = start?.line ?? 1
  let column = start?.column ?? 1
  let cursor = 0

  for (const { 0: url, index } of node.value.matchAll(URL_REGEX)) {
    const before = node.value.slice(cursor, index)
    if (index > cursor) {
      children.push({ type: 'text', value: before })
    }
    const link: Element = {
      type: 'element',
      tagName: 'a',
      properties: { href: /^www\./i.test(url) ? `https://${url}` : url },
      children: [{ type: 'text', value: url }],
    }
    cursor = index + url.length
    if (sourceOffset !== undefined) {
      const lines = before.split(/\r\n?|\n/)
      line += lines.length - 1
      column = lines.length === 1 ? column + before.length : lines[lines.length - 1].length + 1
      link.position = {
        start: { line, column, offset: sourceOffset + index },
        end: { line, column: column + url.length, offset: sourceOffset + cursor },
      }
      column += url.length
    }
    children.push(link)
  }

  if (cursor === 0) return [node]
  if (cursor < node.value.length) children.push({ type: 'text', value: node.value.slice(cursor) })
  return children
}

function autolinkChildren<Child extends RootContent>(
  children: Child[],
  source: string
): Array<Child | Element | Text> {
  return children.flatMap<Child | Element | Text>(child => {
    if (child.type === 'text') return autolinkText(child, source)
    if (child.type === 'element' && !NON_LINKABLE_ELEMENTS.has(child.tagName)) {
      const { className } = child.properties
      if (!Array.isArray(className) || !className.includes('katex')) {
        child.children = autolinkChildren(child.children, source)
      }
    }
    return [child]
  })
}

export function rehypeAutolinkUrls() {
  return (tree: Root, file: { toString(): string }) => {
    tree.children = autolinkChildren(tree.children, file.toString())
  }
}
