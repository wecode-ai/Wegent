import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import semver from 'semver'
import { hashComponentPath } from './component-update-manager.js'
import { copyManagedPlugin } from './managed-plugin-files.js'
import { runtimeNodeArgs } from './electron-node-runtime.js'

export const CORE_DSH_VERSION = '0.2.0-rc.2'
const PROFILE_NAME = 'wework-core'
const PROFILE_STAMP = '.wework-runtime.json'
const CORE_PLUGIN_PACKAGES = [
  ['@wegent/dsh-app-wework', 'wework-app'],
  ['@wegent/dsh-electron-host', 'wework-electron-host'],
  ['@wegent/dsh-browser-runtime', 'wework-browser-runtime'],
  ['@wegent/dsh-secure-storage', 'wework-secure-storage'],
  ['@wegent/dsh-executor-runtime', 'wework-executor-runtime'],
  ['@wegent/dsh-terminal-runtime', 'wework-terminal-runtime'],
  ['@wegent/dsh-transcript-sync', 'wework-transcript-sync'],
  ['@wegent/dsh-plugin-runtime', 'wework-plugin-runtime'],
  ['@wegent/dsh-conversation-export', 'wework-conversation-export'],
  ['@wegent/dsh-ui-core-apps', 'wework-ui-core-apps'],
  ['@wegent/dsh-ui-core-settings', 'wework-ui-core-settings'],
  ['@wegent/dsh-ui-plugin-center', 'wework-ui-plugin-center'],
  ['@wegent/dsh-ui-applications', 'wework-ui-applications'],
  ['@wegent/dsh-ui-automations', 'wework-ui-automations'],
  ['@wegent/dsh-ui-cloud-work', 'wework-ui-cloud-work'],
  ['@wegent/dsh-wework-plugin-developer', 'wework-plugin-developer'],
  ['@wegent/dsh-ui-home-focus', 'wework-ui-home-focus'],
  ['@wegent/dsh-ui-home-developer', 'wework-ui-home-developer'],
  ['@wegent/dsh-ui-git', 'wework-ui-git'],
  ['@wegent/dsh-ui-outputs', 'wework-ui-outputs'],
  ['@wegent/dsh-voice-input', 'wework-voice-input'],
] as const
const CORE_UI_DEPENDENCIES = CORE_PLUGIN_PACKAGES.slice(8).map(([packageName]) => packageName)
const REMOVED_CORE_DEPENDENCIES = ['@wegent/dsh-sidebar-example'] as const
const CORE_HOST_BUNDLES = [
  '@wework/dsh-browser-auth',
  '@deepseek-ai/dsh-base',
  '@wegent/dsh-electron-host',
  '@wegent/dsh-browser-runtime',
  '@wegent/dsh-secure-storage',
  '@wegent/dsh-terminal-runtime',
  '@wegent/dsh-plugin-runtime',
  '@wegent/dsh-app-wework',
  '@deepseek-ai/dsh-web-app',
  '@wegent/dsh-executor-runtime',
  '@wegent/dsh-transcript-sync',
] as const
const CORE_UI_BUNDLES = [
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@wegent/dsh-conversation-export',
  '@wegent/dsh-ui-core-apps',
  '@wegent/dsh-ui-core-settings',
  '@wegent/dsh-ui-plugin-center',
  '@wegent/dsh-ui-applications',
  '@wegent/dsh-ui-automations',
  '@wegent/dsh-ui-cloud-work',
  '@wegent/dsh-wework-plugin-developer',
  '@wegent/dsh-ui-home-focus',
  '@wegent/dsh-ui-home-developer',
  '@wegent/dsh-ui-git',
  '@wegent/dsh-ui-outputs',
  '@wegent/dsh-voice-input',
] as const
const CORE_BUNDLES = [...CORE_HOST_BUNDLES, ...CORE_UI_BUNDLES] as const

// User plugin packages and their manifests must survive a runtime-only reset.
export async function resetCoreDshRuntime(dataDirectory: string): Promise<void> {
  const profileRoot = join(dataDirectory, 'dsh-core', 'profiles', PROFILE_NAME)
  const paths = [
    join(profileRoot, PROFILE_STAMP),
    ...CORE_PLUGIN_PACKAGES.map(([name]) => join(profileRoot, 'node_modules', name)),
  ]
  for (const path of paths) await rm(path, { recursive: true, force: true })
}

interface RuntimeIdentity {
  dshVersion: string
  role?: string
  roles?: string[]
  sourceFingerprint: string
}

