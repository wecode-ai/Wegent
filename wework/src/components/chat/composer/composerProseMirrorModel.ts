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
} from './composerMentions'

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

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph' },
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
  },
  marks: {
    composer_mention_separator: mentionSeparatorMarkSpec,
  },
})

export function createComposerDocument(value: string): ProseMirrorNode {
  const sanitizedValue = value.replaceAll(OBJECT_REPLACEMENT_CHARACTER, '')
  const content: ProseMirrorNode[] = []
  const mentions = parseComposerMentions(sanitizedValue)
  let offset = 0

  for (const mention of mentions) {
    if (mention.start < offset) continue
    appendComposerText(content, sanitizedValue.slice(offset, mention.start))
    content.push(composerSchema.nodes.composer_mention.create(mention))
    offset = mention.end
    if (sanitizedValue[offset] === ' ') {
      content.push(
        composerSchema.text(' ', [composerSchema.marks.composer_mention_separator.create()])
      )
      offset += 1
    }
  }
  appendComposerText(content, sanitizedValue.slice(offset))
  return composerSchema.node('doc', null, [composerSchema.node('paragraph', null, content)])
}

function appendComposerText(content: ProseMirrorNode[], text: string): void {
  text.split('\n').forEach((line, index) => {
    if (index > 0) content.push(composerSchema.nodes.hard_break.create())
    if (line) content.push(composerSchema.text(line))
  })
}

export function serializeComposerDocument(doc: ProseMirrorNode): string {
  return serializeComposerFragment(doc.content)
}

export function serializeComposerSlice(slice: Slice): string {
  return serializeComposerFragment(slice.content)
}

function serializeComposerFragment(fragment: Fragment): string {
  const parts: string[] = []
  fragment.descendants(node => {
    if (node.isText) {
      parts.push(node.text ?? '')
    } else if (node.type === composerSchema.nodes.composer_mention) {
      parts.push(String(node.attrs.reference ?? ''))
    } else if (node.type === composerSchema.nodes.hard_break) {
      parts.push('\n')
    }
    return !node.isText && node.type !== composerSchema.nodes.composer_mention
  })
  return parts.join('')
}
