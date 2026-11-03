import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { resolveDesktopCodexBinary } from './desktop-build-flows.mjs'

test('resolves the per-run coding CLI instead of inheriting another run configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-codex-selection-'))
  const inherited = process.env.WEWORK_E2E_CODEX_BIN
  process.env.WEWORK_E2E_CODEX_BIN = join(root, 'unrelated-codex')
  try {
    assert.equal(
      await resolveDesktopCodexBinary({ WEWORK_E2E_CODEX_BIN: process.execPath }),
      resolve(process.execPath)
    )
  } finally {
    if (inherited === undefined) delete process.env.WEWORK_E2E_CODEX_BIN
    else process.env.WEWORK_E2E_CODEX_BIN = inherited
    await rm(root, { recursive: true, force: true })
  }
})
