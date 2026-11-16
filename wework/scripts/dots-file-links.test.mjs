import { describe, expect, test } from 'vitest'
import { getAssistantReferences } from '../../packages/collaboration/src/conversation/codexReferences.ts'
import {
  classifyMarkdownLink,
  extractMarkdownLinks,
} from '../../packages/collaboration/src/markdown/assistantMarkdownLinks.ts'
import { dotsFileLink } from '../e2e/desktop/modules/dots-story-fixtures.mjs'

describe('Dots model delivery links use the real Markdown file contract', () => {
  test.each([
    '/tmp/Dots QA/cart-fixture',
    'D:\\qa\\Dots QA\\cart-fixture',
    'D:\\研发 #1\\cart-fixture',
    '\\\\server\\share\\Dots QA\\cart-fixture',
  ])('retains document cards and code-file links for %s', root => {
    const directory = root.replaceAll('\\', '/')
    const documentPath = `${directory}/cart-review.md`
    const codePath = `${directory}/cart.mjs`
    const content = [
      dotsFileLink('cart-fixture/cart-review.md', `${root}/cart-review.md`),
      dotsFileLink('cart.mjs', `${root}/cart.mjs`),
    ].join('\n')

    expect(getAssistantReferences([], content)).toEqual([
      { title: 'cart-fixture/cart-review.md', path: documentPath },
    ])
    expect(extractMarkdownLinks(content).map(link => classifyMarkdownLink(link.href))).toEqual([
      { kind: 'file', path: documentPath },
      { kind: 'file', path: codePath },
    ])
  })
})
