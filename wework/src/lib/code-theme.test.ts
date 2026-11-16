import { getSharedHighlighter } from '@pierre/diffs'
import { expect, test } from 'vitest'
import { getWorkbenchCodeTheme, WEWORK_CODE_THEME } from './code-theme'

test('selects original Pierre palettes per Wework mode without changing named palettes', () => {
  expect(getWorkbenchCodeTheme('wework', 'wework')).toEqual({
    light: 'pierre-light',
    dark: 'pierre-dark',
  })
  expect(getWorkbenchCodeTheme('wework', 'tokyo-night')).toEqual({
    light: 'pierre-light',
    dark: WEWORK_CODE_THEME,
  })
  expect(getWorkbenchCodeTheme('github', 'wework')).toEqual({
    light: WEWORK_CODE_THEME,
    dark: 'pierre-dark',
  })
  expect(getWorkbenchCodeTheme('github', 'tokyo-night')).toBe(WEWORK_CODE_THEME)
  expect(getWorkbenchCodeTheme('wework', 'wework')).toBe(getWorkbenchCodeTheme('wework', 'wework'))
})

test.each([
  ['pierre-light', '#d32a61', '#199f43', '#693acf'],
  ['pierre-dark', '#ff678d', '#5ecc71', '#9d6afb'],
])(
  'keeps the original %s keyword, string, function and comment colors',
  async (theme, ...colors) => {
    const highlighter = await getSharedHighlighter({
      themes: [theme],
      langs: ['typescript'],
      preferredHighlighter: 'highlights',
    })
    const html = highlighter.codeToHtml('function greet() { return "hello" } // comment', {
      lang: 'typescript',
      theme,
    })
    for (const color of [...colors, '#737373']) expect(html.toLowerCase()).toContain(color)
    expect(html).not.toContain('--color-syntax-')
  }
)

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
