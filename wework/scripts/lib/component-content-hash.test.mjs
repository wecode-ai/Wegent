import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const reads = vi.hoisted(() => ({ active: 0, peak: 0 }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    createReadStream: (...args) => {
      const stream = actual.createReadStream(...args)
      reads.active += 1
      reads.peak = Math.max(reads.peak, reads.active)
      stream.once('close', () => {
        reads.active -= 1
      })
      return stream
    },
  }
})

beforeEach(() => {
  reads.active = 0
  reads.peak = 0
})

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
  test('reads files concurrently with a bounded number of open streams and an unchanged digest', async () => {
    const root = await temporaryDirectory()
    const entries = Array.from({ length: 40 }, (_, index) => `${index}.txt`).sort((a, b) =>
      a.localeCompare(b)
    )
    await Promise.all(entries.map(name => writeFile(join(root, name), name)))
    const expected = createHash('sha256')
    for (const name of entries) expected.update(`file:${name}\0${sha256(name)}\0`)

    await expect(hashComponentPath(root)).resolves.toBe(expected.digest('hex'))
    expect(reads.peak).toBeGreaterThan(1)
    expect(reads.peak).toBeLessThanOrEqual(8)
    expect(reads.active).toBe(0)
  })

  test('rejects symbolic links instead of omitting unverified content', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'target'), 'content')
    await symlink(join(root, 'target'), join(root, 'link'))
    await expect(hashComponentPath(root)).rejects.toThrow('Unsupported component tree entry')
  })

  test('hashes a file by its bytes', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'component.bin')
    await writeFile(path, 'signed component')

    await expect(hashComponentPath(path)).resolves.toBe(sha256('signed component'))
  })

  test('hashes directory entries in stable path order', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'z.txt'), 'last')
    await writeFile(join(root, 'nested', 'a.txt'), 'first')

    const nestedHash = createHash('sha256')
      .update(`file:nested/a.txt\0${sha256('first')}\0`)
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
