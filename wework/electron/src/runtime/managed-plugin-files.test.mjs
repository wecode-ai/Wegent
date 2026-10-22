import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyManagedPlugin } from './managed-plugin-files.ts'

test('Windows package cleanup preserves composed and packaged assets beyond MAX_PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-owned-assets-'))
  try {
    let source = root
    for (let index = 0; index < 5; index++) source = join(source, 'component-source-'.repeat(4))
    const assets = join(root, 'packaged-assets')
    const composed = join(root, 'composed')
    const destination = join(root, 'managed-package')
    await mkdir(join(source, 'web'), { recursive: true })
    await mkdir(assets)
    const contents = 'window.wework = true\n'
    await writeFile(join(assets, 'index.js'), contents)
    await symlink(
      assets,
      join(source, 'web/assets'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    assert.ok(source.length > 260)

    await copyManagedPlugin(source, composed, { platform: 'win32' })
    await copyManagedPlugin(composed, destination, { platform: 'win32' })

    const copiedAssets = join(destination, 'web/assets')
    const composedAssets = join(composed, 'web/assets')
    for (const path of [copiedAssets, composedAssets]) {
      assert.equal((await lstat(path)).isSymbolicLink(), false)
      assert.notEqual(await realpath(path), await realpath(assets))
      assert.equal(await readFile(join(path, 'index.js'), 'utf8'), contents)
    }
    await rm(copiedAssets, { recursive: true })
    assert.equal(await readFile(join(composedAssets, 'index.js'), 'utf8'), contents)
    await rm(composedAssets, { recursive: true })
    assert.equal(await readFile(join(assets, 'index.js'), 'utf8'), contents)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
