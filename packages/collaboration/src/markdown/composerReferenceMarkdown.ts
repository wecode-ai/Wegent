import type { Nodes } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { classifyComposerReference, parseComposerReferences } from '../composer/composerReference'

const markdownParser = unified().use(remarkParse)
const literalTypes = new Set(['code', 'inlineCode', 'html'])
const htmlLiteralContainerPattern = /<(pre|code|script|style|textarea|xmp)\b[^>]*>/gi

interface SourceRange {
  start: number
  end: number
}

/** Collects syntax that must retain its original bytes during preprocessing. */
function collectLiteralRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = []
  const visit = (node: Nodes) => {
    if (literalTypes.has(node.type)) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) ranges.push({ start, end })
      return
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(markdownParser.parse(source))

  // The Markdown AST exposes opening and closing container tags separately
  // from their inline children. Protect the complete raw-HTML literal too.
  const lowerSource = source.toLowerCase()
  for (const match of source.matchAll(htmlLiteralContainerPattern)) {
    const start = match.index ?? 0
    const closingTag = `</${match[1].toLowerCase()}>`
    const closingStart = lowerSource.indexOf(closingTag, start + match[0].length)
    ranges.push({
      start,
      end: closingStart < 0 ? source.length : closingStart + closingTag.length,
    })
  }
  for (const match of source.matchAll(/<!--/g)) {
    const start = match.index ?? 0
    const endMarker = source.indexOf('-->', start + 4)
    ranges.push({
      start,
      end: endMarker < 0 ? source.length : endMarker + 3,
    })
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
    literalRanges = collectLiteralRanges(content)
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
