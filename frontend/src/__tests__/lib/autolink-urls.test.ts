// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { rehypeAutolinkUrls } from '@/lib/autolink-urls'

// Exercise the real parser because delimiter handling depends on its output.
const { default: Markdown } = jest.requireActual<typeof import('react-markdown')>(
  '../../../node_modules/react-markdown/index.js'
)
const { default: rehypeRaw } = jest.requireActual<typeof import('rehype-raw')>(
  '../../../node_modules/rehype-raw/index.js'
)

function renderMarkdown(source: string) {
  return render(createElement(Markdown, { rehypePlugins: [rehypeRaw, rehypeAutolinkUrls] }, source))
}

describe('rehypeAutolinkUrls', () => {
  it.each([
    [
      '**https://example.com/shared/task?token=demo_value_**',
      'https://example.com/shared/task?token=demo_value_',
      '',
    ],
    ['**https://example.com**more', 'https://example.com', 'more'],
    ['**Read https://example.com**more', 'https://example.com', 'more'],
  ])('renders a bold link in %s', (source, url, suffix) => {
    const { container } = renderMarkdown(source)
    const link = screen.getByRole('link', { name: url })

    expect(link).toHaveAttribute('href', url)
    expect(link.closest('strong')).not.toBeNull()
    expect(container.querySelector('strong')?.nextSibling?.textContent ?? '').toBe(suffix)
  })

  it.each(['https://example.com/search?q=*', 'https://example.com/a**b'])(
    'preserves literal asterisks in %s',
    url => {
      renderMarkdown(url)

      expect(screen.getByRole('link', { name: url })).toHaveAttribute('href', url)
    }
  )

  it.each(['（说明）', '说明'])('stops a bare URL before %s', suffix => {
    const url = 'https://example.com/path'
    const { container } = renderMarkdown(`见 ${url}${suffix}`)

    expect(screen.getByRole('link', { name: url })).toHaveAttribute('href', url)
    expect(container.textContent).toBe(`见 ${url}${suffix}`)
  })

  it.each([
    '[https://example.com/docs](https://example.com/target)',
    '[See https://example.com/docs](https://example.com/target)',
    '[**https://example.com/docs**](https://example.com/target)',
    '[Label \\] https://example.com/docs](https://example.com/target)',
    '[Open `]` https://example.com/file.pdf](https://example.com/target)',
    '[![https://example.com/image.jpeg](https://example.com/image.jpeg)](https://example.com/target)',
    '[https://example.com/docs][target]\n\n[target]: https://example.com/target',
    '<a href="https://example.com/target">https://example.com/docs</a>',
  ])('keeps one explicit link in %s', source => {
    renderMarkdown(`${source}\n\nhttps://example.com/other`)

    const links = screen.getAllByRole('link')
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      'https://example.com/target',
      'https://example.com/other',
    ])
  })

  it.each([
    '`https://example.com/code`',
    '```\nhttps://example.com/code\n```',
    '![https://example.com/image.jpeg](https://example.com/image.jpeg)',
    '<img src="https://example.com/image.jpeg">',
  ])('leaves code and images without links in %s', source => {
    renderMarkdown(source)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('keeps an angle-bracket autolink and links bare URLs in prose', () => {
    renderMarkdown(
      '<https://example.com/explicit> [https://example.com/plain] www.example.com/docs.'
    )

    expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual([
      'https://example.com/explicit',
      'https://example.com/plain',
      'https://www.example.com/docs',
    ])
  })
})
