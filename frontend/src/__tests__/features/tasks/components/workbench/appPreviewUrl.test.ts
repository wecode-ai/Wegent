// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { safeAppPreviewUrl } from '@/features/tasks/components/workbench/appPreviewUrl'

describe('safeAppPreviewUrl', () => {
  it.each([['https://preview.example.test/app?path=/demo'], ['  http://127.0.0.1:3000/app  ']])(
    'normalizes and accepts an absolute web URL (%s)',
    url => {
      expect(safeAppPreviewUrl(url)).toBe(url.trim())
    }
  )

  it.each([
    ['javascript:alert(document.cookie)'],
    ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
    ['/api/session'],
    ['preview.example.test'],
    [''],
    [null],
    [undefined],
  ])('rejects a URL that is not absolute HTTP or HTTPS (%s)', url => {
    expect(safeAppPreviewUrl(url)).toBeNull()
  })
})
