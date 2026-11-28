import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { portableDesktopRelease } from './lib/portable-desktop-release.mjs'
import { createPortableReleaseArchive } from './lib/portable-release-archive.mjs'
import { decodeReleaseBlocks } from '../electron/src/runtime/release-block-map.mjs'

test('an insertion preserves most later compressed blocks of a large file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-portable-insertion-'))
  try {
    const content = Buffer.alloc(2 * 1024 * 1024)
    for (let offset = 0; offset < content.length; offset += 32) {
      createHash('sha256').update(String(offset)).digest().copy(content, offset)
    }
    const input = join(root, 'payload')
    await writeFile(input, content)
    const old = await createPortableReleaseArchive(root, join(root, 'before.tar.gz'), ['payload'])
    await writeFile(
      input,
      Buffer.concat([
        content.subarray(0, 100_000),
        Buffer.from('insertion'),
        content.subarray(100_000),
      ])
    )
    const next = await createPortableReleaseArchive(root, join(root, 'after.tar.gz'), ['payload'])
    const oldHashes = new Set(old.blocks.map(([, hash]) => hash))
    const retainedBytes = next.blocks.reduce(
      (sum, [bytes, hash]) => sum + (oldHashes.has(hash) ? bytes : 0),
      0
    )
    assert.ok(retainedBytes >= next.bytes * 0.75, `Reused ${retainedBytes} of ${next.bytes} bytes`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('outer release blocks retain unchanged files inside a bundled component archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-portable-component-blocks-'))
  try {
    const source = join(root, 'source')
    const install = join(root, 'install')
    await mkdir(source)
    await mkdir(install)
    const names = ['first', 'second', 'third']
    for (const name of names) await writeFile(join(source, name), name.repeat(12_000))
    const component = 'wework-core-plugins.tar.gz'
    const bundle = join(install, component)
    await createPortableReleaseArchive(source, bundle, names, { component: true })
    const old = await createPortableReleaseArchive(install, join(root, 'old.tar.gz'), [component])
    await writeFile(join(source, 'second'), 'updated second'.repeat(8_000))
    await createPortableReleaseArchive(source, bundle, names, { component: true })
    const next = await createPortableReleaseArchive(install, join(root, 'next.tar.gz'), [component])
    const oldHashes = new Set(old.blocks.map(([, hash]) => hash))
    assert.ok(next.blocks.filter(([, hash]) => oldHashes.has(hash)).length >= 4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('publishes the packaged data compatibility without inferring older readable schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-portable-test-'))
  try {
    const appRoot = join(root, 'app')
    await mkdir(join(appRoot, 'resources'), { recursive: true })
    await writeFile(join(appRoot, 'WeWork.exe'), 'unit fixture')
    const sharedResource = Buffer.alloc(5 * 1024 * 1024, 37)
    await writeFile(join(appRoot, 'resources', 'shared.bin'), sharedResource)
    await writeFile(
      join(appRoot, 'resources', 'components.json'),
      JSON.stringify({
        appVersion: '1.1.0',
        sourceSha: 'a'.repeat(40),
        dataSchema: 2,
        readableDataSchemas: [2],
        afterStopPreparation: 1,
        teamAssignmentProtocol: 1,
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
    assert.equal(release.afterStopPreparation, 1)
    assert.equal(release.teamAssignmentProtocol, 1)
    assert.deepEqual(release.readableDataSchemas, [2])
    assert.match(release.sha256, /^[a-f0-9]{64}$/)
    const archive = await readFile(release.path)
    const index = await readFile(`${release.path}.blocks`)
    const blocks = decodeReleaseBlocks(index, release.blockMap, release.bytes)
    let offset = 0
    for (const [bytes, hash] of blocks) {
      assert.equal(
        createHash('sha256')
          .update(archive.subarray(offset, offset + bytes))
          .digest('hex'),
        hash
      )
      offset += bytes
    }
    assert.equal(offset, archive.length)
    assert.ok(blocks.length >= 4)
    // GNU tar unquotes backslashes in -C operands, including Windows \\results.
    const extracted = join(
      root,
      process.platform === 'win32' ? 'results' : 'backslash\\results',
      'extracted'
    )
    await mkdir(extracted, { recursive: true })
    // Artifact-only CI runners must extract without workspace node_modules.
    const standalone = join(root, 'extract-runtime-archive.mjs')
    await copyFile(new URL('./lib/extract-runtime-archive.mjs', import.meta.url), standalone)
    const extract = archive =>
      promisify(execFile)(process.execPath, [
        '--input-type=module',
        '--eval',
        'const { extractRuntimeArchive } = await import(process.argv[1]); await extractRuntimeArchive(process.argv[2], process.argv[3])',
        pathToFileURL(standalone).href,
        archive,
        extracted,
      ])
    await extract(release.path)
    assert.deepEqual(
      await readFile(join(extracted, 'application/resources/shared.bin')),
      sharedResource
    )
    assert.equal(
      JSON.parse(await readFile(join(extracted, 'wework-release.json'), 'utf8'))
        .afterStopPreparation,
      1
    )
    assert.equal(
      await readFile(join(extracted, 'application', 'WeWork.exe'), 'utf8'),
      'unit fixture'
    )
    const corrupt = join(root, 'corrupt.tar.gz')
    await writeFile(corrupt, 'not a gzip archive')
    await assert.rejects(extract(corrupt), error => {
      assert.match(error.stderr, /tar|gzip/i)
      return true
    })
    await assert.rejects(extract(join(root, 'missing.tar.gz')), error => {
      assert.match(error.stderr, /ENOENT/)
      return true
    })
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
