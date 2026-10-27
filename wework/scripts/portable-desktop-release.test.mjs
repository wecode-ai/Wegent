import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { portableDesktopRelease } from './lib/portable-desktop-release.mjs'

test('publishes the packaged data compatibility without inferring older readable schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-portable-test-'))
  try {
    const appRoot = join(root, 'app')
    await mkdir(join(appRoot, 'resources'), { recursive: true })
    await writeFile(join(appRoot, 'WeWork.exe'), 'unit fixture')
    await writeFile(
      join(appRoot, 'resources', 'components.json'),
      JSON.stringify({
        appVersion: '1.1.0',
        sourceSha: 'a'.repeat(40),
        dataSchema: 2,
        readableDataSchemas: [2],
      })
    )
    const release = await portableDesktopRelease({
      appRoot,
      version: '1.1.0',
      platform: 'windows',
      arch: 'x64',
      output: join(root, 'output'),
    })
    assert.equal(release.dataSchema, 2)
    assert.deepEqual(release.readableDataSchemas, [2])
    assert.match(release.sha256, /^[a-f0-9]{64}$/)
    await assert.rejects(
      portableDesktopRelease({
        appRoot,
        version: '1.2.0',
        platform: 'windows',
        arch: 'x64',
        output: join(root, 'output'),
      }),
      /version does not match/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
