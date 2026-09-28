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
})
