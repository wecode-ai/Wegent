import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { publishImmutableDirectory } from './immutable-directory.js'

test.each([false, true])('publishes long component paths with failure=%s', async failure => {
  const root = await mkdtemp(join(tmpdir(), 'wework-immutable-'))
  try {
    let parent = root
    while (parent.length < 300) parent = join(parent, 'managed-component-publication')
    const target = join(parent, 'component-hash')
    const publish = publishImmutableDirectory(target, async content => {
      await mkdir(join(content, 'web'))
      await writeFile(join(content, 'web', 'index.js'), 'verified component')
      if (failure) throw new Error('Incomplete component')
      await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    if (failure) {
      await expect(publish).rejects.toThrow('Incomplete component')
      expect(await readdir(dirname(target))).toEqual([])
      return
    }
    expect(await publish).toBe(target)
    expect(await readFile(join(target, 'web', 'index.js'), 'utf8')).toBe('verified component')
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    expect(
      await publishImmutableDirectory(target, async () => {
        throw new Error('Completed components must not be repopulated')
      })
    ).toBe(target)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
