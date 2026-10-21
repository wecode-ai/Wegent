import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const weworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = join(weworkRoot, 'dsh')

describe('DSH plugin manifests', () => {
  test('keeps bundled web plugins compatible with the current client renderer', async () => {
    const appManifest = await readManifest(join(pluginRoot, 'app-wework'))
    const expectedCordisVersion = appManifest.peerDependencies['@deepseek-ai/cordis']
    const expectedRendererVersion =
      appManifest.peerDependencies['@deepseek-ai/dsh-client-ui-renderer']

    for (const manifest of await readPluginManifests(pluginRoot)) {
      if (manifest.dsh?.client?.platform !== 'web') continue

      expect(manifest.dsh.client.inject, manifest.name).toContain(
        '@deepseek-ai/dsh-client-ui-renderer'
      )
      expect(manifest.dsh.client.inject, manifest.name).not.toContain(
        '@deepseek-ai/dsh-client-runtime'
      )
      expect(manifest.peerDependencies?.['@deepseek-ai/cordis'], manifest.name).toBe(
        expectedCordisVersion
      )
      expect(
        manifest.peerDependencies?.['@deepseek-ai/dsh-client-ui-renderer'],
        manifest.name
      ).toBe(expectedRendererVersion)
      expect(
        manifest.peerDependencies?.['@deepseek-ai/dsh-client-runtime'],
        manifest.name
      ).toBeUndefined()
    }
  })
})

async function readPluginManifests(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const manifests = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      manifests.push(await readManifest(join(root, entry.name)))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  return manifests
}

async function readManifest(root) {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
}
