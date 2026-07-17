// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isAssetVersionError } from '@/features/common/ErrorBoundary'

describe('isAssetVersionError', () => {
  it('recognizes webpack runtime and chunk version mismatches', () => {
    const webpackError = new TypeError("Cannot read properties of undefined (reading 'call')")
    webpackError.stack = 'at options.factory\nat __webpack_require__'

    expect(isAssetVersionError(webpackError)).toBe(true)
    expect(isAssetVersionError(new Error('ChunkLoadError: Loading chunk 123 failed'))).toBe(true)
  })

  it('does not treat application errors as asset version mismatches', () => {
    expect(
      isAssetVersionError(new TypeError("Cannot read properties of undefined (reading 'id')"))
    ).toBe(false)
  })
})
