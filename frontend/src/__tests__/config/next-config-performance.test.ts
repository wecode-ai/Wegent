// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

describe('Next.js production chunking configuration', () => {
  const originalTurbopack = process.env.TURBOPACK

  beforeEach(() => {
    jest.resetModules()
    delete process.env.TURBOPACK
  })

  afterEach(() => {
    if (originalTurbopack === undefined) {
      delete process.env.TURBOPACK
    } else {
      process.env.TURBOPACK = originalTurbopack
    }
  })

  test('does not force all node_modules into a single initial vendors chunk', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nextConfig = require('../../../next.config.js')
    const webpackConfig = {
      resolve: { alias: {} },
      optimization: {
        splitChunks: {
          cacheGroups: {},
        },
      },
    }

    const result = nextConfig.webpack(webpackConfig, {
      isServer: false,
      _dev: false,
    })

    expect(result.optimization.splitChunks.cacheGroups.vendor).toBeUndefined()
    expect(result.optimization.splitChunks.cacheGroups.common).toBeUndefined()
  })
})
