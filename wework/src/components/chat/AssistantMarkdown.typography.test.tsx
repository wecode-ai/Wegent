import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { readMessageLayoutTypography } from '@wegent/collaboration/conversation/messagePretextLayout'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import loadConfig from 'tailwindcss/loadConfig'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
import '@/i18n'

const style = document.createElement('style')
const originalRootStyle = document.documentElement.getAttribute('style')

beforeAll(async () => {
  const config = loadConfig(resolve(process.cwd(), 'tailwind.config.js'))
  const source = readFileSync(
    resolve(process.cwd(), '../packages/collaboration/src/markdown/AssistantMarkdown.tsx'),
    'utf8'
  )
  const result = await postcss([
    tailwindcss({
      ...config,
      corePlugins: ['lineHeight'],
      content: [{ raw: source, extension: 'tsx' }],
    }),
  ]).process('@tailwind utilities;', { from: undefined })
  style.textContent = result.css
  document.head.append(style)
})

afterEach(() => {
  if (originalRootStyle === null) document.documentElement.removeAttribute('style')
  else document.documentElement.setAttribute('style', originalRootStyle)
})
afterAll(() => style.remove())

test.each(['user', 'default', 'document', 'process'] as const)(
  'keeps %s paragraphs and list items consistent with virtual message typography',
  variant => {
    const { container } = render(
      <AssistantMarkdown
        variant={variant}
        content={
          'Follow-up\n\n7. First requirement\n8. Second requirement\n\n- Another requirement'
        }
      />
    )
    expect(container.querySelector('ol')).toHaveAttribute('start', '7')
    const lines = container.querySelectorAll('p, li')
    expect(lines).toHaveLength(4)
    for (const rootSize of [16, 20]) {
      document.documentElement.style.setProperty('font-size', `${rootSize}px`)
      const typography = readMessageLayoutTypography(container)
      const expected = variant === 'user' ? typography.userLineHeight : typography.lineHeight
      for (const line of lines) {
        const lineHeight = getComputedStyle(line).lineHeight
        const pixels = Number.parseFloat(lineHeight) * (lineHeight.endsWith('rem') ? rootSize : 1)
        expect(pixels, `${variant} ${line.tagName} at root size ${rootSize}`).toBe(expected)
      }
    }
  }
)
