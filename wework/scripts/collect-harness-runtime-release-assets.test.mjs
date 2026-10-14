import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { create } from 'tar'

import { collectHarnessRuntimeReleaseAssets } from './collect-harness-runtime-release-assets.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('collects immutable Harness Runtime archives and descriptors from standalone assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-harness-runtime-assets-'))
  roots.push(root)
  const input = join(root, 'release-assets')
  const output = join(root, 'shared-assets')
  await mkdir(input)
  const assetName = 'harness-runtime-macos-arm64-dsh-0.1.0-rc.8-fingerprint.tar.gz'
  const asset = Buffer.from('immutable runtime')
  await writeFile(join(input, assetName), asset)
  const descriptor = {
    dshVersion: '0.1.0-rc.8',
    role: 'workbench',
    bundled: false,
    sourceFingerprint: 'a'.repeat(64),
    archiveSha256: createHash('sha256').update(asset).digest('hex'),
    archiveBytes: asset.length,
    downloadUrl: `https://updates.example/${assetName}`,
    assetName,
  }
  await writeFile(join(input, assetName.replace(/\.tar\.gz$/, '.json')), JSON.stringify(descriptor))

  await collectHarnessRuntimeReleaseAssets(input, output, { runtimes: [descriptor] })
  await collectHarnessRuntimeReleaseAssets(input, output)

  await expect(readFile(join(output, assetName))).resolves.toEqual(asset)
  await expect(
    readFile(join(output, assetName.replace(/\.tar\.gz$/, '.json')), 'utf8')
  ).resolves.toBe(`${JSON.stringify(descriptor, null, 2)}\n`)
})

test('rejects conflicting assets with the same immutable name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-harness-runtime-conflict-'))
  roots.push(root)
  const input = join(root, 'release-assets')
  const output = join(root, 'shared-assets')
  await mkdir(input)
  await mkdir(output)
  const assetName = 'harness-runtime-linux-x64-dsh-0.1.0-rc.8-fingerprint.tar.gz'
  const asset = Buffer.from('first')
  await writeFile(join(input, assetName), asset)
  await writeFile(join(output, assetName), 'second')
  await writeFile(
    join(input, assetName.replace(/\.tar\.gz$/, '.json')),
    JSON.stringify({
      assetName,
      archiveBytes: asset.length,
      archiveSha256: createHash('sha256').update(asset).digest('hex'),
    })
  )

  await expect(collectHarnessRuntimeReleaseAssets(input, output)).rejects.toThrow(
    'Conflicting immutable Harness Runtime asset'
  )
})

test('rejects corrupted runtime archives before publishing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-harness-runtime-corrupted-'))
  roots.push(root)
  const input = join(root, 'assets')
  await mkdir(input)
  const assetName = 'harness-runtime-linux-x64-dsh-0.2.0-rc.2-fingerprint.tar.gz'
  await writeFile(join(input, assetName), 'corrupted runtime')
  await expect(
    collectHarnessRuntimeReleaseAssets(input, join(root, 'output'), {
      runtimes: [
        { assetName, archiveBytes: 17, archiveSha256: 'a'.repeat(64), directory: 'expanded' },
      ],
    })
  ).rejects.toThrow('Harness Runtime asset does not match its descriptor')
})

test('collects bundled archives from a Core component without requiring on-demand archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-harness-component-assets-'))
  roots.push(root)
  const input = join(root, 'input')
  const component = join(root, 'component')
  const output = join(root, 'output')
  await mkdir(input)
  await mkdir(component)
  const assetName = 'harness-runtime-linux-x64-dsh-0.2.0-rc.2-fingerprint.tar.gz'
  const asset = Buffer.from('bundled runtime')
  await writeFile(join(component, assetName), asset)
  const descriptor = {
    assetName,
    archiveBytes: asset.length,
    archiveSha256: createHash('sha256').update(asset).digest('hex'),
  }
  await writeFile(
    join(component, 'runtimes.json'),
    JSON.stringify({
      runtimes: [descriptor, { bundled: false, assetName: 'on-demand-not-packaged.tar.gz' }],
    })
  )
  await create(
    {
      cwd: component,
      file: join(input, 'WeworkComponent_coreDsh_linux_x64_hash.tar.gz'),
      gzip: true,
    },
    ['runtimes.json', assetName]
  )
  await collectHarnessRuntimeReleaseAssets(input, output)
  await expect(readFile(join(output, assetName))).resolves.toEqual(asset)
  await expect(readFile(join(output, 'on-demand-not-packaged.tar.gz'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})
