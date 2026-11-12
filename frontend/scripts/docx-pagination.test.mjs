// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createPaginationDocx } from '../e2e/utils/docx-pagination-fixture.mjs'
import { resolveDocxEngine, resolveFileViewerVersion } from './file-viewer-version.mjs'

const require = createRequire(import.meta.url)
const presetRequire = createRequire(require.resolve('@file-viewer/preset-office'))
const wordRequire = createRequire(presetRequire.resolve('@file-viewer/renderer-word'))
const { parseAsync } = wordRequire('@file-viewer/docx')
const jestRequire = createRequire(require.resolve('jest-environment-jsdom'))
const { JSDOM } = jestRequire('jsdom')
const { window } = new JSDOM('')
globalThis.DOMParser = window.DOMParser

function drawings(element) {
  return [
    ...(element.type === 'drawing' ? [element] : []),
    ...(element.children ?? []).flatMap(drawings),
  ]
}

test('wrapNone distances do not displace floating shapes or their following text', async () => {
  const document = await parseAsync(await createPaginationDocx(), { useWorker: false })
  const [shape] = drawings(document.documentPart.body)

  assert.equal(shape.props.anchorPosition.wrapType, 'wrapNone')
  assert.equal(shape.cssStyle['margin-top'] ?? '0.00pt', '0.00pt')
  assert.equal(shape.cssStyle['margin-bottom'], '1.50pt')
  assert.equal(shape.cssStyle.top, '20.50pt')
  assert.equal(shape.cssStyle.width, '60.00pt')
})

test('wrapSquare keeps authored text distance and drawing effect extents', async () => {
  // Alignment keeps CSS margins attributable to wrapping, rather than to
  // explicit drawing coordinates (which newer engines also resolve correctly).
  const bytes = await createPaginationDocx({
    wrapType: 'wrapSquare',
    distance: '114300',
    positioned: false,
  })
  const document = await parseAsync(bytes, { useWorker: false })
  const [shape] = drawings(document.documentPart.body)

  assert.equal(shape.props.anchorPosition.wrapType, 'wrapSquare')
  assert.equal(shape.cssStyle['margin-top'], '9.00pt')
  assert.equal(shape.cssStyle['margin-left'], '9.00pt')
  assert.equal(shape.cssStyle['margin-right'], '9.00pt')
  assert.match(shape.cssStyle['margin-bottom'], /1\.50pt/)
  assert.match(shape.cssStyle['margin-bottom'], /9\.00pt/)
})

test('the deployed Worker matches the engine used by the Office renderer', async () => {
  const { version } = await resolveFileViewerVersion()
  const { version: engineVersion, jsZipPath } = await resolveDocxEngine()
  const assetBase = `${version}-office-pdf-v3`
  const worker = path.resolve(
    fileURLToPath(new URL('../public/file-viewer/', import.meta.url)),
    assetBase,
    `vendor/docx/${engineVersion}/docx.worker.js`
  )

  assert.deepEqual(
    await readFile(worker),
    await readFile(wordRequire.resolve('@file-viewer/docx/worker'))
  )
  assert.deepEqual(
    await readFile(path.join(path.dirname(worker), 'jszip.min.js')),
    await readFile(jsZipPath)
  )
})
