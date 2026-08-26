import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createZipFixture,
  extractSingleRootZipFixture,
} from '../e2e/desktop/modules/zip-fixtures.mjs'

const temporaryDirectories = []

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-zip-fixture-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('desktop ZIP fixtures', () => {
  it('creates and extracts a single-root archive without workspace dependencies', async () => {
    const root = await createTemporaryDirectory()
    const archivePath = join(root, 'fixture.zip')
    const targetPath = join(root, 'extracted')

    await createZipFixture(archivePath, {
      'fixture/PLUGIN.md': '# fixture\n',
      'fixture/nested/value.txt': 'value\n',
    })
    await extractSingleRootZipFixture(archivePath, targetPath)

    await expect(readFile(join(targetPath, 'PLUGIN.md'), 'utf8')).resolves.toBe('# fixture\n')
    await expect(readFile(join(targetPath, 'nested/value.txt'), 'utf8')).resolves.toBe('value\n')
  })

  it('rejects archives without one directory root', async () => {
    const root = await createTemporaryDirectory()
    const archivePath = join(root, 'fixture.zip')

    await createZipFixture(archivePath, {
      'first.txt': 'first\n',
      'second.txt': 'second\n',
    })

    await expect(extractSingleRootZipFixture(archivePath, join(root, 'extracted'))).rejects.toThrow(
      'ZIP fixture must contain exactly one root entry'
    )
  })
})
