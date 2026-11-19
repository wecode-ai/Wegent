import type { Nodes } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { classifyComposerReference, parseComposerReferences } from '../composer/composerReference'

const markdownParser = unified().use(remarkParse)
const literalTypes = new Set(['code', 'inlineCode', 'html'])
const htmlLiteralContainerPattern = /^<(pre|code|script|style|textarea|xmp)\b[^>]*>/i

interface SourceRange {
  start: number
  end: number
}

interface HtmlLiteralNode extends SourceRange {
  value: string
}

/** Collects syntax that must retain its original bytes during preprocessing. */
export function collectMarkdownLiteralRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = []
  const htmlNodes: HtmlLiteralNode[] = []
  const visit = (node: Nodes) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (literalTypes.has(node.type) && start !== undefined && end !== undefined) {
      ranges.push({ start, end })
      if (node.type === 'html') htmlNodes.push({ start, end, value: node.value })
      return
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(markdownParser.parse(source))

  // Raw HTML container tags are separate AST nodes from their Markdown
  // children. Extend each real opening tag to its matching closing node.
  // Scanning only AST HTML nodes keeps tag-like text inside code literals out
  // of this range collection.
  for (const [index, node] of htmlNodes.entries()) {
    const opening = htmlLiteralContainerPattern.exec(node.value)
    if (!opening) continue
    const tagName = opening[1].toLowerCase()
    if (new RegExp(`</${tagName}\\s*>`, 'i').test(node.value)) continue
    const openingTagPattern = new RegExp(`^<${tagName}\\b`, 'i')
    const closingTagPattern = new RegExp(`^</${tagName}\\s*>`, 'i')
    let depth = 1
    let end = source.length
    for (const candidate of htmlNodes.slice(index + 1)) {
      const value = candidate.value.trim()
      if (openingTagPattern.test(value)) {
        depth += 1
      } else if (closingTagPattern.test(value)) {
        depth -= 1
        if (depth === 0) {
          end = candidate.end
          break
        }
      }
    }
    ranges.push({ start: node.start, end })
  }

  ranges.sort((left, right) => left.start - right.start)
  const merged: SourceRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Escapes the dollar prefix of composer reference links so the Markdown math
 * parser cannot combine adjacent mention labels into one inline formula.
 * Ordinary bracketed math such as `[$x$](https://example.com)` is untouched,
 * as are references used as literal examples inside code or raw HTML.
 */
export function protectComposerReferenceLinks(content: string): string {
  if (!content.includes('[$')) return content
  const references = parseComposerReferences(content)
  if (references.length === 0) return content

  let literalRanges: SourceRange[]
  try {
    literalRanges = collectMarkdownLiteralRanges(content)
  } catch {
    // An incomplete streaming document should never make the renderer corrupt
    // text it cannot classify yet.
    return content
  }

  let literalIndex = 0
  let cursor = 0
  let protectedContent = ''
  for (const reference of references) {
    while (literalRanges[literalIndex]?.end <= reference.start) literalIndex++
    if (literalRanges[literalIndex]?.start <= reference.start) continue
    if (
      !reference.reference.startsWith('[$') ||
      !classifyComposerReference(reference.label, reference.href)
    ) {
      continue
    }
    protectedContent += content.slice(cursor, reference.start)
    protectedContent += reference.reference.replace(/^\[\$/, '[\\$')
    cursor = reference.end
  }
  return cursor === 0 ? content : protectedContent + content.slice(cursor)
}
