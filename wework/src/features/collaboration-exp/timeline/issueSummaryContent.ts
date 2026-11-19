import type { PhrasingContent } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const parser = unified().use(remarkParse)
const acceptanceHeading = /^(验收依据|验收标准|acceptance criteria|acceptance evidence)$/i

function inlineText(nodes: readonly PhrasingContent[], mode: 'heading' | 'preview'): string {
  return nodes
    .map(node => {
      if (mode === 'preview') {
        if (node.type === 'break') return ' '
        if (node.type === 'html') return ''
        if ('alt' in node) return node.alt ?? ''
      }
      return 'value' in node
        ? node.value
        : 'children' in node
          ? inlineText(node.children, mode)
          : ''
    })
    .join('')
}

export function issueBackgroundPreview(description: string): string {
  const block = parser
    .parse(description)
    .children.find(node => node.type === 'heading' || node.type === 'paragraph')
  return block ? inlineText(block.children, 'preview').replace(/\s+/g, ' ').trim() : ''
}

/** The existing description is the source; never infer acceptance from unrelated text. */
export function issueSummaryContent(description: string) {
  const nodes = parser.parse(description).children
  const index = nodes.findIndex(
    node =>
      node.type === 'heading' && acceptanceHeading.test(inlineText(node.children, 'heading').trim())
  )
  const heading = nodes[index]
  if (!heading || heading.type !== 'heading') return { description, acceptance: '' }
  const following = nodes
    .slice(index + 1)
    .find(node => node.type === 'heading' && node.depth <= heading.depth)
  const start = heading.position?.start.offset
  const body = heading.position?.end.offset
  const end = following?.position?.start.offset ?? description.length
  if (start === undefined || body === undefined) return { description, acceptance: '' }
  return {
    description: [description.slice(0, start).trim(), description.slice(end).trim()]
      .filter(Boolean)
      .join('\n\n'),
    acceptance: description.slice(body, end).trim(),
  }
}