interface ProfileStamp extends RuntimeIdentity {
  managedPluginCopyVersion: number
  managedUiPlugins: boolean
  corePluginsFingerprint: string
  managedBundles: readonly string[]
}

export interface BundledDshRuntime {
  root: string
  version: string
  role: string
  sourceFingerprint: string
  entry: string
  pluginsRoot: string
}

export interface CoreDshRuntime {
  root: string
  version: string
  sourceFingerprint: string
  entry: string
  pluginRoots: Record<string, string>
  internalUiPackages?: string[]
  internalUiBundles?: string[]
}

export interface CoreDshLaunch {
  command: string
  entry: string
  args: string[]
  cwd: string
  dshHome: string
  environment: NodeJS.ProcessEnv
  profile: string
  version: string
  sourceFingerprint: string
}

export interface PreparedCoreDshRuntime {
  command: string
  entry: string
  cwd: string
  dshHome: string
  environment: NodeJS.ProcessEnv
  profile: string
  version: string
  sourceFingerprint: string
}

export interface PrepareCoreDshRuntimeOptions {
  runtimeRoot: string
  dataDirectory: string
  environment: NodeJS.ProcessEnv
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<void>

export async function prepareCoreDshRuntime(
  options: PrepareCoreDshRuntimeOptions
): Promise<PreparedCoreDshRuntime> {
  const pluginsRoot = options.environment.WEWORK_CORE_PLUGIN_ROOT?.trim()
  if (!pluginsRoot) {
    throw new Error('WEWORK_CORE_PLUGIN_ROOT is required for the packaged Core DSH runtime')
  }
  const runtime = await selectCoreDshRuntime(options.runtimeRoot, pluginsRoot)
  const nodeCommand = options.environment.WEWORK_NODE_PATH?.trim() || 'node'
  const dshHome = resolve(options.dataDirectory, 'dsh-core')
  const managedUiPlugins = !usesEmptyUiPluginProfile(options.environment)
  const corePluginsFingerprint =
    options.environment.WEWORK_CORE_PLUGINS_SHA256?.trim() ||
    (await hashComponentPath(resolve(pluginsRoot)))
  await prepareProfile({
    runtime,
    dshHome,
    managedUiPlugins,
    corePluginsFingerprint,
  })
  return {
    command: nodeCommand,
    entry: runtime.entry,
    cwd: runtime.root,
    dshHome,
    environment: {
      ...options.environment,
      DSH_HOME: dshHome,
      WEWORK_APP_WEB_ROOT:
        options.environment.WEWORK_APP_WEB_ROOT?.trim() ||
        join(runtime.pluginRoots['@wegent/dsh-app-wework'], 'web'),
      WEWORK_HARNESS_API_KEY: 'wework-local-router',
      WEWORK_DSH_BROWSER_AUTH: '1',
    },
    profile: PROFILE_NAME,
    version: runtime.version,
    sourceFingerprint: runtime.sourceFingerprint,
  }
}

export function createCoreDshLaunch(runtime: PreparedCoreDshRuntime, port: number): CoreDshLaunch {
  return {
    ...runtime,
    args: runtimeNodeArgs(runtime.environment, [
      runtime.entry,
      '--profile',
      PROFILE_NAME,
      '--no-open',
      '--port',
      String(port),
    ]),
  }
}

export async function selectCoreDshRuntime(
  root: string,
  configuredPluginsRoot: string
): Promise<CoreDshRuntime> {
  const runtime = await selectBundledDshRuntime(root, 'core', CORE_DSH_VERSION)
  const pluginsRoot = resolve(configuredPluginsRoot)
  const internalPlugins = await readInternalCorePlugins(pluginsRoot)
  const pluginRoots: Record<string, string> = Object.fromEntries(
    CORE_PLUGIN_PACKAGES.map(([packageName, directory]) => [
      packageName,
      join(pluginsRoot, directory),
    ])
  )
  pluginRoots['@wework/dsh-browser-auth'] = join(runtime.pluginsRoot, 'wework-browser-auth')
  for (const plugin of internalPlugins) {
    if (plugin.name in pluginRoots) {
      throw new Error(`Duplicate core DSH plugin: ${plugin.name}`)
    }
    pluginRoots[plugin.name] = join(pluginsRoot, plugin.directory)
  }
  await Promise.all(
    Object.values(pluginRoots).map(pluginRoot => readFile(join(pluginRoot, 'package.json')))
  )
  return {
    ...runtime,
    pluginRoots,
    internalUiPackages: internalPlugins.map(plugin => plugin.name),
    internalUiBundles: internalPlugins.map(plugin => plugin.bundle),
  }
}

async function readInternalCorePlugins(
  root: string
): Promise<Array<{ name: string; directory: string; bundle: string }>> {
  const manifest = await readJsonFile(join(root, 'internal-plugins.json'))
  if (manifest === null) return []
  if (!Array.isArray(manifest)) throw new Error('Invalid internal core plugin manifest')
  return manifest.map(value => {
    const plugin = objectRecord(value)
    const name = plugin.name
    const directory = plugin.directory
    const bundle = plugin.bundle
    if (
      typeof name !== 'string' ||
      !/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name) ||
      typeof directory !== 'string' ||
      !/^[a-z0-9-]+$/.test(directory) ||
      typeof bundle !== 'string' ||
      bundle !== name
    ) {
      throw new Error('Invalid internal core plugin entry')
    }
    return { name, directory, bundle }
  })
}

