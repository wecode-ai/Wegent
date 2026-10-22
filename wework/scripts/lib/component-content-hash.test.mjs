import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    readdir: async (...args) => (await actual.readdir(...args)).reverse(),
  }
})

import { hashComponentPath } from './component-content-hash.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('hashComponentPath', () => {
  test('rejects symbolic links instead of omitting unverified content', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'target'))
    await writeFile(join(root, 'target', 'content.txt'), 'content')
    await symlink(
      join(root, 'target'),
      join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(hashComponentPath(root)).rejects.toThrow('Unsupported component tree entry')
  })

  test('hashes a file by its bytes', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'component.bin')
    await writeFile(path, 'signed component')

    await expect(hashComponentPath(path)).resolves.toBe(sha256('signed component'))
  })

  test('preserves installed updater digests with native nested paths', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'z.txt'), 'last')
    await writeFile(join(root, 'nested', 'a.txt'), 'first')

    const nestedHash = createHash('sha256')
      .update(`file:${join('nested', 'a.txt')}\0${sha256('first')}\0`)
      .digest('hex')
    const expected = createHash('sha256')
      .update(`directory:nested\0${nestedHash}\0`)
      .update(`file:z.txt\0${sha256('last')}\0`)
      .digest('hex')

    await expect(hashComponentPath(root)).resolves.toBe(expected)
  })
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-component-hash-'))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}
