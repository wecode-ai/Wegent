import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import { collectReleaseRuntimeAssets } from './collect-release-runtime-assets.mjs'

async function writeRuntimeFixture(root, kind, platform, content, baseUrl, version = '') {
  const isNode = kind === 'node'
  const versionSegment = version ? `-dsh-${version}` : ''
  const assetName = `${kind}-runtime-${platform}${versionSegment}-fixture.tar.gz`
  const descriptorDirectory = path.join(
    root,
    'src-tauri',
    isNode ? 'bundled-execution-runtimes' : 'bundled-harness-runtime'
  )
  const cacheDirectory = path.join(
    root,
    'node_modules',
    '.cache',
    isNode ? 'execution-runtime-assets' : 'harness-runtime-assets'
  )
  await mkdir(descriptorDirectory, { recursive: true })
  await mkdir(cacheDirectory, { recursive: true })
  await writeFile(path.join(cacheDirectory, assetName), content)
  const descriptor = {
    ...(isNode ? { id: 'node' } : { dshVersion: version }),
    assetName,
    archiveBytes: content.length,
    archiveSha256: createHash('sha256').update(content).digest('hex'),
    downloadUrl: `${baseUrl}/${assetName}`,
  }
  if (isNode) {
    await writeFile(path.join(descriptorDirectory, 'node.json'), JSON.stringify(descriptor))
  } else {
    await writeFile(
      path.join(cacheDirectory, assetName.replace(/\.tar\.gz$/, '.json')),
      JSON.stringify(descriptor)
    )
  }
  return descriptor
}

async function writeHarnessCatalog(root, descriptors) {
  const directory = path.join(root, 'src-tauri', 'bundled-harness-runtime')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'runtimes.json'), JSON.stringify({ runtimes: descriptors }))
}

test('collects all content-addressed runtime archives and descriptors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wework-runtime-assets-'))
  const outputDirectory = path.join(root, 'output')
  const baseUrl = 'https://minio.example.test/releases/wework/macos'
  const harnessRc7 = await writeRuntimeFixture(
    root,
    'harness',
    'macos-arm64',
    Buffer.from('harness-rc7'),
    baseUrl,
    '0.1.0-rc.7'
  )
  const harnessRc8 = await writeRuntimeFixture(
    root,
    'harness',
    'macos-arm64',
    Buffer.from('harness-rc8'),
    baseUrl,
    '0.1.0-rc.8'
  )
  await writeHarnessCatalog(root, [harnessRc7, harnessRc8])
  await writeRuntimeFixture(root, 'node', 'macos-arm64', Buffer.from('node'), baseUrl)

  const manifestPath = await collectReleaseRuntimeAssets({
    outputDirectory,
    runtimeBaseUrl: `${baseUrl}/`,
    expectedPlatform: 'macos-arm64',
    weworkDirectory: root,
  })

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.deepEqual(
    manifest.assets.map(asset => asset.kind),
    ['harness', 'harness', 'node']
  )
  for (const asset of manifest.assets) {
    assert.equal(asset.downloadUrl, `${baseUrl}/${asset.archiveName}`)
    assert.deepEqual(
      JSON.parse(await readFile(path.join(outputDirectory, asset.descriptorName), 'utf8')),
      JSON.parse(
        await readFile(
          path.join(
            root,
            asset.kind === 'node'
              ? 'src-tauri/bundled-execution-runtimes'
              : 'node_modules/.cache/harness-runtime-assets',
            asset.kind === 'node' ? 'node.json' : asset.descriptorName
          ),
          'utf8'
        )
      )
    )
  }
})

test('rejects a runtime prepared for another platform', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wework-runtime-assets-'))
  const baseUrl = 'https://minio.example.test/releases/wework/windows'
  const harness = await writeRuntimeFixture(
    root,
    'harness',
    'macos-arm64',
    Buffer.from('harness'),
    baseUrl,
    '0.1.0-rc.7'
  )
  await writeHarnessCatalog(root, [harness])
  await writeRuntimeFixture(root, 'node', 'macos-arm64', Buffer.from('node'), baseUrl)

  await assert.rejects(
    collectReleaseRuntimeAssets({
      outputDirectory: path.join(root, 'output'),
      runtimeBaseUrl: baseUrl,
      expectedPlatform: 'windows-x64',
      weworkDirectory: root,
    }),
    /wrong platform/
  )
})
