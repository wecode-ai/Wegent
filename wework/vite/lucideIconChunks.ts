import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizePath, type Plugin } from 'vite'

interface IconCatalog {
  mapPath: string
  mapId: string
  catalogId: string
  catalogImport: string
  entries: Promise<Array<{ name: string; module: string }>>
}

async function iconModules(mapPath: string): Promise<Array<{ name: string; module: string }>> {
  const imported = await import(pathToFileURL(mapPath).href)
  assert.ok(imported.default && typeof imported.default === 'object')
  return Object.entries(imported.default).map(([name, loader]) => {
    assert.equal(typeof loader, 'function')
    const match = String(loader).match(
      /^\(\)\s*=>\s*import\(\s*(['"])(\.\/icons\/[a-z0-9-]+\.m?js)\1\s*\)$/
    )
    assert.ok(match, `Unsupported Lucide dynamic icon loader: ${name}`)
    return { name, module: normalizePath(path.resolve(path.dirname(mapPath), match[2])) }
  })
}

/** Preserve Lucide's loader API while storing its icon modules in one lazy chunk. */
export function lucideIconChunks(): Plugin {
  const catalogs: IconCatalog[] = []
  return {
    name: 'wework-lucide-icon-chunks',
    apply: 'build',
    enforce: 'pre',
    async resolveId(source, importer) {
      const catalog = catalogs.find(item => item.catalogImport === source)
      if (catalog) return catalog.catalogId
      if (
        !/dynamicIconImports\.m?js$/.test(source) ||
        !importer?.replaceAll('\\', '/').includes('/lucide-react/')
      )
        return null
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      assert.ok(resolved && normalizePath(resolved.id).includes('/lucide-react/'))
      let current = catalogs.find(item => item.mapPath === resolved.id)
      if (!current) {
        const index = catalogs.length
        current = {
          mapPath: resolved.id,
          mapId: `\0wework-lucide-map-${index}`,
          catalogId: `\0wework-lucide-catalog-${index}`,
          catalogImport: `virtual:wework-lucide-catalog-${index}`,
          entries: iconModules(resolved.id),
        }
        catalogs.push(current)
      }
      return current.mapId
    },
    async load(id) {
      const catalog = catalogs.find(item => item.mapId === id || item.catalogId === id)
      if (!catalog) return null
      const entries = await catalog.entries
      if (id === catalog.mapId) {
        const loaders = entries.map(
          ({ name }) =>
            `${JSON.stringify(name)}:()=>import(${JSON.stringify(catalog.catalogImport)}).then(module=>module.icons[${JSON.stringify(name)}])`
        )
        return `export default {${loaders.join(',')}}`
      }
      const imports = entries.map(
        ({ module }, index) => `import * as icon${index} from ${JSON.stringify(module)}`
      )
      const icons = entries.map(({ name }, index) => `${JSON.stringify(name)}:icon${index}`)
      return `${imports.join('\n')}\nexport const icons={${icons.join(',')}}`
    },
  }
}
