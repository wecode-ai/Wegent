import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Use the resolver shipped with this app's Expo SDK, including under pnpm.
// These are the same implementations called by CocoaPods and Xcode.
const require = createRequire(import.meta.url)
const expoRequire = createRequire(require.resolve('expo/package.json'))
const { ExpoModuleConfig } = expoRequire('expo-modules-autolinking/build/ExpoModuleConfig')
const { resolveModuleAsync, generateModulesProviderAsync } = expoRequire(
  'expo-modules-autolinking/build/platforms/apple/apple'
)
const { resolveDependencyConfigImplIosAsync } = expoRequire(
  'expo-modules-autolinking/build/reactNativeConfig/iosResolver'
)
const appRoot = fileURLToPath(new URL('../../', import.meta.url))
const moduleRoot = join(appRoot, 'modules/wework-local-runtime')

async function readModule() {
  const manifest = JSON.parse(await readFile(join(moduleRoot, 'package.json'), 'utf8'))
  const config = JSON.parse(await readFile(join(moduleRoot, 'expo-module.config.json'), 'utf8'))
  return {
    name: manifest.name,
    version: manifest.version,
    path: moduleRoot,
    config: new ExpoModuleConfig(config),
  }
}

async function generateProvider(module: Awaited<ReturnType<typeof resolveModuleAsync>>) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-local-autolinking-'))
  try {
    const targetPath = join(directory, 'ExpoModulesProvider.swift')
    await generateModulesProviderAsync(module ? [module] : [], targetPath, null, {
      appRoot,
      targetPath,
      targetName: 'Wegent',
      watchedDirectories: [],
      inlineModulesTargets: { targets: [] },
    })
    return await readFile(targetPath, 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('phone-local Expo native module registration', () => {
  it('resolves the real module into an imported and registered Swift provider class', async () => {
    const revision = await readModule()
    const module = await resolveModuleAsync(revision.name, revision, {})
    expect(module).toMatchObject({
      packageName: 'wework-local-runtime',
      pods: [{ podName: 'WeworkLocalRuntime', podspecDir: moduleRoot }],
      swiftModuleNames: ['WeworkLocalRuntime'],
      modules: [{ name: null, class: 'WeworkLocalRuntimeModule' }],
      appDelegateSubscribers: [],
      reactDelegateHandlers: [],
      debugOnly: false,
    })
    const provider = await generateProvider(module)
    expect(provider).toMatch(/^internal import WeworkLocalRuntime$/m)
    expect(provider).toContain('(module: WeworkLocalRuntimeModule.self, name: nil)')
    // A valid Expo pod must not also be linked through the generic RN path.
    await expect(
      resolveDependencyConfigImplIosAsync(revision, undefined, revision.config)
    ).resolves.toBeNull()
  })

  it('reproduces the missing root podspec registration even when generic RN links the pod', async () => {
    const revision = await readModule()
    const config = structuredClone(revision.config.toJSON())
    delete config.apple.podspecPath
    const missingPath = { ...revision, config: new ExpoModuleConfig(config) }
    const module = await resolveModuleAsync(revision.name, missingPath, {})
    expect(module).toBeNull()
    await expect(
      resolveDependencyConfigImplIosAsync(missingPath, undefined, missingPath.config)
    ).resolves.toMatchObject({ podspecPath: join(moduleRoot, 'WeworkLocalRuntime.podspec') })
    const provider = await generateProvider(module)
    expect(provider).not.toContain('import WeworkLocalRuntime')
    expect(provider).not.toContain('WeworkLocalRuntimeModule.self')
  })
})
