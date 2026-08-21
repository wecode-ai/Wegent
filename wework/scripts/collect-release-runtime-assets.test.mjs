import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { collectReleaseRuntimeAssets } from './collect-release-runtime-assets.mjs'

async function writeRuntimeFixture(root, kind, platform, content, baseUrl) {
  const isNode = kind === 'node'
  const assetName = `${kind}-runtime-${platform}-fixture.tar.gz`
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
  await writeFile(
    path.join(descriptorDirectory, isNode ? 'node.json' : 'runtime.json'),
    JSON.stringify({
      assetName,
      archiveBytes: content.length,
      archiveSha256: createHash('sha256').update(content).digest('hex'),
      downloadUrl: `${baseUrl}/${assetName}`,
    })
  )
}

test('collects the two content-addressed runtime assets for the release platform', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wework-runtime-assets-'))
  const outputDirectory = path.join(root, 'output')
  const baseUrl = 'https://minio.example.test/releases/wework/macos'
  await writeRuntimeFixture(root, 'harness', 'macos-arm64', Buffer.from('harness'), baseUrl)
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
    ['harness', 'node']
  )
  for (const asset of manifest.assets) {
    assert.equal(await readFile(path.join(outputDirectory, asset.name), 'utf8'), asset.kind)
    assert.equal(asset.downloadUrl, `${baseUrl}/${asset.name}`)
  }
})

test('rejects a runtime prepared for another platform', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wework-runtime-assets-'))
  const baseUrl = 'https://minio.example.test/releases/wework/windows'
  await writeRuntimeFixture(root, 'harness', 'macos-arm64', Buffer.from('harness'), baseUrl)
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
