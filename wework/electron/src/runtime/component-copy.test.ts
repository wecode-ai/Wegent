import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { hashComponentPath } from './component-content-hash.js'
import { copyComponentTree } from './component-copy.js'
import { copyComponentSnapshot } from './component-snapshot.js'

test('preserves runtime links, executable modes and checksums after removing the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-component-copy-'))
  const source = join(root, 'source')
  const target = join(root, 'cache')
  try {
    await mkdir(join(source, 'store'), { recursive: true })
    await writeFile(join(source, 'store', 'runtime.js'), 'runtime', { mode: 0o755 })
    await symlink('store/runtime.js', join(source, 'runtime.js'))
    const expected = await hashComponentPath(source)

    await copyComponentTree(source, target)
    await rm(source, { recursive: true })

    expect(await hashComponentPath(target)).toBe(expected)
    expect(await readFile(join(target, 'runtime.js'), 'utf8')).toBe('runtime')
    if (process.platform !== 'win32') {
      expect((await stat(join(target, 'store', 'runtime.js'))).mode & 0o777).toBe(0o755)
    }
  } finally {
    await chmod(root, 0o700)
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['file', 'directory'])(
  'retains the remote entry path for an existing %s component',
  async kind => {
    const root = await mkdtemp(join(tmpdir(), 'wework-component-entry-'))
    try {
      const source = join(root, 'source')
      if (kind === 'directory') {
        await mkdir(source)
        await writeFile(join(source, 'runtime.js'), 'runtime')
      } else await writeFile(source, 'runtime')
      const expected = await hashComponentPath(source)
      const snapshot = await copyComponentSnapshot(source, join(root, 'cache'), 'bin/runtime')
      await rm(source, { recursive: true })
      expect(snapshot).toEqual({ entryPath: 'bin/runtime', contentSha256: expected })
      expect(await hashComponentPath(join(root, 'cache', 'bin/runtime'))).toBe(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
