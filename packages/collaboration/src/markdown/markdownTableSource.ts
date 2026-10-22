import type { Root, RootContent } from 'hast'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { defaultRehypePlugins, type StreamdownProps } from 'streamdown'

declare module 'hast' {
  interface ElementData {
    tableMarkdown?: string
  }
}

function preserveTableMarkdown() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value)
    const visit = (node: Root | RootContent) => {
      if (node.type === 'element' && node.tagName === 'table') {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start !== undefined && end !== undefined) {
          node.data = {
            ...node.data,
            tableMarkdown: source.slice(start, end),
          }
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}

export function createTableMarkdownRehypePlugins(): StreamdownProps['rehypePlugins'] {
  return [
    defaultRehypePlugins.raw,
    // Wework handles file and application links directly. Keep HTML sanitization,
    // but omit Streamdown's URL hardener, which blocks local paths and file URLs.
    [
      rehypeSanitize,
      {
        ...defaultSchema,
        protocols: {
          ...defaultSchema.protocols,
          href: [
            ...(defaultSchema.protocols?.href ?? []),
            'tel',
            'file',
            'folder',
            'skill',
            'plugin',
            'app',
            'cloud',
            'wegent',
            'wework',
            'wework-conversation',
            'wework-issue',
            'wework-member',
            'wework-agent',
            'wework-group',
            'wegent-sites-project',
            ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
          ],
          src: [...(defaultSchema.protocols?.src ?? []), 'file'],
        },
        attributes: {
          ...defaultSchema.attributes,
          code: [...(defaultSchema.attributes?.code ?? []), 'metastring'],
        },
      },
    ],
    preserveTableMarkdown,
  ]
}
