import type { Root as HastRoot, RootContent } from 'hast'
import type { Nodes, PhrasingContent, Root } from 'mdast'
import type { Plugin } from 'unified'
import {
  collectAssistantAnnotations,
  type AnnotationSpan,
  type AssistantAnnotation,
} from './assistantAnnotations'

declare module 'hast' {
  interface ElementData {
    assistantAnnotation?: AssistantAnnotation
  }
}

declare module 'mdast' {
  interface RootData {
    assistantAnnotations?: AnnotationSpan[]
  }
}

// Keep annotation metadata out of HTML attributes and URL decoding. The final
// rehype step attaches it only to nodes created at verified source positions.
export const remarkAssistantAnnotations: Plugin<[{ isStreaming: boolean }], Root> = function (
  options
) {
  const parse = this.parser!
  this.parser = (source, file) => {
    const original = parse(source, file) as Root
    if (!/codex-file-citation|codex-followup|†L|\uE200/.test(source)) return original
    const spans = collectAssistantAnnotations(source, original, options.isStreaming)
    if (!spans.length) return original
    let cursor = 0
    const masked =
      spans
        .map(span => {
          const before = source.slice(cursor, span.start)
          cursor = span.end
          return (
            before +
            source[span.start] +
            source.slice(span.start + 1, span.end - 1).replace(/[^\r\n]/g, 'x') +
            source[span.end - 1]
          )
        })
        .join('') + source.slice(cursor)
    const tree = parse(masked, file) as Root
    tree.data = { ...tree.data, assistantAnnotations: spans }
    const visit = (node: Nodes) => {
      if (!('children' in node)) return
      node.children = node.children.flatMap((child): typeof node.children => {
        if (
          child.type !== 'text' ||
          child.position?.start.offset === undefined ||
          child.position.end.offset === undefined
        ) {
          visit(child)
          return [child] as typeof node.children
        }
        const start = child.position.start.offset
        const end = child.position.end.offset
        const contained = spans.flatMap(span => {
          if (span.start >= end || span.end <= start) return []
          if (span.annotation.kind === 'hidden')
            return [{ ...span, start: Math.max(start, span.start), end: Math.min(end, span.end) }]
          return span.start >= start && span.end <= end ? [span] : []
        })
        if (!contained.length) return [child]
        // Reparse text runs separately so entities and Markdown escapes retain
        // their own offsets; never slice a decoded text value with source offsets.
        const children: PhrasingContent[] = []
        let offset = start
        const inline = (text: string, label = false): PhrasingContent[] => {
          if (!text) return []
          // A paragraph prefix keeps labels inline without changing underscore
          // delimiter flanking; text runs need both sentinels to retain spaces.
          const parsed = parse(label ? `: ${text}` : `x${text}x`, file) as Root
          const nodes = parsed.children.flatMap(child =>
            child.type === 'paragraph' ? child.children : [{ type: 'text' as const, value: text }]
          )
          const first = nodes[0]
          const last = nodes.at(-1)
          if (first?.type === 'text') first.value = first.value.slice(label ? 2 : 1)
          if (!label && last?.type === 'text') last.value = last.value.slice(0, -1)
          return nodes
        }
        for (const span of contained) {
          children.push(...inline(source.slice(offset, span.start)))
          if (span.annotation.kind !== 'hidden') {
            const label =
              span.annotation.kind === 'file'
                ? [
                    {
                      type: 'text' as const,
                      value:
                        span.annotation.path.split(/[\\/]/).filter(Boolean).pop() ||
                        span.annotation.path,
                    },
                  ]
                : unwrapLabelLinks(inline(span.annotation.label, true))
            children.push({
              type: 'link',
              url: '',
              children: label,
              position: {
                start: {
                  ...child.position.start,
                  offset: span.start,
                  column: child.position.start.column + span.start - start,
                },
                end: {
                  ...child.position.end,
                  offset: span.end,
                  column: child.position.start.column + span.end - start,
                },
              },
            })
          }
          offset = span.end
        }
        children.push(...inline(source.slice(offset, end)))
        return children as typeof node.children
      }) as typeof node.children
    }
    visit(tree)
    return tree
  }
  return (tree, file) => {
    // Streamdown uses separate VFiles for parse and runSync.
    file.data.assistantAnnotations = tree.data?.assistantAnnotations
  }
}

function unwrapLabelLinks(nodes: PhrasingContent[]): PhrasingContent[] {
  return nodes.flatMap(node => {
    if (node.type === 'link' || node.type === 'linkReference')
      return unwrapLabelLinks(node.children)
    if ('children' in node) node.children = unwrapLabelLinks(node.children) as typeof node.children
    return [node]
  })
}

export function rehypeAssistantAnnotations() {
  return (tree: HastRoot, file: { data: Record<string, unknown> }) => {
    const spans = file.data.assistantAnnotations as AnnotationSpan[] | undefined
    if (!spans) return
    const byStart = new Map(spans.map(span => [span.start, span]))
    const visit = (node: HastRoot | RootContent) => {
      if (node.type === 'element' && node.tagName === 'a') {
        const span = byStart.get(node.position?.start.offset ?? -1)
        if (span && span.end === node.position?.end.offset) {
          node.data = { ...node.data, assistantAnnotation: span.annotation }
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}
