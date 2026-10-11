import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { hashComponentPath } from './component-content-hash.js'
import { copyComponentTree } from './component-copy.js'

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
