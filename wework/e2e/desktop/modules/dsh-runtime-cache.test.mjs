import assert from 'node:assert/strict'
import test from 'node:test'

import { legacyDshRuntimeIsPublished } from './dsh-runtime-cache.mjs'

test('legacy DSH runtimes are required everywhere except first Windows arm64 release', () => {
  assert.equal(legacyDshRuntimeIsPublished('win32', 'x64'), true)
  assert.equal(legacyDshRuntimeIsPublished('darwin', 'arm64'), true)
  assert.equal(legacyDshRuntimeIsPublished('darwin', 'x64'), true)
  assert.equal(legacyDshRuntimeIsPublished('linux', 'x64'), true)
  assert.equal(legacyDshRuntimeIsPublished('win32', 'arm64'), false)
})
