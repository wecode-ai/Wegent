import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import semver from 'semver'

export const CORE_DSH_VERSION = '0.1.1-rc.2'
const PROFILE_NAME = 'wework-core'
const PROFILE_STAMP = '.wework-runtime.json'
const CORE_PLUGIN_PACKAGES = [
  ['@wegent/dsh-app-wework', 'wework-app'],
  ['@wegent/dsh-electron-host', 'wework-electron-host'],
  ['@wegent/dsh-executor-runtime', 'wework-executor-runtime'],
  ['@wegent/dsh-terminal-runtime', 'wework-terminal-runtime'],
  ['@wegent/dsh-ui-core-apps', 'wework-ui-core-apps'],
  ['@wegent/dsh-ui-core-settings', 'wework-ui-core-settings'],
  ['@wegent/dsh-ui-plugin-center', 'wework-ui-plugin-center'],
  ['@wegent/dsh-ui-applications', 'wework-ui-applications'],
  ['@wegent/dsh-ui-automations', 'wework-ui-automations'],
  ['@wegent/dsh-ui-cloud-work', 'wework-ui-cloud-work'],
] as const
type CorePluginPackage = (typeof CORE_PLUGIN_PACKAGES)[number][0]
const CORE_UI_DEPENDENCIES = CORE_PLUGIN_PACKAGES.slice(4).map(([packageName]) => packageName)
const REMOVED_CORE_DEPENDENCIES = ['@wegent/dsh-sidebar-example', 'dsh-better-sidebar'] as const
const CORE_HOST_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@wegent/dsh-electron-host',
  '@wegent/dsh-terminal-runtime',
  '@wegent/dsh-app-wework',
  '@deepseek-ai/dsh-web-app',
  '@wegent/dsh-executor-runtime',
] as const
const CORE_UI_BUNDLES = [
  '@wegent/dsh-ui-core-apps',
  '@wegent/dsh-ui-core-settings',
  '@wegent/dsh-ui-plugin-center',
  '@wegent/dsh-ui-applications',
  '@wegent/dsh-ui-automations',
  '@wegent/dsh-ui-cloud-work',
] as const
const CORE_BUNDLES = [...CORE_HOST_BUNDLES, ...CORE_UI_BUNDLES] as const

interface RuntimeIdentity {
  dshVersion: string
  role: string
  sourceFingerprint: string
}

interface ProfileStamp extends RuntimeIdentity {
  managedUiPlugins: boolean
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
  pluginRoots: Record<CorePluginPackage, string>
}

export interface CoreDshLaunch {
  command: string
  args: string[]
  cwd: string
  dshHome: string
  environment: NodeJS.ProcessEnv
  profile: string
  version: string
  sourceFingerprint: string
}

