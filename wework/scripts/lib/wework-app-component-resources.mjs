import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

export const WEWORK_APP_STATIC_DIRECTORIES = ['vendor', 'wasm']

export async function extractWeworkAppStaticResources(corePluginsRoot, staticResourcesRoot) {
  const webRoot = join(corePluginsRoot, 'wework-app', 'web')
  await mkdir(staticResourcesRoot, { recursive: true, mode: 0o700 })
  for (const directory of WEWORK_APP_STATIC_DIRECTORIES) {
    await rename(join(webRoot, directory), join(staticResourcesRoot, directory))
  }
}
