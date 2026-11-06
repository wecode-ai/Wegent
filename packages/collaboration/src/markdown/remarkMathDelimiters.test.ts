import type { Link, Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, test } from 'vitest'
import { remarkMathDelimiters } from './remarkMathDelimiters'

function parseMarkdown(source: string): Root {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMathDelimiters).parse(source) as Root
}

function paragraphChildren(source: string) {
  const paragraph = parseMarkdown(source).children[0]
  if (paragraph?.type !== 'paragraph') throw new Error('Expected a paragraph')
  return paragraph.children
}

describe('remarkMathDelimiters', () => {
  test('keeps adjacent dollar-prefixed composer links out of inline math', () => {
    const children = paragraphChildren(
      '[$#113 Issue](wework-issue://p/i) [$Chat](wework-conversation://c)'
    )

    const links = children.filter((child): child is Link => child.type === 'link')
    expect(links).toHaveLength(2)
    expect(children.some(child => child.type === 'inlineMath')).toBe(false)
  })

  test('keeps regular inline dollar math', () => {
    const children = paragraphChildren('Energy is $E=mc^2$.')

    expect(children.some(child => child.type === 'inlineMath')).toBe(true)
  })
})
