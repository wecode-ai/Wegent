// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const nextConfig = require('../next.config.js')
const bundledWebpack = require('next/dist/compiled/webpack/webpack')
bundledWebpack.init()
const webpack = bundledWebpack.webpack
const { JSDOM } = createRequire(require.resolve('jest-environment-jsdom'))('jsdom')
const presetRequire = createRequire(require.resolve('@file-viewer/preset-office'))
const pdfRequire = createRequire(presetRequire.resolve('@file-viewer/renderer-pdf'))
const context = fileURLToPath(new URL('..', import.meta.url))
const bundles = {}

function configure(config, overrides = {}) {
  return nextConfig.webpack(config, { isServer: false, dev: true, ...overrides })
}

before(async () => {
  const outputPath = await mkdtemp(path.join(tmpdir(), 'wegent-pdfjs-webpack-'))
  const config = configure({
    mode: 'development',
    context,
    target: 'web',
    devtool: 'eval-source-map',
    entry: {
      pdf: pdfRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
      viewer: pdfRequire.resolve('pdfjs-dist/legacy/web/pdf_viewer.mjs'),
      ordinary: 'data:text/javascript,export const value = 42',
    },
    output: {
      path: outputPath,
      filename: '[name].js',
      library: { type: 'var', name: '[name]' },
    },
    resolve: {},
    optimization: { minimize: false },
    plugins: [],
  })
  const compiler = webpack(config)
  try {
    await new Promise((resolve, reject) => {
      compiler.run((error, stats) => {
        if (error) return reject(error)
        if (stats.hasErrors())
          return reject(new Error(stats.toString({ all: false, errors: true })))
        resolve()
      })
    })
    for (const name of Object.keys(config.entry)) {
      bundles[name] = await readFile(path.join(outputPath, `${name}.js`), 'utf8')
    }
  } finally {
    await new Promise((resolve, reject) =>
      compiler.close(error => (error ? reject(error) : resolve()))
    )
    await rm(outputPath, { recursive: true, force: true })
  }
})

function withWindow(check) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  Object.assign(dom.window, {
    DOMMatrix: class DOMMatrix {},
    TextDecoder,
    TextEncoder,
    structuredClone,
  })
  try {
    check(dom.window)
  } finally {
    dom.window.close()
  }
}

test('initializes the real PDF.js API in an eval-based development bundle', () => {
  withWindow(window => {
    window.eval(bundles.pdf)
    assert.equal(typeof window.pdf.getDocument, 'function')
    assert.equal(typeof window.pdf.PDFWorker, 'function')
  })
})

test('initializes the real PDF.js viewer after its API', () => {
  withWindow(window => {
    window.eval(bundles.pdf)
    window.eval(bundles.viewer)
    assert.equal(typeof window.viewer.PDFViewer, 'function')
  })
})

test('preserves ordinary modules and the development source-map mode', () => {
  withWindow(window => {
    window.eval(bundles.ordinary)
    assert.equal(window.ordinary.value, 42)
    assert.match(bundles.ordinary, /eval\(/)
    assert.doesNotMatch(bundles.ordinary, /__pdfjs_module_exports__/)
  })
  const config = configure({
    resolve: {},
    optimization: {},
    plugins: [],
    devtool: 'eval-source-map',
  })
  assert.equal(config.devtool, 'eval-source-map')
})

test('does not install the PDF.js development fix in server or production builds', () => {
  for (const options of [{ isServer: true }, { dev: false }, { isServer: true, dev: false }]) {
    const plugins = []
    const config = configure({ resolve: {}, optimization: {}, plugins }, options)
    assert.deepEqual(config.plugins, [])
  }
})
