import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import {
  loadPreviousComponentManifest,
  resolveReusableComponent,
} from './component-asset-reuse.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  )
})

test('reuses a published component when its content hash is unchanged', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-component-reuse-'))
  temporaryDirectories.push(root)
  const manifestPath = resolve(root, 'components.json')
  const archiveSha256 = 'a'.repeat(64)
  const downloadUrl =
    `https://minio.example/wework/components/` +
    `WeworkComponent_codex_${archiveSha256}_macos_arm64.tar.gz`
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      platform: 'macos',
      arch: 'arm64',
      components: {
        codex: {
          contentSha256: 'b'.repeat(64),
          archiveSha256,
          archiveBytes: 123,
          downloadUrl,
          entryPath: '.',
        },
      },
    })
  )

  const previousManifest = await loadPreviousComponentManifest(manifestPath, 'macos', 'arm64')
  expect(
    resolveReusableComponent({
      arch: 'arm64',
      component: { version: '0.153.3' },
      contentSha256: 'b'.repeat(64),
      entryPath: '.',
      id: 'codex',
      platform: 'macos',
      previousManifest,
    })
  ).toMatchObject({
    archiveBytes: 123,
    archiveSha256,
    downloadUrl,
    reused: true,
    version: '0.153.3',
  })
})

test('regenerates a component when its content hash changed', () => {
  expect(
    resolveReusableComponent({
      arch: 'arm64',
      component: { version: '0.153.3' },
      contentSha256: 'c'.repeat(64),
      entryPath: '.',
      id: 'codex',
      platform: 'macos',
      previousManifest: {
        components: {
          codex: {
            contentSha256: 'b'.repeat(64),
          },
        },
      },
    })
  ).toBeNull()
})
