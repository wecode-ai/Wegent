import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { publishImmutableDirectory } from './immutable-directory.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

test('preserves the publication error when cleanup also fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-immutable-errors-'))
  const publicationError = new Error('Archive extraction failed')
  const cleanupError = Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' })
  try {
    vi.mocked(rm).mockRejectedValueOnce(cleanupError)
    await expect(
      publishImmutableDirectory(join(root, 'runtime'), async () => {
        throw publicationError
      })
    ).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Archive extraction failed',
      cause: publicationError,
      errors: [publicationError, cleanupError],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