export interface PrepareCoreDshOptions {
  runtimeRoot: string
  dataDirectory: string
  environment: NodeJS.ProcessEnv
  port: number
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<void>

export async function prepareCoreDshLaunch(options: PrepareCoreDshOptions): Promise<CoreDshLaunch> {
  const runtime = await selectCoreDshRuntime(options.runtimeRoot)
  const nodeCommand = options.environment.WEWORK_NODE_PATH?.trim() || 'node'
  const dshHome = resolve(options.dataDirectory, 'dsh-core')
  const managedUiPlugins = !usesEmptyUiPluginProfile(options.environment)
  await prepareProfile({
    runtime,
    dshHome,
    managedUiPlugins,
  })
  return {
    command: nodeCommand,
    args: [runtime.entry, '--profile', PROFILE_NAME, '--no-open', '--port', String(options.port)],
    cwd: runtime.root,
    dshHome,
    environment: {
      ...options.environment,
      DSH_HOME: dshHome,
      WEWORK_HARNESS_API_KEY: 'wework-local-router',
    },
    profile: PROFILE_NAME,
    version: runtime.version,
    sourceFingerprint: runtime.sourceFingerprint,
  }
}

export async function selectCoreDshRuntime(root: string): Promise<CoreDshRuntime> {
  const runtime = await selectBundledDshRuntime(root, 'core', CORE_DSH_VERSION)
  const pluginRoots = Object.fromEntries(
    CORE_PLUGIN_PACKAGES.map(([packageName, directory]) => [
      packageName,
      join(runtime.pluginsRoot, directory),
    ])
  ) as Record<CorePluginPackage, string>
  await Promise.all(
    Object.values(pluginRoots).map(pluginRoot => readFile(join(pluginRoot, 'package.json')))
  )
  return {
    ...runtime,
    pluginRoots,
  }
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
  const candidates = (await Promise.all(roots.map(candidate => readRuntime(candidate)))).filter(
    (runtime): runtime is BundledDshRuntime =>
      runtime !== null &&
      runtime.role === role &&
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
}): Promise<void> {
  const profileRoot = join(options.dshHome, 'profiles', PROFILE_NAME)
  const workspacePath = join(profileRoot, 'pnpm-workspace.yaml')
  const expectedStamp: ProfileStamp = {
    dshVersion: options.runtime.version,
    role: 'core',
    sourceFingerprint: options.runtime.sourceFingerprint,
    managedUiPlugins: options.managedUiPlugins,
  }
  const managedDependencies = managedCoreDependencies(options.runtime, options.managedUiPlugins)
  const managedDependencyNames = Object.keys(managedDependencies)
  const managedBundles = options.managedUiPlugins ? CORE_BUNDLES : CORE_HOST_BUNDLES
  const currentManifest = await readJsonFile(join(profileRoot, 'package.json'))
  const currentManifestRoot = objectRecord(currentManifest)
  const stampIsCurrent = await stampMatches(join(profileRoot, PROFILE_STAMP), expectedStamp)
  const coreDependenciesAreCurrent = hasCurrentCoreDependencies(
    currentManifest,
    managedDependencies
  )
  await ensureNodePtySpawnHelpersExecutable(profileRoot)
  if (stampIsCurrent && !hasRemovedCoreDependency(currentManifest) && coreDependenciesAreCurrent) {
    await ensureCoreWorkspace(workspacePath)
    return
  }

  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  if (currentManifest && !coreDependenciesAreCurrent) {
    await Promise.all(
      [
        join(profileRoot, 'pnpm-lock.yaml'),
        join(profileRoot, 'node_modules', '.pnpm', 'lock.yaml'),
        join(profileRoot, 'node_modules', '.modules.yaml'),
      ].map(path => rm(path, { force: true }))
    )
  }
  const currentDependencies = stringRecord(currentManifestRoot.dependencies)
  const userDependencies = Object.fromEntries(
    Object.entries(currentDependencies).filter(
      ([name]) =>
        !managedDependencyNames.includes(name) && !REMOVED_CORE_DEPENDENCIES.includes(name as never)
    )
  )
  const currentProfile = objectRecord(objectRecord(currentManifestRoot.dsh).profile)
  const currentBundles = stringArray(currentProfile.bundles)
  const userBundles = currentBundles.filter(
    bundle =>
      !managedBundles.includes(bundle as never) &&
      !REMOVED_CORE_DEPENDENCIES.includes(bundle as never)
  )
  await writeFile(
    join(profileRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE_NAME}`,
        private: true,
        dependencies: {
          ...userDependencies,
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
  await writeFile(join(profileRoot, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
  await ensureCoreWorkspace(workspacePath)
  for (const packageName of managedDependencyNames) {
    const source = options.runtime.pluginRoots[packageName as CorePluginPackage]
    const destination = join(profileRoot, 'node_modules', ...packageName.split('/'))
    await cp(source, destination, { recursive: true })
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

function hasRemovedCoreDependency(manifest: unknown): boolean {
  const root = objectRecord(manifest)
  const profile = objectRecord(objectRecord(root.dsh).profile)
  const dependencies = stringRecord(root.dependencies)
  const bundles = stringArray(profile.bundles)
  return REMOVED_CORE_DEPENDENCIES.some(name => name in dependencies || bundles.includes(name))
}

function hasCurrentCoreDependencies(
  manifest: unknown,
  managedDependencies: Partial<Record<CorePluginPackage, string>>
): boolean {
  const dependencies = stringRecord(objectRecord(manifest).dependencies)
  return Object.entries(managedDependencies).every(
    ([packageName, source]) => dependencies[packageName] === source
  )
}

function managedCoreDependencies(
  runtime: CoreDshRuntime,
  includeUiPlugins: boolean
): Partial<Record<CorePluginPackage, string>> {
  return Object.fromEntries(
    Object.entries(runtime.pluginRoots)
      .filter(
        ([packageName]) => includeUiPlugins || !CORE_UI_DEPENDENCIES.includes(packageName as never)
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
      return fingerprints.map(fingerprint => join(root, fingerprint as string))
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

async function readRuntime(root: string): Promise<BundledDshRuntime | null> {
  try {
    const identity = JSON.parse(
      await readFile(join(root, 'runtime.json'), 'utf8')
    ) as RuntimeIdentity
    if (
      typeof identity.dshVersion !== 'string' ||
      typeof identity.role !== 'string' ||
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
      role: identity.role,
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
      current.dshVersion === expected.dshVersion &&
      current.sourceFingerprint === expected.sourceFingerprint &&
      current.managedUiPlugins === expected.managedUiPlugins
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
