import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { validateDshWebPluginManifests } from './dsh-plugin-manifest-contract.mjs'

const DSH_VERSION = '0.2.0-rc.2'
const CORDIS_PACKAGE = '@deepseek-ai/cordis'
const CORDIS_VERSION = '~4.0.4'
const RENDERER_PACKAGE = '@deepseek-ai/dsh-client-ui-renderer'
const RUNTIME_PACKAGE = '@deepseek-ai/dsh-client-runtime'
const PUBLIC_PLUGIN = '@wegent/public-plugin'
const EXTENSION_PLUGIN = '@wegent/internal-extension'
const fixtureRoots = []
const peerCompatibilityCases = [
  {
    expectedPeer: CORDIS_PACKAGE,
    label: 'a public plugin with the wrong Cordis peer',
    pluginOptions: { cordisVersion: '~9.0.0' },
    targetName: PUBLIC_PLUGIN,
  },
  {
    expectedPeer: RENDERER_PACKAGE,
    label: 'a public plugin with the wrong renderer peer',
    pluginOptions: { rendererVersion: '9.0.0' },
    targetName: PUBLIC_PLUGIN,
  },
  {
    expectedPeer: CORDIS_PACKAGE,
    label: 'a public plugin without the Cordis peer',
    pluginOptions: { includeCordisPeer: false },
    targetName: PUBLIC_PLUGIN,
  },
  {
    expectedPeer: RENDERER_PACKAGE,
    label: 'a public plugin without the renderer peer',
    pluginOptions: { includeRendererPeer: false },
    targetName: PUBLIC_PLUGIN,
  },
  {
    expectedPeer: CORDIS_PACKAGE,
    label: 'an extension plugin with the wrong Cordis peer',
    pluginOptions: { cordisVersion: '~9.0.0' },
    targetName: EXTENSION_PLUGIN,
  },
  {
    expectedPeer: RENDERER_PACKAGE,
    label: 'an extension plugin with the wrong renderer peer',
    pluginOptions: { rendererVersion: '9.0.0' },
    targetName: EXTENSION_PLUGIN,
  },
  {
    expectedPeer: CORDIS_PACKAGE,
    label: 'an extension plugin without the Cordis peer',
    pluginOptions: { includeCordisPeer: false },
    targetName: EXTENSION_PLUGIN,
  },
  {
    expectedPeer: RENDERER_PACKAGE,
    label: 'an extension plugin without the renderer peer',
    pluginOptions: { includeRendererPeer: false },
    targetName: EXTENSION_PLUGIN,
  },
]

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true })))
})

describe('DSH plugin manifest contract', () => {
  test('accepts compatible public and extension web plugins', async () => {
    const fixture = await createFixture([webPlugin(PUBLIC_PLUGIN), webPlugin(EXTENSION_PLUGIN)])

    await expect(validateFixture(fixture)).resolves.toBeUndefined()
  })

  test.each(peerCompatibilityCases)(
    'rejects $label',
    async ({ expectedPeer, pluginOptions, targetName }) => {
      const fixture = await createFixture([
        webPlugin(PUBLIC_PLUGIN, targetName === PUBLIC_PLUGIN ? pluginOptions : undefined),
        webPlugin(EXTENSION_PLUGIN, targetName === EXTENSION_PLUGIN ? pluginOptions : undefined),
      ])

      await expect(validateFixture(fixture)).rejects.toThrow(
        `${targetName} peerDependencies.${expectedPeer}`
      )
    }
  )

  test('rejects an extension plugin that injects the client runtime', async () => {
    const fixture = await createFixture([
      webPlugin(PUBLIC_PLUGIN),
      webPlugin(EXTENSION_PLUGIN, { injectRuntime: true }),
    ])

    await expect(validateFixture(fixture)).rejects.toThrow(
      `${EXTENSION_PLUGIN} dsh.client.inject must not include ${RUNTIME_PACKAGE}`
    )
  })

  test('rejects a declared plugin without a manifest', async () => {
    const fixture = await createFixture([webPlugin(PUBLIC_PLUGIN), null])

    await expect(validateFixture(fixture)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

/** Create an isolated selected-runtime and plugin-manifest fixture. */
async function createFixture(plugins) {
  const root = await mkdtemp(join(tmpdir(), 'wegent-dsh-manifest-'))
  fixtureRoots.push(root)
  const coreRuntimeSourcePath = join(root, 'core-dsh-runtime.ts')
  const harnessRuntimeRoot = join(root, 'harness-runtime')
  const runtimeRoot = join(harnessRuntimeRoot, 'runtimes', DSH_VERSION)
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(
    coreRuntimeSourcePath,
    `export const CORE_DSH_VERSION = '${DSH_VERSION}'\n`,
    'utf8'
  )
  await writeFile(join(runtimeRoot, 'pnpm-lock.yaml'), runtimeLockfile(), 'utf8')

  const pluginRoots = []
  for (const [index, plugin] of plugins.entries()) {
    const pluginRoot = join(root, `plugin-${index}`)
    pluginRoots.push(pluginRoot)
    await mkdir(pluginRoot, { recursive: true })
    if (plugin) {
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify(plugin), 'utf8')
    }
  }

  return { coreRuntimeSourcePath, harnessRuntimeRoot, pluginRoots }
}

/** Validate one isolated contract fixture. */
function validateFixture(fixture) {
  return validateDshWebPluginManifests(fixture)
}

/** Build a web plugin manifest with overridable compatibility metadata. */
function webPlugin(
  name,
  {
    cordisVersion = CORDIS_VERSION,
    includeCordisPeer = true,
    includeRendererPeer = true,
    injectRuntime = false,
    rendererVersion = DSH_VERSION,
  } = {}
) {
  return {
    name,
    dsh: {
      client: {
        inject: [RENDERER_PACKAGE, ...(injectRuntime ? [RUNTIME_PACKAGE] : [])],
        platform: 'web',
      },
    },
    peerDependencies: {
      ...(includeCordisPeer ? { [CORDIS_PACKAGE]: cordisVersion } : {}),
      ...(includeRendererPeer ? { [RENDERER_PACKAGE]: rendererVersion } : {}),
    },
  }
}

/** Build the minimal lockfile metadata required by the contract validator. */
function runtimeLockfile() {
  return `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@deepseek-ai/dsh':
        specifier: ${DSH_VERSION}
        version: ${DSH_VERSION}

packages:

  '${RENDERER_PACKAGE}@${DSH_VERSION}':
    resolution: {integrity: fixture}
    peerDependencies:
      '@deepseek-ai/cordis': ${CORDIS_VERSION}

snapshots:
`
}
