import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { portableDesktopRelease } from './lib/portable-desktop-release.mjs'
import {
  downloadPublishedDesktopArchive,
  downloadPublishedDesktopRelease,
  readDesktopReleaseInstallation,
  readPrebuiltDesktopRelease,
} from './lib/published-desktop-release.mjs'

async function fixture(run, afterStopPreparation) {
  const root = await mkdtemp(join(tmpdir(), 'wework-published-release-'))
  try {
    const appRoot = join(root, 'built')
    await mkdir(join(appRoot, 'resources/bin'), { recursive: true })
    await mkdir(join(appRoot, 'resources/codex/vendor/x86_64-pc-windows-msvc/bin'), {
      recursive: true,
    })
    await writeFile(
      join(appRoot, 'resources/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),
      'delivered codex bytes'
    )
    await writeFile(join(appRoot, 'WeWork.exe'), 'delivered desktop bytes')
    await writeFile(join(appRoot, 'resources/bin/wegent-executor.exe'), 'delivered executor bytes')
    await writeFile(
      join(appRoot, 'resources/components.json'),
      JSON.stringify({
        appVersion: '1.0.0',
        sourceSha: 'a'.repeat(40),
        dataSchema: 1,
        readableDataSchemas: [1],
        afterStopPreparation,
      })
    )
    const release = await portableDesktopRelease({
      appRoot,
      version: '1.0.0',
      platform: 'windows',
      arch: 'x64',
      output: join(root, 'published'),
    })
    const requests = []
    const download = async (repository, tag, name, path) => {
      requests.push({ repository, tag, name })
      if (name.endsWith('.json')) await writeFile(path, JSON.stringify(release))
      else await copyFile(release.path, path)
    }
    await run({
      root,
      release,
      requests,
      options: {
        repository: 'wecode-ai/Wegent',
        version: release.version,
        platform: release.platform,
        arch: release.arch,
        directory: join(root, 'consumer'),
        download,
      },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('downloads a published target unchanged without extracting or packaging it', () =>
  fixture(async ({ options, release }) => {
    const target = await downloadPublishedDesktopArchive(options)
    assert.equal(target.sha256, release.sha256)
    assert.deepEqual(await readFile(target.path), await readFile(release.path))
    assert.deepEqual(
      (await readdir(options.directory)).sort(),
      [release.name, 'release-windows-x64.json'].sort()
    )
  }))

test('a stopped-preparation capability is bound to the immutable package, not a caller claim', () =>
  fixture(async ({ options, release }) => {
    assert.equal(release.afterStopPreparation, 1)
    await downloadPublishedDesktopRelease(options)
    await assert.rejects(
      readDesktopReleaseInstallation(join(options.directory, 'source'), {
        ...release,
        afterStopPreparation: undefined,
      }),
      /does not match/
    )
  }, 1))

test('reads unchanged producer artifacts and rejects corrupt bytes or a different identity', () =>
  fixture(async ({ root, release, requests }) => {
    await writeFile(join(root, 'published/release-windows-x64.json'), JSON.stringify(release))
    const selection = {
      directory: join(root, 'published'),
      version: release.version,
      platform: release.platform,
      arch: release.arch,
      installation: join(root, 'isolated/source'),
    }
    const source = await readPrebuiltDesktopRelease(selection)
    assert.equal(source.sha256, release.sha256)
    assert.equal(await readFile(source.executable, 'utf8'), 'delivered desktop bytes')
    assert.deepEqual(await readFile(source.path), await readFile(release.path))
    assert.deepEqual(requests, [])
    await assert.rejects(
      readPrebuiltDesktopRelease({ ...selection, version: '2.0.0' }),
      /identity is invalid/
    )
    await writeFile(source.path, 'corrupted archive')
    await assert.rejects(readPrebuiltDesktopRelease(selection), /archive changed/)
    assert.deepEqual(requests, [])
  }))

test('downloads immutable delivered bytes and reuses the verified source without packaging it', () =>
  fixture(async ({ options, release, requests }) => {
    const first = await downloadPublishedDesktopRelease({ ...options, expected: release })
    assert.equal(await readFile(first.executable, 'utf8'), 'delivered desktop bytes')
    assert.equal(await readFile(first.executor, 'utf8'), 'delivered executor bytes')
    assert.equal(await readFile(first.codex, 'utf8'), 'delivered codex bytes')
    assert.equal(first.sha256, release.sha256)
    assert.equal(first.fixture, false)
    assert.equal(first.resources, await realpath(first.resources))
    assert.equal(first.executable, await realpath(first.executable))
    const second = await downloadPublishedDesktopRelease(options)
    assert.deepEqual(second, first)
    assert.deepEqual(
      requests.map(item => item.name),
      ['release-windows-x64.json', release.name]
    )
    assert.ok(
      requests.every(item => item.repository === 'wecode-ai/Wegent' && item.tag === 'wework-v1.0.0')
    )
  }))

test('rejects a changed published archive before extracting or accepting it into the cache', () =>
  fixture(async ({ options, root }) => {
    const download = options.download
    await assert.rejects(
      downloadPublishedDesktopRelease({
        ...options,
        download: async (...args) => {
          await download(...args)
          if (args[2].endsWith('.tar.gz')) await writeFile(args[3], 'changed publication')
        },
      }),
      /immutable published desktop archive changed/
    )
    const files = await readdir(join(root, 'consumer'))
    assert.deepEqual(files, ['release-windows-x64.json'])
  }))

test('rejects a source that differs from the authored package hash', () =>
  fixture(async ({ options, release, requests }) => {
    await assert.rejects(
      downloadPublishedDesktopRelease({
        ...options,
        expected: { ...release, sha256: 'b'.repeat(64) },
      }),
      /historical source package changed/
    )
    assert.equal(requests.length, 1)
  }))

test('does not accept a newly built fixture as a historical published source', () =>
  fixture(async ({ options, release }) => {
    release.fixture = true
    await assert.rejects(downloadPublishedDesktopRelease(options), /release identity is invalid/)
  }))

test('upgrade runner fails before any build when its producer artifact is missing', async () => {
  const environment = { ...process.env }
  const resultRoot = await mkdtemp(join(tmpdir(), 'wework-prebuilt-validation-'))
  environment.WEWORK_E2E_RESULT_ROOT = resultRoot
  for (const name of ['WEWORK_E2E_UPGRADE_PAIR', 'WEWORK_E2E_APP_BIN', 'WEWORK_E2E_EXECUTOR_BIN'])
    delete environment[name]
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('../e2e/desktop/run-checkpoints.mjs', import.meta.url)),
          '--segment',
          'app-rollback',
        ],
        { env: environment, timeout: 10_000 }
      ),
      error => {
        assert.match(error.stderr, /prebuilt source\/target pair/)
        assert.doesNotMatch(error.stdout, /build started|cargo build|prepare:package/)
        return true
      }
    )
  } finally {
    await rm(resultRoot, { recursive: true, force: true })
  }
})
