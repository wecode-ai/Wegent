import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { resolveCoreProfileCompositionAssets } from '../e2e/desktop/modules/core-profile-assets.mjs'

test('checks assets from the profile-selected publication among backing trees and older versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-profile-assets-'))
  try {
    const profile = join(root, 'dsh-core', 'profiles', 'wework-core')
    const publications = join(root, 'managed-components', 'composed', 'wework-core-plugins')
    const currentFingerprint = 'b'.repeat(64)
    const oldFingerprint = 'a'.repeat(64)
    const current = join(publications, '.content-current')
    const old = join(publications, '.content-old')
    const relativeAssets = join('wework-app', 'web', 'assets')
    await mkdir(profile, { recursive: true })
    for (const [content, fingerprint, text] of [
      [current, currentFingerprint, 'current renderer'],
      [old, oldFingerprint, 'obsolete renderer'],
    ]) {
      await mkdir(join(content, relativeAssets), { recursive: true })
      await writeFile(join(content, relativeAssets, 'renderer.js'), text)
      await symlink(
        content,
        join(publications, fingerprint),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    await writeFile(
      join(profile, '.wework-runtime.json'),
      JSON.stringify({ corePluginsFingerprint: currentFingerprint })
    )

    const assets = await resolveCoreProfileCompositionAssets(root, 'wework-core')

    assert.equal(await realpath(assets), await realpath(join(current, relativeAssets)))
    assert.equal(await readFile(join(assets, 'renderer.js'), 'utf8'), 'current renderer')
    assert.equal(assets, join(publications, currentFingerprint, relativeAssets))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a profile stamp that does not identify a Core composition fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-profile-assets-'))
  try {
    const profile = join(root, 'dsh-core', 'profiles', 'wework-core')
    await mkdir(profile, { recursive: true })
    await writeFile(
      join(profile, '.wework-runtime.json'),
      JSON.stringify({ corePluginsFingerprint: '../.content-old' })
    )
    await assert.rejects(resolveCoreProfileCompositionAssets(root, 'wework-core'), {
      code: 'ERR_ASSERTION',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
