import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Read metadata only. Disabled plugins are never imported or executed for discovery.
export async function installedProviders(home, activeItems, parseConnections) {
  if (!home) return activeItems
  const profile = join(home, 'profiles', 'wework-core', 'package.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(profile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return activeItems
    throw error
  }
  const enabled = new Set(manifest.dsh?.profile?.bundles ?? [])
  const items = [...activeItems]
  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName))
      throw new Error('Invalid installed plugin identity')
    if (activeItems.some(item => item.packageName === packageName)) continue
    let declaration
    try {
      declaration = JSON.parse(
        await readFile(
          join(dirname(profile), 'node_modules', ...packageName.split('/'), 'package.json'),
          'utf8'
        )
      )
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (declaration.name !== packageName)
      throw new Error('Installed plugin identity does not match its manifest')
    const definition = parseConnections(declaration)
    if (!definition) continue
    for (const provider of definition.providers) {
      items.push({
        ...provider,
        id: `${packageName}/${provider.id}`,
        packageName,
        dependencies: provider.uses.map(alias => ({
          alias,
          ...definition.dependencies[alias],
          status: 'unavailable',
          resolved: null,
        })),
        availability: {
          status: enabled.has(packageName) ? 'plugin_unavailable' : 'plugin_disabled',
        },
      })
    }
  }
  return items
}
