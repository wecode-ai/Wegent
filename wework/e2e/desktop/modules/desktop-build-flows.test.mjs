import assert from 'node:assert/strict'
import test from 'node:test'

import { codexTargetFor } from './desktop-build-flows.mjs'

test('maps every supported Codex E2E host', () => {
  assert.equal(codexTargetFor('darwin', 'arm64'), 'aarch64-apple-darwin')
  assert.equal(codexTargetFor('darwin', 'x64'), 'x86_64-apple-darwin')
  assert.equal(codexTargetFor('linux', 'arm64'), 'aarch64-unknown-linux-gnu')
  assert.equal(codexTargetFor('linux', 'x64'), 'x86_64-unknown-linux-gnu')
  assert.equal(codexTargetFor('win32', 'arm64'), 'aarch64-pc-windows-msvc')
  assert.equal(codexTargetFor('win32', 'x64'), 'x86_64-pc-windows-msvc')
})

test('rejects unsupported Codex E2E hosts', () => {
  assert.throws(
    () => codexTargetFor('win32', 'ia32'),
    /Unsupported Wework package target: win32-ia32/
  )
})
