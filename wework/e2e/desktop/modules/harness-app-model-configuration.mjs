import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const { parse } = createRequire(join(import.meta.dirname, '../../../electron/package.json'))(
  process.env.WEWORK_E2E_YAML_PARSER || 'yaml'
)

export async function readActiveHarnessModelRoutes(instanceDirectory) {
  const profile = parse(
    await readFile(join(instanceDirectory, 'profiles', 'smoke', 'cordis.patch.yml'), 'utf8')
  )
  assert.ok(Array.isArray(profile), 'The active DSH profile patch must contain plugin entries')
  return modelRoutes(profile.find(entry => entry.id === 'llm-pi-ai')?.config?.providers)
}

export async function readPendingHarnessModelRoutes(instanceDirectory) {
  const settings = parse(await readFile(join(instanceDirectory, 'settings.yaml'), 'utf8'))
  return modelRoutes(settings?.['llm-pi-ai']?.providers)
}

function modelRoutes(providers) {
  return Object.entries(providers ?? {}).flatMap(([id, provider]) =>
    provider?.baseURL
      ? [{ id, displayName: provider.displayName ?? '', baseUrl: provider.baseURL }]
      : []
  )
}
