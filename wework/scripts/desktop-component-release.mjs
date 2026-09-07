#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHARED_COMPONENTS = new Set(['coreDsh', 'codex', 'dws'])
const VERSION_COMPONENTS = new Set([
  'weworkCorePlugins',
  'weworkAppStatic',
  'bundledPlugins',
  'executor',
])

export function componentReleaseScope(id) {
  if (SHARED_COMPONENTS.has(id)) return 'shared'
  if (VERSION_COMPONENTS.has(id)) return 'version'
  throw new Error(`Unknown desktop component release scope: ${id}`)
}

export async function listComponentAssets(assetsDirectory, scope) {
  if (scope !== 'shared' && scope !== 'version') {
    throw new Error(`Unsupported desktop component release scope: ${scope}`)
  }
  const assets = resolve(assetsDirectory)
  const descriptors = (await readdir(assets))
    .filter(name => /^components-(?:macos|windows|linux)-(?:arm64|x64)\.json$/.test(name))
    .sort()
  const names = new Set()
  for (const descriptor of descriptors) {
    const manifest = JSON.parse(await readFile(resolve(assets, descriptor), 'utf8'))
    for (const [id, component] of Object.entries(manifest.components ?? {})) {
      const expectedScope = componentReleaseScope(id)
      if (component.releaseScope !== expectedScope) {
        throw new Error(
          `Desktop component ${id} has release scope ${component.releaseScope}; expected ${expectedScope}`
        )
      }
      if (expectedScope === scope) names.add(component.assetName)
    }
  }
  return [...names].sort()
}

async function main() {
  const [assetsDirectory, scope] = process.argv.slice(2)
  if (!assetsDirectory || !scope) {
    throw new Error('Usage: desktop-component-release.mjs <assets-directory> <shared|version>')
  }
  process.stdout.write(`${(await listComponentAssets(assetsDirectory, scope)).join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
