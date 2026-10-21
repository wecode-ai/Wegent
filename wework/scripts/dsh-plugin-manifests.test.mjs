import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'vitest'

import { expectCompatibleDshWebPluginManifests } from './lib/dsh-plugin-manifest-contract.mjs'

const weworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = join(weworkRoot, 'dsh')

describe('DSH plugin manifests', () => {
  test('keeps bundled web plugins compatible with the current client renderer', async () => {
    await expectCompatibleDshWebPluginManifests({
      appManifestRoot: join(pluginRoot, 'app-wework'),
      pluginRoot,
    })
  })
})
