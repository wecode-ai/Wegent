import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { updateHashWithFileState } from './dev-cache-fingerprint.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
  )
})

async function fileStateDigest(pathname) {
  const hash = createHash('sha256')
  await updateHashWithFileState(hash, pathname)
  return hash.digest('hex')
}

describe('updateHashWithFileState', () => {
  test('distinguishes a deleted file from a present file containing the deletion marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-cache-fingerprint-'))
    temporaryDirectories.push(directory)
    const pathname = join(directory, 'source.ts')

    const deletedDigest = await fileStateDigest(pathname)
    await writeFile(pathname, '<deleted>')
    const presentDigest = await fileStateDigest(pathname)

    expect(presentDigest).not.toBe(deletedDigest)
  })
})