export async function selectBundledDshRuntime(
  root: string,
  role: string,
  version: string
): Promise<BundledDshRuntime> {
  return selectBundledDshRuntimeMatching(root, role, version)
}

export async function selectBundledDshRuntimeMatching(
  root: string,
  role: string,
  versionRequirement: string
): Promise<BundledDshRuntime> {
  const absoluteRoot = resolve(root)
  const roots = await runtimeDirectories(absoluteRoot)
  const candidates = (
    await Promise.all(roots.map(candidate => readRuntime(candidate, role)))
  ).filter(
    (runtime): runtime is BundledDshRuntime =>
      runtime !== null &&
      semver.satisfies(runtime.version, versionRequirement, { includePrerelease: true })
  )
  const selected = candidates.sort((left, right) => semver.rcompare(left.version, right.version))[0]
  if (!selected) {
    throw new Error(
      `Bundled ${role} DSH runtime matching ${versionRequirement} is unavailable under ${absoluteRoot}`
    )
  }
  return selected
}

async function prepareProfile(options: {
  runtime: CoreDshRuntime
  dshHome: string
  managedUiPlugins: boolean
  corePluginsFingerprint: string
}): Promise<void> {
  const profileRoot = join(options.dshHome, 'profiles', PROFILE_NAME)
  const workspacePath = join(profileRoot, 'pnpm-workspace.yaml')
  const managedBundles: string[] = options.managedUiPlugins
    ? [...CORE_BUNDLES, ...(options.runtime.internalUiBundles ?? [])]
    : [...CORE_HOST_BUNDLES]
  const expectedStamp: ProfileStamp = {
    managedPluginCopyVersion: 1,
    dshVersion: options.runtime.version,
    role: 'core',
    sourceFingerprint: options.runtime.sourceFingerprint,
    managedUiPlugins: options.managedUiPlugins,
    corePluginsFingerprint: options.corePluginsFingerprint,
    managedBundles,
  }
  const managedDependencies = managedCoreDependencies(options.runtime, options.managedUiPlugins)
  const managedDependencyNames = Object.keys(managedDependencies)
  const currentManifest = await readJsonFile(join(profileRoot, 'package.json'))
  const currentManifestRoot = objectRecord(currentManifest)
  const currentDependencies = stringRecord(currentManifestRoot.dependencies)
  const currentProfile = objectRecord(objectRecord(currentManifestRoot.dsh).profile)
  const currentBundles = stringArray(currentProfile.bundles)
  const removedDependencies = new Set<string>(
    REMOVED_CORE_DEPENDENCIES.filter(
      name => Object.hasOwn(currentDependencies, name) || currentBundles.includes(name)
    )
  )
  const stampIsCurrent = await stampMatches(join(profileRoot, PROFILE_STAMP), expectedStamp)
  const coreDependenciesAreCurrent = hasCurrentCoreDependencies(
    currentManifest,
    managedDependencies
  )
  const installationBundlesAreCurrent = managedBundles
    .filter(name => !managedDependencyNames.includes(name))
    .every(name => currentBundles.includes(name))
  await ensureNodePtySpawnHelpersExecutable(profileRoot)
  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  // Package installation replaces client files even when their bytes are unchanged.
  // Production plugin changes take effect on explicit restart, without remounting the UI.
  await writeFile(join(profileRoot, 'cordis.patch.yml'), '- id: client-hmr\n  disabled: true\n', {
    mode: 0o600,
  })
  if (
    stampIsCurrent &&
    removedDependencies.size === 0 &&
    coreDependenciesAreCurrent &&
    installationBundlesAreCurrent
  ) {
    return
  }

  const recoveredUserPlugins = await recoverInstalledDshDependencies(
    profileRoot,
    currentDependencies,
    currentBundles,
    new Set([...managedDependencyNames, ...REMOVED_CORE_DEPENDENCIES])
  )
  if (
    currentManifest &&
    (!coreDependenciesAreCurrent ||
      removedDependencies.size > 0 ||
      recoveredUserPlugins.dependencies.size > 0)
  ) {
    await Promise.all(
      [
        join(profileRoot, 'pnpm-lock.yaml'),
        join(profileRoot, 'node_modules', '.pnpm', 'lock.yaml'),
        join(profileRoot, 'node_modules', '.modules.yaml'),
      ].map(path => rm(path, { force: true }))
    )
  }
  const userDependencies = Object.fromEntries(
    Object.entries(currentDependencies).filter(
      ([name]) => !managedDependencyNames.includes(name) && !removedDependencies.has(name)
    )
  )
  const userBundles = recoveredUserPlugins.bundles.filter(
    bundle => !managedBundles.includes(bundle as never) && !removedDependencies.has(bundle)
  )
  await writeFile(
    join(profileRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE_NAME}`,
        private: true,
        dependencies: {
          ...userDependencies,
          ...Object.fromEntries(recoveredUserPlugins.dependencies),
          ...managedDependencies,
        },
        dsh: {
          profile: {
            bundles: [...managedBundles, ...userBundles],
          },
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  await writeFile(join(profileRoot, 'cordis.yml'), '[]\n', { mode: 0o600 })
  await ensureCoreWorkspace(workspacePath)
  for (const packageName of managedDependencyNames) {
    const source = options.runtime.pluginRoots[packageName]
    const destination = join(profileRoot, 'node_modules', ...packageName.split('/'))
    await rm(destination, { recursive: true, force: true })
    await copyManagedPlugin(source, destination)
  }
  await ensureNodePtySpawnHelpersExecutable(profileRoot)
  await writeFile(join(profileRoot, PROFILE_STAMP), `${JSON.stringify(expectedStamp, null, 2)}\n`, {
    mode: 0o600,
  })
}

async function ensureCoreWorkspace(workspacePath: string): Promise<void> {
  const fallback = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
  let workspace = (await readTextFile(workspacePath)) || fallback
  if (/^allowBuilds:\s*$/m.test(workspace)) {
    if (/^\s{2}node-pty:.*$/m.test(workspace)) {
      workspace = workspace.replace(/^\s{2}node-pty:.*$/m, '  node-pty: true')
    } else {
      workspace = workspace.replace(/^allowBuilds:\s*$/m, 'allowBuilds:\n  node-pty: true')
    }
  } else {
    workspace = `${workspace.trimEnd()}\n\nallowBuilds:\n  node-pty: true\n`
  }
  await writeFile(workspacePath, workspace, { mode: 0o600 })
}

async function ensureNodePtySpawnHelpersExecutable(profileRoot: string): Promise<void> {
  const prebuildsRoot = join(profileRoot, 'node_modules', 'node-pty', 'prebuilds')
  let platforms
  try {
    platforms = await readdir(prebuildsRoot, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(
    platforms
      .filter(entry => entry.isDirectory())
      .map(entry => chmod(join(prebuildsRoot, entry.name, 'spawn-helper'), 0o755).catch(() => {}))
  )
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function recoverInstalledDshDependencies(
  profileRoot: string,
  dependencies: Record<string, string>,
  bundles: string[],
  excludedPackages: ReadonlySet<string>
): Promise<{ dependencies: Map<string, string>; bundles: string[] }> {
  const recovered = new Map<string, string>()
  const discoveredBundles = new Set(bundles)
  const dependencyGraph = new Map<string, string[]>()
  const pending = [...bundles]
  const visited = new Set<string>()

  while (pending.length > 0) {
    const packageName = pending.shift()
    if (!packageName || visited.has(packageName) || excludedPackages.has(packageName)) continue
    visited.add(packageName)

    const manifest = objectRecord(
      await readJsonFile(
        join(profileRoot, 'node_modules', ...packageName.split('/'), 'package.json')
      )
    )
    const requirements = {
      ...stringRecord(manifest.dependencies),
      ...stringRecord(manifest.optionalDependencies),
      ...stringRecord(manifest.peerDependencies),
    }
    const pluginDependencies: string[] = []
    for (const requiredName of Object.keys(requirements)) {
      if (excludedPackages.has(requiredName)) continue
      const installedManifest = objectRecord(
        await readJsonFile(
          join(profileRoot, 'node_modules', ...requiredName.split('/'), 'package.json')
        )
      )
      const installedDsh = objectRecord(installedManifest.dsh)
      if (
        installedManifest.name !== requiredName ||
        typeof installedManifest.version !== 'string' ||
        !installedDsh.bundle
      ) {
        continue
      }
      pluginDependencies.push(requiredName)
      discoveredBundles.add(requiredName)
      pending.push(requiredName)
      if (!Object.hasOwn(dependencies, requiredName)) {
        recovered.set(requiredName, installedManifest.version)
      }
    }
    dependencyGraph.set(packageName, pluginDependencies)
  }

  const orderedBundles: string[] = []
  const ordering = new Set<string>()
  const ordered = new Set<string>()
  const visit = (packageName: string): void => {
    if (ordered.has(packageName) || ordering.has(packageName)) return
    ordering.add(packageName)
    for (const dependency of dependencyGraph.get(packageName) ?? []) visit(dependency)
    ordering.delete(packageName)
    ordered.add(packageName)
    orderedBundles.push(packageName)
  }
  for (const packageName of discoveredBundles) visit(packageName)

  return { dependencies: recovered, bundles: orderedBundles }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

function hasCurrentCoreDependencies(
  manifest: unknown,
  managedDependencies: Record<string, string>
): boolean {
  const dependencies = stringRecord(objectRecord(manifest).dependencies)
  return Object.entries(managedDependencies).every(
    ([packageName, source]) => dependencies[packageName] === source
  )
}

function managedCoreDependencies(
  runtime: CoreDshRuntime,
  includeUiPlugins: boolean
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(runtime.pluginRoots)
      .filter(
        ([packageName]) =>
          includeUiPlugins ||
          (!CORE_UI_DEPENDENCIES.includes(packageName as never) &&
            !(runtime.internalUiPackages ?? []).includes(packageName))
      )
      .map(([packageName, root]) => [packageName, `file:${root}`])
  )
}

async function runtimeDirectories(root: string): Promise<string[]> {
  try {
    const catalog = JSON.parse(await readFile(join(root, 'runtimes.json'), 'utf8')) as {
      runtimes?: Array<{ sourceFingerprint?: unknown }>
    }
    const fingerprints = catalog.runtimes?.map(runtime => runtime.sourceFingerprint)
    if (
      fingerprints?.length &&
      fingerprints.every(
        fingerprint => typeof fingerprint === 'string' && /^[0-9a-f]{64}$/i.test(fingerprint)
      )
    ) {
      return [...new Set(fingerprints)].map(fingerprint => join(root, fingerprint as string))
    }
  } catch {
    // Fall back to direct-runtime metadata or directory discovery.
  }
  if (await isRuntimeRoot(root)) return [root]
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name))
}

async function isRuntimeRoot(root: string): Promise<boolean> {
  try {
    await readFile(join(root, 'runtime.json'))
    return true
  } catch {
    return false
  }
}

async function readRuntime(root: string, role: string): Promise<BundledDshRuntime | null> {
  try {
    const identity = JSON.parse(
      await readFile(join(root, 'runtime.json'), 'utf8')
    ) as RuntimeIdentity
    if (
      typeof identity.dshVersion !== 'string' ||
      !(
        identity.role === role ||
        (Array.isArray(identity.roles) && identity.roles.includes(role))
      ) ||
      typeof identity.sourceFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(identity.sourceFingerprint)
    ) {
      return null
    }
    const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    if (packageJson.version !== identity.dshVersion) return null
    const entry = join(packageRoot, 'lib', 'bin.js')
    await readFile(entry)
    return {
      root,
      version: identity.dshVersion,
      role,
      sourceFingerprint: identity.sourceFingerprint,
      entry,
      pluginsRoot: join(root, 'plugins'),
    }
  } catch {
    return null
  }
}

async function stampMatches(path: string, expected: ProfileStamp): Promise<boolean> {
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as ProfileStamp
    return (
      current.managedPluginCopyVersion === expected.managedPluginCopyVersion &&
      current.dshVersion === expected.dshVersion &&
      current.sourceFingerprint === expected.sourceFingerprint &&
      current.managedUiPlugins === expected.managedUiPlugins &&
      current.corePluginsFingerprint === expected.corePluginsFingerprint &&
      JSON.stringify(current.managedBundles) === JSON.stringify(expected.managedBundles)
    )
  } catch {
    return false
  }
}

function usesEmptyUiPluginProfile(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.VITE_WEWORK_E2E === 'true' &&
    environment.WEWORK_E2E_EMPTY_CORE_DSH_UI_PROFILE === '1'
  )
}
