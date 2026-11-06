import type { Link, Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, test } from 'vitest'
import { protectComposerReferenceLinks } from './assistantMarkdownLinks'
import { remarkMathDelimiters } from './remarkMathDelimiters'

function parseMarkdown(source: string): Root {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMathDelimiters).parse(source) as Root
}

function paragraphChildren(source: string) {
  const paragraph = parseMarkdown(source).children[0]
  if (paragraph?.type !== 'paragraph') throw new Error('Expected a paragraph')
  return paragraph.children
}

function containsInlineMath(node: Root | Root['children'][number]): boolean {
  if (node.type === 'inlineMath') return true
  return 'children' in node && node.children.some(child => containsInlineMath(child))
}

describe('remarkMathDelimiters', () => {
  test('keeps adjacent dollar-prefixed composer links out of inline math', () => {
    const children = paragraphChildren(
      protectComposerReferenceLinks(
        '[$#113 Issue](wework-issue://p/i) [$Chat](wework-conversation://c)'
      )
    )

    const links = children.filter((child): child is Link => child.type === 'link')
    expect(links).toHaveLength(2)
    expect(children.some(child => child.type === 'inlineMath')).toBe(false)
  })

  test('keeps regular inline dollar math', () => {
    const children = paragraphChildren('Energy is $E=mc^2$.')

    expect(containsInlineMath({ type: 'root', children })).toBe(true)
  })

  test('preserves bracketed inline math that is not a composer reference', () => {
    expect(protectComposerReferenceLinks('[$Site](wegent-sites-project://project)')).toBe(
      '[\\$Site](wegent-sites-project://project)'
    )
    expect(protectComposerReferenceLinks('[$x$](https://example.com)')).toBe(
      '[$x$](https://example.com)'
    )
    expect(
      containsInlineMath({
        type: 'root',
        children: paragraphChildren('[$x$]'),
      })
    ).toBe(true)
    expect(
      containsInlineMath({
        type: 'root',
        children: paragraphChildren('[$x$](https://example.com)'),
      })
    ).toBe(true)
  })
})
