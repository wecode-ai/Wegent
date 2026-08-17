import {
  Schema,
  type Fragment,
  type MarkSpec,
  type Node as ProseMirrorNode,
  type NodeSpec,
  type Slice,
} from 'prosemirror-model'
import {
  createComposerMentionElement,
  parseComposerMentions,
  type ComposerMentionPayload,
  type ParsedComposerMention,
} from './composerMentions'
import {
  createComposerLinkElement,
  parseComposerLinks,
  type ComposerLinkPayload,
  type ParsedComposerLink,
} from './composerLinks'

export const OBJECT_REPLACEMENT_CHARACTER = '\uFFFC'

const mentionNodeSpec: NodeSpec = {
  attrs: {
    name: { default: '' },
    label: { default: '' },
    reference: { default: '' },
  },
  inline: true,
  group: 'inline',
  atom: true,
  draggable: false,
  selectable: false,
  toDOM(node) {
    return createComposerMentionElement(node.attrs as ComposerMentionPayload)
  },
  parseDOM: [
    {
      tag: 'span[data-composer-skill-reference]',
      getAttrs(element) {
        if (!(element instanceof HTMLElement)) return false
        const name = element.getAttribute('data-composer-skill-name') ?? ''
        return {
          name,
          label: element.getAttribute('data-composer-skill-label') || name,
          reference: element.getAttribute('data-composer-skill-reference') ?? '',
        }
      },
    },
  ],
}

const mentionSeparatorMarkSpec: MarkSpec = {
  inclusive: false,
  toDOM: () => ['span', { class: 'composer-mention-separator' }, 0],
  parseDOM: [{ tag: 'span.composer-mention-separator' }],
}

const linkNodeSpec: NodeSpec = {
  attrs: {
    url: { default: '' },
    label: { default: '' },
    iconUrl: { default: '' },
    provider: { default: '' },
  },
  inline: true,
  group: 'inline',
  atom: true,
  draggable: false,
  selectable: false,
  toDOM(node) {
    return createComposerLinkElement(node.attrs as ComposerLinkPayload)
  },
  parseDOM: [
    {
      tag: 'span[data-composer-link-url]',
      getAttrs(element) {
        if (!(element instanceof HTMLElement)) return false
        return {
          url: element.getAttribute('data-composer-link-url') ?? '',
          label:
            element.getAttribute('data-composer-link-label') ??
            element.getAttribute('aria-label') ??
            '',
          iconUrl: element.querySelector('img')?.getAttribute('src') ?? '',
          provider: element.getAttribute('data-composer-link-provider') ?? '',
        }
      },
    },
  ],
}

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      toDOM: () => ['br'],
      parseDOM: [{ tag: 'br' }],
    },
    composer_mention: mentionNodeSpec,
    composer_link: linkNodeSpec,
  },
  marks: {
    composer_mention_separator: mentionSeparatorMarkSpec,
  },
})

export function createComposerDocument(value: string): ProseMirrorNode {
  const sanitizedValue = value.replace(/\r\n?/g, '\n').replaceAll(OBJECT_REPLACEMENT_CHARACTER, '')
  const paragraphs: ProseMirrorNode[] = []
  let content: ProseMirrorNode[] = []
  const mentions = parseComposerMentions(sanitizedValue)
  const links = parseComposerLinks(sanitizedValue)
  const tokens = mergeComposerTokens(mentions, links)
  let offset = 0

  for (const token of tokens) {
    if (token.start < offset) continue
    content = appendComposerText(paragraphs, content, sanitizedValue.slice(offset, token.start))
    if (token.kind === 'mention') {
      content.push(composerSchema.nodes.composer_mention.create(token.payload))
    } else {
      content.push(composerSchema.nodes.composer_link.create(token.payload))
    }
    offset = token.end
    if (sanitizedValue[offset] === ' ') {
      content.push(
        composerSchema.text(' ', [composerSchema.marks.composer_mention_separator.create()])
      )
      offset += 1
    }
  }
  content = appendComposerText(paragraphs, content, sanitizedValue.slice(offset))
  paragraphs.push(composerSchema.node('paragraph', null, content))
  return composerSchema.node('doc', null, paragraphs)
}

function appendComposerText(
  paragraphs: ProseMirrorNode[],
  initialContent: ProseMirrorNode[],
  text: string
): ProseMirrorNode[] {
  let content = initialContent
  text.split('\n').forEach((line, index) => {
    if (index > 0) {
      paragraphs.push(composerSchema.node('paragraph', null, content))
      content = []
    }
    if (line) content.push(composerSchema.text(line))
  })
  return content
}

interface MergedToken {
  kind: 'mention' | 'link'
  start: number
  end: number
  payload: ComposerMentionPayload | ComposerLinkPayload
}

function mergeComposerTokens(
  mentions: ParsedComposerMention[],
  links: ParsedComposerLink[]
): MergedToken[] {
  const mentionTokens: MergedToken[] = mentions.map(mention => ({
    kind: 'mention',
    start: mention.start,
    end: mention.end,
    payload: mention,
  }))
  const linkTokens: MergedToken[] = links.map(link => ({
    kind: 'link',
    start: link.start,
    end: link.end,
    payload: link,
  }))
  return [...mentionTokens, ...linkTokens]
    .filter(
      (left, index, items) =>
        !items.some(
          (right, otherIndex) =>
            index !== otherIndex &&
            left.start < right.end &&
            left.end > right.start &&
            (left.start > right.start || (left.start === right.start && index > otherIndex))
        )
    )
    .sort((a, b) => a.start - b.start)
}

export function serializeComposerLinkNode(node: ProseMirrorNode): string {
  const label = String(node.attrs.label ?? '')
  const url = String(node.attrs.url ?? '')
  return label ? `[${label}](${url})` : url
}

export function serializeComposerDocument(doc: ProseMirrorNode): string {
  return serializeComposerFragment(doc.content)
}

export function serializeComposerSlice(slice: Slice): string {
  return serializeComposerFragment(slice.content)
}

function serializeComposerFragment(fragment: Fragment): string {
  const parts: string[] = []
  fragment.forEach((node, _offset, index) => {
    if (node.type === composerSchema.nodes.paragraph) {
      if (index > 0) parts.push('\n')
      appendSerializedComposerContent(parts, node.content)
      return
    }
    appendSerializedComposerNode(parts, node)
  })
  return parts.join('')
}

function appendSerializedComposerContent(parts: string[], fragment: Fragment): void {
  fragment.forEach(node => appendSerializedComposerNode(parts, node))
}

function appendSerializedComposerNode(parts: string[], node: ProseMirrorNode): void {
  if (node.isText) {
    parts.push(node.text ?? '')
  } else if (node.type === composerSchema.nodes.composer_mention) {
    parts.push(String(node.attrs.reference ?? ''))
  } else if (node.type === composerSchema.nodes.composer_link) {
    parts.push(serializeComposerLinkNode(node))
  } else if (node.type === composerSchema.nodes.hard_break) {
    parts.push('\n')
  } else {
    appendSerializedComposerContent(parts, node.content)
  }
}
