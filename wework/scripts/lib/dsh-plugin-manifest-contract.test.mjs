import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { validateDshWebPluginManifests } from './dsh-plugin-manifest-contract.mjs'

const DSH_VERSION = '0.2.0-rc.2'
const CORDIS_VERSION = '~4.0.4'
const RENDERER_PACKAGE = '@deepseek-ai/dsh-client-ui-renderer'
const RUNTIME_PACKAGE = '@deepseek-ai/dsh-client-runtime'
const fixtureRoots = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true })))
})

describe('DSH plugin manifest contract', () => {
  test('accepts compatible public and extension web plugins', async () => {
    const fixture = await createFixture([
      webPlugin('@wegent/public-plugin'),
      webPlugin('@wegent/internal-extension'),
    ])

    await expect(validateFixture(fixture)).resolves.toBeUndefined()
  })

  test.each([
    [
      'uniformly wrong peer versions',
      {
        cordisVersion: '~9.0.0',
        rendererVersion: '9.0.0',
      },
    ],
    ['uniformly missing peer versions', { includePeers: false }],
  ])('rejects %s', async (_label, pluginOptions) => {
    const fixture = await createFixture([
      webPlugin('@wegent/public-plugin', pluginOptions),
      webPlugin('@wegent/internal-extension', pluginOptions),
    ])

    await expect(validateFixture(fixture)).rejects.toThrow(/peerDependencies/)
  })

  test('rejects an incompatible extension plugin', async () => {
    const fixture = await createFixture([
      webPlugin('@wegent/public-plugin'),
      webPlugin('@wegent/internal-extension', { injectRuntime: true }),
    ])

    await expect(validateFixture(fixture)).rejects.toThrow(
      `@wegent/internal-extension dsh.client.inject must not include ${RUNTIME_PACKAGE}`
    )
  })

  test('rejects a declared plugin without a manifest', async () => {
    const fixture = await createFixture([webPlugin('@wegent/public-plugin'), null])

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
    includePeers = true,
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
    ...(includePeers
      ? {
          peerDependencies: {
            '@deepseek-ai/cordis': cordisVersion,
            [RENDERER_PACKAGE]: rendererVersion,
          },
        }
      : {}),
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
