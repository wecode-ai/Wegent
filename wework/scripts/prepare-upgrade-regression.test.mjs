import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareRegressionPair, validateRegressionVersions } from './prepare-upgrade-regression.mjs'

test('regression versions are declared in advance and must describe a forward upgrade', () => {
  validateRegressionVersions('0.6.5', '0.6.6')
  validateRegressionVersions('1.1.0-beta.1', '1.1.0')
  for (const versions of [
    ['1.1.0', '1.1.0'],
    ['1.1.0', '1.0.0'],
    ['bad', '1.1.0'],
  ])
    assert.throws(() => validateRegressionVersions(...versions))
})

test('the regression consumer rejects changed producer bytes before extracting an application', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-regression-input-'))
  const platform = process.platform === 'darwin' ? 'macos' : 'windows'
  try {
    for (const [role, version] of [
      ['source', '1.0.0'],
      ['target', '1.1.0'],
    ]) {
      const directory = join(root, role)
      const name = `WeWorkRelease_${version}_${platform}_${process.arch}.tar.gz`
      await mkdir(directory)
      await writeFile(join(directory, name), 'changed')
      await writeFile(
        join(directory, 'release.json'),
        JSON.stringify({
          fixture: true,
          version,
          platform,
          arch: process.arch,
          name,
          sourceSha: 'a'.repeat(40),
          sha256: 'b'.repeat(64),
          bytes: 7,
        })
      )
    }
    await assert.rejects(
      prepareRegressionPair(join(root, 'source'), join(root, 'target'), join(root, 'pair')),
      /checksum changed/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
