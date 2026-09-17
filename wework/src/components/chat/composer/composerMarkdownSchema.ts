import type { MarkSpec, NodeSpec } from 'prosemirror-model'
import { tableNodes } from 'prosemirror-tables'

export const composerMarkdownNodes: Record<string, NodeSpec> = {
  heading: {
    attrs: { level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    toDOM: node => [`h${node.attrs.level}`, 0],
    parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}`, attrs: { level } })),
  },
  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    toDOM: () => ['blockquote', 0],
    parseDOM: [{ tag: 'blockquote' }],
  },
  code_block: {
    attrs: { language: { default: '' } },
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    toDOM: () => ['pre', ['code', 0]],
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
  },
  bullet_list: {
    content: 'list_item+',
    group: 'block',
    toDOM: () => ['ul', 0],
    parseDOM: [{ tag: 'ul' }],
  },
  ordered_list: {
    attrs: { start: { default: 1 } },
    content: 'list_item+',
    group: 'block',
    toDOM: node => ['ol', { start: node.attrs.start }, 0],
    parseDOM: [
      { tag: 'ol', getAttrs: element => ({ start: Number(element.getAttribute('start') || 1) }) },
    ],
  },
  list_item: {
    attrs: { checked: { default: null } },
    content: 'paragraph block*',
    defining: true,
    toDOM: node => [
      'li',
      node.attrs.checked === null ? {} : { 'data-checked': String(node.attrs.checked) },
      0,
    ],
    parseDOM: [{ tag: 'li' }],
  },
  horizontal_rule: {
    group: 'block',
    toDOM: () => ['hr'],
    parseDOM: [{ tag: 'hr' }],
  },
  ...tableNodes({
    tableGroup: 'block',
    cellContent: 'paragraph+',
    cellAttributes: {
      align: {
        default: null,
        getFromDOM: element => element.style.textAlign || null,
        setDOMAttr: (value, attrs) => {
          if (value) attrs.style = `text-align: ${value}`
        },
      },
    },
  }),
}

export const composerMarkdownMarks: Record<string, MarkSpec> = {
  strong: { toDOM: () => ['strong', 0], parseDOM: [{ tag: 'strong' }, { tag: 'b' }] },
  em: { toDOM: () => ['em', 0], parseDOM: [{ tag: 'em' }, { tag: 'i' }] },
  strike: { toDOM: () => ['s', 0], parseDOM: [{ tag: 's' }, { tag: 'del' }] },
  link: {
    attrs: { href: {}, title: { default: null }, autolink: { default: false } },
    inclusive: false,
    toDOM: node => [
      'a',
      {
        href: /^(?:https?:|mailto:|\/|#)/i.test(node.attrs.href) ? node.attrs.href : undefined,
        title: node.attrs.title,
        'data-composer-autolink': node.attrs.autolink ? 'true' : undefined,
        tabindex: -1,
      },
      0,
    ],
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: element => ({
          href: element.getAttribute('href'),
          title: element.getAttribute('title'),
          autolink: element.getAttribute('data-composer-autolink') === 'true',
        }),
      },
    ],
  },
  code: { code: true, toDOM: () => ['code', 0], parseDOM: [{ tag: 'code' }] },
}
