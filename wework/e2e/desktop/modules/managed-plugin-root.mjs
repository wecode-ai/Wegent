import assert from 'node:assert/strict'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export async function managedRoot(home, installedId) {
  const manifestPath = join(home, 'capabilities/manifest-v2.json')
  const manifest = await readFile(manifestPath, 'utf8')
    .then(JSON.parse)
    .catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  const item = Object.values(manifest?.plugins ?? {}).find(
    item => item.installed_plugin_id === installedId && item.managed && item.enabled
  )
  if (!item) return null
  assert.ok(item.runtime?.codex_link, 'Managed plugin has no Codex runtime mapping')
  const root = resolve(home, 'capabilities', item.runtime.codex_link)
  assert.notEqual(root, resolve(home, 'capabilities', item.store_path))
  const metadata = await lstat(root).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!metadata) return null
  assert.ok(!metadata.isSymbolicLink(), 'Expected a real runtime copy')
  return root
}
