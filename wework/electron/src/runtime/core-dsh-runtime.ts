import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const CORE_DSH_VERSION = '0.1.1-rc.2'
const PROFILE_NAME = 'wework-core'
const PROFILE_STAMP = '.wework-runtime.json'

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
  const absoluteRoot = resolve(root)
  const roots = (await isRuntimeRoot(absoluteRoot))
    ? [absoluteRoot]
    : await runtimeDirectories(absoluteRoot)
  const candidates = (await Promise.all(roots.map(candidate => readRuntime(candidate)))).filter(
    (runtime): runtime is BundledDshRuntime =>
      runtime !== null && runtime.role === role && runtime.version === version
  )
  const selected = candidates[0]
  if (!selected) {
    throw new Error(`Bundled ${role} DSH runtime ${version} is unavailable under ${absoluteRoot}`)
  }
  return selected
}

async function prepareProfile(options: {
  runtime: CoreDshRuntime
  dshHome: string
}): Promise<void> {
  const profileRoot = join(options.dshHome, 'profiles', PROFILE_NAME)
  const expectedStamp = {
    dshVersion: options.runtime.version,
    role: 'core',
    sourceFingerprint: options.runtime.sourceFingerprint,
  }
  if (await stampMatches(join(profileRoot, PROFILE_STAMP), expectedStamp)) return

  await rm(profileRoot, { recursive: true, force: true })
  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  await writeFile(
    join(profileRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE_NAME}`,
        private: true,
        dependencies: {
          '@wegent/dsh-app-wework': `file:${options.runtime.appPluginRoot}`,
          '@wegent/dsh-electron-host': `file:${options.runtime.pluginRoot}`,
          '@wegent/dsh-executor-runtime': `file:${options.runtime.executorPluginRoot}`,
          '@wegent/dsh-terminal-runtime': `file:${options.runtime.terminalPluginRoot}`,
        },
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@wegent/dsh-electron-host',
              '@wegent/dsh-terminal-runtime',
              '@wegent/dsh-app-wework',
              '@deepseek-ai/dsh-web-app',
              '@wegent/dsh-executor-runtime',
            ],
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
  await writeFile(
    join(profileRoot, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    { mode: 0o600 }
  )
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
  await writeFile(join(profileRoot, PROFILE_STAMP), `${JSON.stringify(expectedStamp, null, 2)}\n`, {
    mode: 0o600,
  })
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
    // Fall back to directory discovery for a direct development runtime root.
  }
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
