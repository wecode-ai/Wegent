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

test('Windows copies nested plugin trees without dropping entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-managed-copy-'))
  try {
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    for (let directory = 0; directory < 8; directory += 1) {
      await mkdir(join(source, `dir-${directory}`), { recursive: true })
      for (let file = 0; file < 16; file += 1) {
        await writeFile(join(source, `dir-${directory}`, `file-${file}.js`), `${directory}-${file}`)
      }
    }

    await copyManagedPlugin(source, destination, { platform: 'win32' })

    for (let directory = 0; directory < 8; directory += 1) {
      for (let file = 0; file < 16; file += 1) {
        assert.equal(
          await readFile(join(destination, `dir-${directory}`, `file-${file}.js`), 'utf8'),
          `${directory}-${file}`
        )
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
