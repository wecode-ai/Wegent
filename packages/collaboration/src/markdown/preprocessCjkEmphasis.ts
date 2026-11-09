import type { Nodes } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const parser = unified().use(remarkParse)
const closingPunctuation = /([\u3000-\u303F\uFF00-\uFFEF\u2018-\u201F\u2E00-\u2E7F])\*/

/** Normalize display input only; preserve Markdown code byte for byte. */
export function preprocessCjkEmphasis(source: string): string {
  if (!closingPunctuation.test(source)) return source

  const protectedRanges: { start: number; end: number }[] = []
  const visit = (node: Nodes) => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) protectedRanges.push({ start, end })
    } else if ('children' in node) node.children.forEach(visit)
  }
  visit(parser.parse(source))

  let cursor = 0
  const output: string[] = []
  for (const { start, end } of protectedRanges) {
    output.push(normalizeProse(source.slice(cursor, start)), source.slice(start, end))
    cursor = end
  }
  output.push(normalizeProse(source.slice(cursor)))
  return output.join('')
}

function normalizeProse(source: string): string {
  // U+200B is neither punctuation nor whitespace: the following asterisks can
  // close emphasis even when a CJK letter immediately follows the delimiter.
  return source
    .replace(/([\u3000-\u303F\uFF00-\uFFEF\u2018-\u201F\u2E00-\u2E7F])\*\*/g, '$1\u200B**')
    .replace(/([\u3000-\u303F\uFF00-\uFFEF\u2018-\u201F\u2E00-\u2E7F])\*(?!\*)/g, '$1\u200B*')
}
