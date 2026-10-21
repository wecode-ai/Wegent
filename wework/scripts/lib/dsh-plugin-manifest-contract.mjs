import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'

export async function expectCompatibleDshWebPluginManifests({ appManifestRoot, pluginRoot }) {
  const appManifest = await readManifest(appManifestRoot)
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
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-client-ui-renderer'], manifest.name).toBe(
      expectedRendererVersion
    )
    expect(
      manifest.peerDependencies?.['@deepseek-ai/dsh-client-runtime'],
      manifest.name
    ).toBeUndefined()
  }
}

async function readPluginManifests(pluginRoot) {
  const entries = await readdir(pluginRoot, { withFileTypes: true })
  const manifests = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      manifests.push(await readManifest(join(pluginRoot, entry.name)))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  return manifests
}

async function readManifest(pluginRoot) {
  return JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
}
