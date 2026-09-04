import { cp, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export async function materializeBundledPluginResources(weworkRoot, destination) {
  const source = join(weworkRoot, 'resources', 'bundled-plugins')
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true })

  const marketplaceRoot = join(destination, 'wework-personal')
  const pluginNames = await marketplacePluginNames(marketplaceRoot)
  const dshRoot = join(weworkRoot, 'dsh')
  const entries = await readdir(dshRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const packageRoot = join(dshRoot, entry.name)
    const manifest = await readJson(join(packageRoot, 'package.json'))
    const codexPluginPath = manifest?.wework?.codexPlugin
    if (typeof codexPluginPath !== 'string' || !codexPluginPath.trim()) continue

    const codexPluginRoot = resolve(packageRoot, codexPluginPath)
    const nestedPath = relative(packageRoot, codexPluginRoot)
    if (nestedPath.startsWith('..') || isAbsolute(nestedPath)) {
      throw new Error(`${manifest.name} declares wework.codexPlugin outside its package`)
    }
    const pluginManifest = await readJson(join(codexPluginRoot, '.codex-plugin', 'plugin.json'))
    const pluginName = pluginManifest?.name
    if (typeof pluginName !== 'string' || !pluginName.trim()) {
      throw new Error(`${manifest.name} has an invalid nested Codex plugin manifest`)
    }
    if (!pluginNames.has(pluginName)) {
      throw new Error(
        `${manifest.name} nested Codex plugin ${pluginName} is missing from the bundled marketplace`
      )
    }
    const target = join(marketplaceRoot, 'plugins', pluginName)
    await rm(target, { recursive: true, force: true })
    await cp(codexPluginRoot, target, { recursive: true })
  }
}

async function marketplacePluginNames(marketplaceRoot) {
  const manifests = [
    join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
  ]
  const names = await Promise.all(
    manifests.map(async path => {
      const manifest = await readJson(path)
      return new Set(
        Array.isArray(manifest?.plugins)
          ? manifest.plugins
              .map(plugin => plugin?.name)
              .filter(name => typeof name === 'string' && name.trim())
          : []
      )
    })
  )
  if (names[0].size !== names[1].size || [...names[0]].some(name => !names[1].has(name))) {
    throw new Error('Bundled Codex and Claude plugin names must match')
  }
  return names[0]
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
