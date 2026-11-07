import { getSharedHighlighter } from '@pierre/diffs'
import { expect, test } from 'vitest'
import { WEWORK_CODE_THEME } from './code-theme'

test('tokenizes code with live palette references instead of fixed theme colors', async () => {
  const highlighter = await getSharedHighlighter({
    themes: [WEWORK_CODE_THEME],
    langs: ['typescript'],
    preferredHighlighter: 'highlights',
  })
  const html = highlighter.codeToHtml('const message = "hello" // comment', {
    lang: 'typescript',
    theme: WEWORK_CODE_THEME,
  })
  expect(html).toContain('--color-syntax-keyword')
  expect(html).toContain('--color-syntax-string')
  expect(html).toContain('--color-syntax-comment')
  expect(html).toContain('--color-text-primary')
})

test('keeps types and operators distinct from function names and keywords', async () => {
  const highlighter = await getSharedHighlighter({
    themes: [WEWORK_CODE_THEME],
    langs: ['typescript'],
    preferredHighlighter: 'highlights',
  })
  const html = highlighter.codeToHtml('type Person = { name: string }; const value = 1 + 2', {
    lang: 'typescript',
    theme: WEWORK_CODE_THEME,
  })
  expect(html).toContain('--color-syntax-type')
  expect(html).toContain('--color-syntax-operator')
})
