import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import semver from 'semver'

export const CORE_DSH_VERSION = '0.1.1-rc.2'
const PROFILE_NAME = 'wework-core'
const PROFILE_STAMP = '.wework-runtime.json'
const CORE_DEPENDENCIES = [
  '@wegent/dsh-app-wework',
  '@wegent/dsh-electron-host',
  '@wegent/dsh-executor-runtime',
  '@wegent/dsh-terminal-runtime',
] as const
const REMOVED_CORE_DEPENDENCIES = ['@wegent/dsh-sidebar-example', 'dsh-better-sidebar'] as const
const CORE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@wegent/dsh-electron-host',
  '@wegent/dsh-terminal-runtime',
  '@wegent/dsh-app-wework',
  '@deepseek-ai/dsh-web-app',
  '@wegent/dsh-executor-runtime',
] as const

interface RuntimeIdentity {
  dshVersion: string
  role: string
  sourceFingerprint: string
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
  appPluginRoot: string
  pluginRoot: string
  executorPluginRoot: string
  terminalPluginRoot: string
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
  await prepareProfile({
    runtime,
    dshHome,
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
  const appPluginRoot = join(runtime.pluginsRoot, 'wework-app')
  await readFile(join(appPluginRoot, 'package.json'))
  const pluginRoot = join(runtime.pluginsRoot, 'wework-electron-host')
  await readFile(join(pluginRoot, 'package.json'))
  const executorPluginRoot = join(runtime.pluginsRoot, 'wework-executor-runtime')
  await readFile(join(executorPluginRoot, 'package.json'))
  const terminalPluginRoot = join(runtime.pluginsRoot, 'wework-terminal-runtime')
  await readFile(join(terminalPluginRoot, 'package.json'))
  return {
    ...runtime,
    appPluginRoot,
    pluginRoot,
    executorPluginRoot,
    terminalPluginRoot,
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
}): Promise<void> {
  const profileRoot = join(options.dshHome, 'profiles', PROFILE_NAME)
  const workspacePath = join(profileRoot, 'pnpm-workspace.yaml')
  const expectedStamp = {
    dshVersion: options.runtime.version,
    role: 'core',
    sourceFingerprint: options.runtime.sourceFingerprint,
  }
  const currentManifest = await readJsonFile(join(profileRoot, 'package.json'))
  const currentManifestRoot = objectRecord(currentManifest)
  const stampIsCurrent = await stampMatches(join(profileRoot, PROFILE_STAMP), expectedStamp)
  const coreDependenciesAreCurrent = hasCurrentCoreDependencies(currentManifest, options.runtime)
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
        !CORE_DEPENDENCIES.includes(name as never) &&
        !REMOVED_CORE_DEPENDENCIES.includes(name as never)
    )
  )
  const currentProfile = objectRecord(objectRecord(currentManifestRoot.dsh).profile)
  const currentBundles = stringArray(currentProfile.bundles)
  const userBundles = currentBundles.filter(
    bundle =>
      !CORE_BUNDLES.includes(bundle as never) &&
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
          '@wegent/dsh-app-wework': `file:${options.runtime.appPluginRoot}`,
          '@wegent/dsh-electron-host': `file:${options.runtime.pluginRoot}`,
          '@wegent/dsh-executor-runtime': `file:${options.runtime.executorPluginRoot}`,
          '@wegent/dsh-terminal-runtime': `file:${options.runtime.terminalPluginRoot}`,
        },
        dsh: {
          profile: {
            bundles: [...CORE_BUNDLES, ...userBundles],
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
  const pluginPackages = [
    ['@wegent/dsh-app-wework', options.runtime.appPluginRoot],
    ['@wegent/dsh-electron-host', options.runtime.pluginRoot],
    ['@wegent/dsh-executor-runtime', options.runtime.executorPluginRoot],
    ['@wegent/dsh-terminal-runtime', options.runtime.terminalPluginRoot],
  ] as const
  for (const [packageName, source] of pluginPackages) {
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

function hasCurrentCoreDependencies(manifest: unknown, runtime: CoreDshRuntime): boolean {
  const dependencies = stringRecord(objectRecord(manifest).dependencies)
  return (
    dependencies['@wegent/dsh-app-wework'] === `file:${runtime.appPluginRoot}` &&
    dependencies['@wegent/dsh-electron-host'] === `file:${runtime.pluginRoot}` &&
    dependencies['@wegent/dsh-executor-runtime'] === `file:${runtime.executorPluginRoot}` &&
    dependencies['@wegent/dsh-terminal-runtime'] === `file:${runtime.terminalPluginRoot}`
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

async function stampMatches(path: string, expected: RuntimeIdentity): Promise<boolean> {
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as RuntimeIdentity
    return (
      current.dshVersion === expected.dshVersion &&
      current.sourceFingerprint === expected.sourceFingerprint
    )
  } catch {
    return false
  }
}
