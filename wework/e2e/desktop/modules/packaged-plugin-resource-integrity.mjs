import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { packagedResourcesRoot } from './runtime-assets.mjs'

export async function packagedPluginResourceHashes(appBinary, environment) {
  const script = `
    import { readFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    const resources = process.argv[1]
    const { hashComponentPath } = await import(pathToFileURL(join(resources,
      'app.asar/dist/runtime/component-content-hash.js')).href)
    const metadata = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8'))
    const hashes = Object.fromEntries(await Promise.all(
      ['weworkCorePlugins', 'weworkAppStatic'].map(async id =>
        [id, await hashComponentPath(join(resources, metadata.components[id].path))])
    ))
    process.stdout.write(JSON.stringify(hashes))
  `
  const { stdout } = await promisify(execFile)(
    appBinary,
    ['--input-type=module', '-e', script, packagedResourcesRoot(appBinary)],
    {
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }
  )
  return JSON.parse(stdout)
}
