import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'vitest'

import { CORE_PLUGIN_DIRECTORIES, corePluginSource } from './lib/core-plugin-resources.mjs'
import { validateDshWebPluginManifests } from './lib/dsh-plugin-manifest-contract.mjs'

const weworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('DSH plugin manifests', () => {
  test('keeps bundled web plugins compatible with the current client renderer', async () => {
    await validateDshWebPluginManifests({
      coreRuntimeSourcePath: join(weworkRoot, 'electron', 'src', 'runtime', 'core-dsh-runtime.ts'),
      harnessRuntimeRoot: join(weworkRoot, 'harness-runtime'),
      pluginRoots: CORE_PLUGIN_DIRECTORIES.map(directory =>
        corePluginSource(weworkRoot, directory)
      ),
    })
  })
})
