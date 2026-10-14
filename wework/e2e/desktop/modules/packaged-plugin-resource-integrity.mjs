import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { packagedResourcesRoot } from './runtime-assets.mjs'

export async function inventoryComponentResources(root) {
  const inventory = {}
  const visit = async relative => {
    const path = join(root, relative)
    const metadata = await lstat(path)
    if (metadata.isDirectory()) {
      if (relative) inventory[relative] = { type: 'directory' }
      for (const entry of (await readdir(path)).sort()) await visit(posix.join(relative, entry))
      return
    }
    const hash = createHash('sha256')
    if (metadata.isSymbolicLink()) hash.update(await readlink(path))
    else if (metadata.isFile()) {
      for await (const chunk of createReadStream(path)) hash.update(chunk)
    } else throw new Error(`Unsupported component resource: ${relative}`)
    inventory[relative] = {
      type: metadata.isSymbolicLink() ? 'symlink' : 'file',
      sha256: hash.digest('hex'),
    }
  }
  await visit('')
  return inventory
}

export function componentResourceChanges(before, after) {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter(path => JSON.stringify(before[path]) !== JSON.stringify(after[path]))
      .map(path => [path, { before: before[path] ?? null, after: after[path] ?? null }])
  )
}

export async function packagedPluginResourceSnapshot(appBinary, environment) {
  const script = `
    import { readFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    const resources = process.argv[1]
    const { inventoryComponentResources } = await import(process.argv[2])
    const { hashComponentPath } = await import(pathToFileURL(join(resources,
      'app.asar/dist/runtime/component-content-hash.js')).href)
    const metadata = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8'))
    const snapshots = await Promise.all(
      ['weworkCorePlugins', 'weworkAppStatic'].map(async id => {
        const root = join(resources, metadata.components[id].path)
        return [id, { hash: await hashComponentPath(root),
          inventory: await inventoryComponentResources(root) }]
      })
    )
    process.stdout.write(JSON.stringify({
      hashes: Object.fromEntries(snapshots.map(([id, value]) => [id, value.hash])),
      inventories: Object.fromEntries(snapshots.map(([id, value]) => [id, value.inventory])),
    }))
  `
  const { stdout } = await promisify(execFile)(
    appBinary,
    ['--input-type=module', '-e', script, packagedResourcesRoot(appBinary), import.meta.url],
    {
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    }
  )
  return JSON.parse(stdout)
}
