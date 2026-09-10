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

test('collects immutable Harness Runtime archives and descriptors from component assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-harness-runtime-assets-'))
  roots.push(root)
  const input = join(root, 'release-assets')
  const output = join(root, 'shared-assets')
  const component = join(root, 'component')
  await Promise.all([mkdir(input), mkdir(component)])
  const assetName = 'harness-runtime-macos-arm64-dsh-0.1.1-rc.2-fingerprint.tar.gz'
  const asset = Buffer.from('immutable runtime')
  await writeFile(join(component, assetName), asset)
  const descriptor = {
    dshVersion: '0.1.1-rc.2',
    role: 'core',
    sourceFingerprint: 'a'.repeat(64),
    archiveSha256: createHash('sha256').update(asset).digest('hex'),
    archiveBytes: asset.length,
    downloadUrl: `https://updates.example/${assetName}`,
    assetName,
  }
  await writeFile(
    join(component, 'runtimes.json'),
    `${JSON.stringify({ runtimes: [descriptor] })}\n`
  )
  await create(
    {
      cwd: component,
      file: join(input, 'WeworkComponent_coreDsh_component_macos_arm64.tar.gz'),
      gzip: true,
    },
    ['.']
  )

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
  for (const [index, content] of ['first', 'second'].entries()) {
    const component = join(root, `component-${index}`)
    await mkdir(component)
    const assetName = 'harness-runtime-linux-x64-dsh-0.1.1-rc.2-fingerprint.tar.gz'
    const asset = Buffer.from(content)
    await writeFile(join(component, assetName), asset)
    await writeFile(
      join(component, 'runtimes.json'),
      JSON.stringify({
        runtimes: [
          {
            dshVersion: '0.1.1-rc.2',
            role: 'core',
            sourceFingerprint: 'a'.repeat(64),
            archiveSha256: createHash('sha256').update(asset).digest('hex'),
            archiveBytes: asset.length,
            downloadUrl: `https://updates.example/${assetName}`,
            assetName,
          },
        ],
      })
    )
    await create(
      {
        cwd: component,
        file: join(input, `WeworkComponent_coreDsh_${index}_linux_x64.tar.gz`),
        gzip: true,
      },
      ['.']
    )
  }

  await expect(collectHarnessRuntimeReleaseAssets(input, output)).rejects.toThrow(
    'Conflicting immutable Harness Runtime asset'
  )
})
