import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
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
      output: join(root, process.platform === 'win32' ? 'output' : 'local:output'),
    })
    assert.equal(release.dataSchema, 2)
    assert.deepEqual(release.readableDataSchemas, [2])
    assert.match(release.sha256, /^[a-f0-9]{64}$/)
    const extracted = join(root, 'extracted')
    await mkdir(extracted)
    // Artifact-only CI runners must extract without workspace node_modules.
    const standalone = join(root, 'extract-runtime-archive.mjs')
    await copyFile(new URL('./lib/extract-runtime-archive.mjs', import.meta.url), standalone)
    await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      'const { extractRuntimeArchive } = await import(process.argv[1]); await extractRuntimeArchive(process.argv[2], process.argv[3])',
      pathToFileURL(standalone).href,
      release.path,
      extracted,
    ])
    assert.equal(
      await readFile(join(extracted, 'application', 'WeWork.exe'), 'utf8'),
      'unit fixture'
    )
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
