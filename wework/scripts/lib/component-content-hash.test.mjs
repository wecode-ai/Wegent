import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { hashComponentPath } from './component-content-hash.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('hashComponentPath', () => {
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
