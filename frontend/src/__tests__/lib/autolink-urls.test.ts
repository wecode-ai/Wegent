// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { autolinkUrls } from '@/lib/autolink-urls'

describe('autolinkUrls', () => {
  it('stops bare links before adjacent CJK text and full-width parentheses', () => {
    expect(autolinkUrls('见 https://example.com/path（说明）')).toBe(
      '见 [https://example.com/path](https://example.com/path)（说明）'
    )
    expect(autolinkUrls('见 https://example.com/path说明')).toBe(
      '见 [https://example.com/path](https://example.com/path)说明'
    )
  })

  it('keeps explicit Markdown links unchanged', () => {
    expect(autolinkUrls('[说明](https://example.com/path（说明）)')).toBe(
      '[说明](https://example.com/path（说明）)'
    )
  })

  it.each([
    '[https://cdn.example.com/file.pdf](https://cdn.example.com/file.pdf)',
    '[See https://example.com/docs](https://example.com/target)',
    '![https://example.com/image.jpeg](https://example.com/image.jpeg)',
    '[**https://example.com/docs**](https://example.com/target)',
    '[Label \\] https://example.com/docs](https://example.com/target)',
    '[Open `]` https://example.com/file.pdf](https://example.com/target)',
    '[![https://example.com/image.jpeg](https://example.com/image.jpeg)](https://example.com)',
  ])('does not autolink a URL inside an existing link or image label: %s', source => {
    expect(autolinkUrls(source)).toBe(source)
    expect(autolinkUrls(autolinkUrls(source))).toBe(source)
  })

  it('preserves existing links while autolinking adjacent bare URLs', () => {
    const existing = '[https://example.com/docs](https://example.com/target)'
    expect(autolinkUrls(`${existing} and https://example.com/other`)).toBe(
      `${existing} and [https://example.com/other](https://example.com/other)`
    )
  })

  it.each([
    '`https://example.com/code`',
    '```\nhttps://example.com/code\n```',
    '<https://example.com/autolink>',
    '<a href="https://example.com/page">Page</a>',
    '<img src="https://example.com/image.jpeg">',
    '[Guide](https://example.com/guide.pdf "Guide")',
  ])('preserves code, HTML, and ordinary explicit links: %s', source => {
    expect(autolinkUrls(source)).toBe(source)
  })

  it('still autolinks URLs in plain brackets and normal prose', () => {
    expect(autolinkUrls('[https://example.com/plain]')).toBe(
      '[[https://example.com/plain](https://example.com/plain)]'
    )
    expect(autolinkUrls('Read www.example.com/docs.')).toBe(
      'Read [www.example.com/docs](https://www.example.com/docs).'
    )
  })
})
