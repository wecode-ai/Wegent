// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FILE_VIEWER_PACKAGES,
  resolveFileViewerVersion,
  validateFileViewerVersions,
} from './file-viewer-version.mjs'

const VERSION = '2.1.27'

function createValidInput() {
  const manifest = { dependencies: {}, devDependencies: {} }
  const installedVersions = {}

  for (const { name, section } of FILE_VIEWER_PACKAGES) {
    manifest[section][name] = VERSION
    installedVersions[name] = VERSION
  }

  return {
    manifest,
    installedVersions,
  }
}

test('accepts matching exact File Viewer package versions', () => {
  assert.deepEqual(validateFileViewerVersions(createValidInput()), {
    version: VERSION,
  })
})

test('resolves the frontend manifest and installed packages to the same version', async () => {
  assert.deepEqual(await resolveFileViewerVersion(), { version: VERSION })
})

test('rejects a runtime package that differs from the asset version', () => {
  const input = createValidInput()
  input.manifest.dependencies['@file-viewer/react'] = '2.1.26'
  input.installedVersions['@file-viewer/react'] = '2.1.26'

  assert.throws(
    () => validateFileViewerVersions(input),
    /package\.json versions differ:.*@file-viewer\/react=2\.1\.26/
  )
})

test('rejects ranges and stale installed packages', () => {
  const input = createValidInput()
  input.manifest.dependencies['@file-viewer/preset-office'] = '^2.1.27'
  input.installedVersions['file-viewer-copy-assets'] = '2.1.26'

  assert.throws(
    () => validateFileViewerVersions(input),
    error => {
      assert.match(error.message, /must declare an exact version/)
      assert.match(error.message, /file-viewer-copy-assets: installed=2\.1\.26/)
      return true
    }
  )
})
