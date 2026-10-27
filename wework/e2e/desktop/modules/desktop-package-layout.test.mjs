import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveDesktopPackageLayout } from './desktop-package-layout.mjs'

test('separates the stable launcher from the selected Electron resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-layout-'))
  try {
    await writeFile(
      join(root, 'update-state.json'),
      JSON.stringify({
        schemaVersion: 2,
        active: { version: '0.6.0', path: 'versions/0.6.0-1234567890abcdef' },
      })
    )
    const layout = await resolveDesktopPackageLayout(join(root, 'WeWork.exe'), 'win32')
    assert.equal(layout.launchBinary, join(root, 'WeWork.exe'))
    assert.equal(
      layout.versionBinary,
      join(root, 'versions', '0.6.0-1234567890abcdef', 'WeWork.exe')
    )
    assert.equal(
      layout.resourcesRoot,
      join(root, 'versions', '0.6.0-1234567890abcdef', 'resources')
    )
    assert.equal(layout.installRoot, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects corrupt installation state instead of launching a different package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-layout-'))
  try {
    await writeFile(join(root, 'update-state.json'), '{broken json')
    await assert.rejects(
      resolveDesktopPackageLayout(join(root, 'WeWork.exe'), 'win32'),
      SyntaxError
    )
    await writeFile(
      join(root, 'update-state.json'),
      JSON.stringify({
        schemaVersion: 2,
        active: { path: 'versions/../../other' },
      })
    )
    await assert.rejects(
      resolveDesktopPackageLayout(join(root, 'WeWork.exe'), 'win32'),
      assert.AssertionError
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves an unopened package seed while preferring live state after first launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-layout-'))
  try {
    const seed = { schemaVersion: 2, active: { version: '0.6.0', path: 'versions/0.6.0-seed' } }
    await writeFile(join(root, 'initial-update-state.json'), JSON.stringify(seed))
    const initial = await resolveDesktopPackageLayout(join(root, 'WeWork.exe'), 'win32')
    assert.equal(initial.stateSource, 'initial-update-state.json')
    assert.equal(initial.state.active.version, '0.6.0')
    const live = { schemaVersion: 2, active: { version: '0.6.1', path: 'versions/0.6.1-active' } }
    await writeFile(join(root, 'update-state.json'), JSON.stringify(live))
    const current = await resolveDesktopPackageLayout(join(root, 'WeWork.exe'), 'win32')
    assert.equal(current.stateSource, 'update-state.json')
    assert.equal(current.state.active.version, '0.6.1')
    await writeFile(join(root, 'update-state.json'), '{broken')
    await assert.rejects(
      resolveDesktopPackageLayout(join(root, 'WeWork.exe'), 'win32'),
      SyntaxError
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps ordinary Linux application resources beside its executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-layout-'))
  try {
    const layout = await resolveDesktopPackageLayout(join(root, 'WeWork'), 'linux')
    assert.equal(layout.versionBinary, join(root, 'WeWork'))
    assert.equal(layout.resourcesRoot, join(root, 'resources'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
