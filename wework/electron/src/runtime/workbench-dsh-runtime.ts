import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import semver from 'semver'
import { runtimeNodeArgs } from './electron-node-runtime.js'
import * as tar from 'tar'
import {
  selectBundledDshRuntimeMatching,
  type BundledDshRuntime,
  type CommandRunner,
} from './core-dsh-runtime.js'

export const WORKBENCH_DSH_VERSION = '0.1.0-rc.8'

export interface WorkbenchAppManifest {
  name: string
  displayName: string
  version: string
  type: 'deepseek-harness-plugin-bundle'
  description: string
  packages?: Array<{ name: string; role: string; path: string }>
  entry: {
    installPackage: string
    profile: string
  }
  requirements: {
    dsh: string
    node: string
  }
  plugins?: Array<{
    spec: string
    path?: string
  }>
}

export interface PrepareWorkbenchDshOptions {
  runtimeRoot: string
  dataDirectory: string
  installationId: string
  packagePath: string
  manifest: WorkbenchAppManifest
  environment: NodeJS.ProcessEnv
  port: number
  modelBaseUrl?: string | null
  contextBaseUrl?: string | null
  contextToken?: string | null
  includeElectronHostBridge?: boolean
  run?: CommandRunner
}

export interface WorkbenchDshLaunch {
  command: string
  entry: string
  args: string[]
  cwd: string
  dshHome: string
  environment: NodeJS.ProcessEnv
  profile: string
  url: string
  version: string
  sourceFingerprint: string
}

export interface WorkbenchProjectPnpmCommand {
  command: string
  argsPrefix: string[]
  environment: NodeJS.ProcessEnv
}

export interface ResolveWorkbenchProjectPnpmOptions {
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
  versionRequirement?: string
}

export async function resolveWorkbenchProjectPnpmCommand(
  options: ResolveWorkbenchProjectPnpmOptions
): Promise<WorkbenchProjectPnpmCommand> {
  const runtime = await selectBundledDshRuntimeMatching(
    options.runtimeRoot,
    'workbench',
    options.versionRequirement ?? WORKBENCH_DSH_VERSION
  )
  const nodeCommand = options.environment.WEWORK_NODE_PATH?.trim() || 'node'
  const pnpmEntry = join(runtime.root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  await readFile(pnpmEntry)
  const environment = withRuntimePath(options.environment, runtime.root, nodeCommand)
  return {
    command: nodeCommand,
    argsPrefix: runtimeNodeArgs(environment, [pnpmEntry]),
    environment,
  }
}

export async function prepareWorkbenchDshLaunch(
  options: PrepareWorkbenchDshOptions
): Promise<WorkbenchDshLaunch> {
  const runtime = await selectBundledDshRuntimeMatching(
    options.runtimeRoot,
    'workbench',
    options.manifest.requirements.dsh
  )
  validateRequirements(options.manifest, runtime)
  const nodeCommand = options.environment.WEWORK_NODE_PATH?.trim() || 'node'
  const dshHome = resolve(
    options.dataDirectory,
    'harness-apps',
    'instances',
    safeName(options.installationId)
  )
  const packages = await prepareInstanceBundle(options, runtime, dshHome)
  await prepareProfile(dshHome, options.manifest.entry.profile)
  const environment = runtimeEnvironment(
    options.environment,
    runtime.root,
    dshHome,
    nodeCommand,
    options
  )
  const run = options.run ?? runCommand
  await installPlugins(
    runtime,
    dshHome,
    options.manifest.entry.profile,
    packages,
    nodeCommand,
    environment,
    run
  )
  if (options.includeElectronHostBridge !== false) {
    // The workbench is an isolated harness profile. Without the electron-host
    // plugin its DSH client has no route to the scoped host pipe, so calling
    // /wework/electron-host/v1/invoke hits a plain page and every capability
    // (including dshCapture.*) silently degrades. Install the trusted host bridge
    // into the profile so the workbench can reach the owner-scoped capabilities.
    const hostPluginPath = join(runtime.pluginsRoot, 'wework-electron-host')
    const corePluginsRoot = options.environment.WEWORK_CORE_PLUGIN_ROOT?.trim()
    const resolvedHostPluginPath = (await isDirectory(hostPluginPath))
      ? hostPluginPath
      : corePluginsRoot && (await isDirectory(join(corePluginsRoot, 'wework-electron-host')))
        ? join(corePluginsRoot, 'wework-electron-host')
        : null
    if (!resolvedHostPluginPath) {
      throw new Error(
        'Workbench Smart App runtime requires the trusted wework-electron-host plugin'
      )
    }
    await installPlugins(
      runtime,
      dshHome,
      options.manifest.entry.profile,
      [resolvedHostPluginPath],
      nodeCommand,
      environment,
      run
    )
  }
  await installPluginSpecs(
    runtime,
    dshHome,
    options.manifest.entry.profile,
    options.manifest.plugins ?? [],
    nodeCommand,
    environment,
    run
  )
  if (options.contextBaseUrl && options.contextToken) {
    await installPlugins(
      runtime,
      dshHome,
      options.manifest.entry.profile,
      [
        join(runtime.pluginsRoot, 'wework-user-context'),
        join(runtime.pluginsRoot, 'wework-model-context'),
      ],
      nodeCommand,
      environment,
      run
    )
  }
  return {
    command: nodeCommand,
    entry: runtime.entry,
    args: runtimeNodeArgs(environment, [
      runtime.entry,
      '--profile',
      options.manifest.entry.profile,
      '--no-open',
      '--port',
      String(options.port),
    ]),
    cwd: runtime.root,
    dshHome,
    environment,
    profile: options.manifest.entry.profile,
    url: `http://127.0.0.1:${options.port}/`,
    version: runtime.version,
    sourceFingerprint: runtime.sourceFingerprint,
  }
}

function validateRequirements(manifest: WorkbenchAppManifest, runtime: BundledDshRuntime): void {
  if (
    !semver.satisfies(runtime.version, manifest.requirements.dsh, {
      includePrerelease: true,
    })
  ) {
    throw new Error(
      `Smart app requires DeepSeek Harness ${manifest.requirements.dsh}, but Wework provides ${runtime.version}`
    )
  }
  const nodeVersion = process.versions.node
  if (
    !semver.satisfies(nodeVersion, manifest.requirements.node, {
      includePrerelease: true,
    })
  ) {
    throw new Error(
      `Smart app requires Node ${manifest.requirements.node}, but Wework provides ${nodeVersion}`
    )
  }
}

async function prepareInstanceBundle(
  options: PrepareWorkbenchDshOptions,
  runtime: BundledDshRuntime,
  dshHome: string
): Promise<string[]> {
  const destination = join(dshHome, 'wework-package')
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true, mode: 0o700 })
  await copyDirectoryContents(resolve(options.packagePath), destination)
  const packages = await materializeManifestPackages(options.manifest, destination)
  if (options.modelBaseUrl?.trim()) {
    await writeModelSettings(dshHome, options.modelBaseUrl)
    await patchModelProvider(
      join(destination, options.manifest.entry.installPackage, 'cordis.patch.yml')
    )
  }
  await assertPluginDirectories(packages)
  await assertPluginDirectories(
    options.contextBaseUrl && options.contextToken
      ? [
          join(runtime.pluginsRoot, 'wework-user-context'),
          join(runtime.pluginsRoot, 'wework-model-context'),
        ]
      : []
  )
  return packages
}

export async function materializeManifestPackages(
  manifest: WorkbenchAppManifest,
  root: string
): Promise<string[]> {
  const installPackage = join(root, manifest.entry.installPackage)
  if (await isDirectory(installPackage)) return [installPackage]
  const descriptors = manifest.packages ?? []
  if (!descriptors.length) {
    throw new Error(`Smart app install package is missing: ${manifest.entry.installPackage}`)
  }
  const archives = await packageArchives(root)
  const paths: string[] = []
  for (const descriptor of [...descriptors].sort(
    (left, right) =>
      Number(left.role === 'profile-bundle') - Number(right.role === 'profile-bundle')
  )) {
    const archive = archives.get(descriptor.name)
    if (!archive) throw new Error(`Smart app npm package is missing: ${descriptor.name}`)
    const destination = join(root, descriptor.path)
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await tar.x({ file: archive, cwd: destination, strip: 1 })
    paths.push(destination)
  }
  if (!(await isDirectory(installPackage))) {
    throw new Error('Smart app profile bundle was not materialized')
  }
  return paths
}

async function packageArchives(root: string): Promise<Map<string, string>> {
  const archives = new Map<string, string>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tgz')) continue
    const path = join(root, entry.name)
    const name = await npmArchiveName(path)
    if (archives.has(name)) throw new Error(`Smart app npm package is duplicated: ${name}`)
    archives.set(name, path)
  }
  return archives
}

async function npmArchiveName(path: string): Promise<string> {
  let packageName: string | null = null
  await tar.t({
    file: path,
    onReadEntry: entry => {
      if (entry.path !== 'package/package.json') return
      const chunks: Buffer[] = []
      entry.on('data', chunk => chunks.push(Buffer.from(chunk)))
      entry.on('end', () => {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          name?: unknown
        }
        if (typeof value.name === 'string') packageName = value.name
      })
    },
  })
  if (!packageName) throw new Error(`Smart app npm package has no package name: ${basename(path)}`)
  return packageName
}

async function prepareProfile(dshHome: string, profile: string): Promise<void> {
  const profileRoot = join(dshHome, 'profiles', profile)
  await rm(profileRoot, { recursive: true, force: true })
  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  await writeFile(
    join(profileRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profile}`,
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
          },
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  await writeFile(join(profileRoot, 'cordis.yml'), '[]\n', { mode: 0o600 })
  await writeFile(join(profileRoot, 'cordis.patch.yml'), '[]\n', {
    mode: 0o600,
  })
  await writeFile(
    join(profileRoot, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    { mode: 0o600 }
  )
}

async function installPlugins(
  runtime: BundledDshRuntime,
  dshHome: string,
  profile: string,
  packages: string[],
  nodeCommand: string,
  environment: NodeJS.ProcessEnv,
  run: CommandRunner
): Promise<void> {
  if (!packages.length) return
  await run(
    nodeCommand,
    runtimeNodeArgs(environment, [
      runtime.entry,
      'plugin',
      '--profile',
      profile,
      'add',
      '--ignore-scripts',
      ...packages.map(path => `file:${path}`),
    ]),
    { cwd: runtime.root, env: environment }
  )
}

async function installPluginSpecs(
  runtime: BundledDshRuntime,
  dshHome: string,
  profile: string,
  plugins: NonNullable<WorkbenchAppManifest['plugins']>,
  nodeCommand: string,
  environment: NodeJS.ProcessEnv,
  run: CommandRunner
): Promise<void> {
  if (!plugins.length) return
  const packageRoot = join(dshHome, 'wework-package')
  const specs = plugins.map(plugin => {
    if (!plugin.path) return plugin.spec
    const path = resolve(packageRoot, plugin.path)
    if (!path.startsWith(`${packageRoot}${sep}`)) {
      throw new Error('Smart app plugin path escapes the package directory')
    }
    return `file:${path}`
  })
  await assertPluginDirectories(
    plugins.flatMap(plugin => (plugin.path ? [resolve(packageRoot, plugin.path)] : []))
  )
  await run(
    nodeCommand,
    runtimeNodeArgs(environment, [
      runtime.entry,
      'plugin',
      '--profile',
      profile,
      'add',
      '--ignore-scripts',
      ...specs,
    ]),
    { cwd: runtime.root, env: environment }
  )
}

async function patchModelProvider(path: string): Promise<void> {
  const source = await readFile(path, 'utf8')
  await writeFile(path, injectModelProviderPatch(source), {
    mode: 0o600,
  })
}

export function injectModelProviderPatch(source: string): string {
  let provider = false
  let model = false
  const patched = source.split('\n').map(line => {
    const trimmed = line.trimStart()
    const indentation = line.slice(0, line.length - trimmed.length)
    if (!provider && trimmed.startsWith('provider:')) {
      provider = true
      return `${indentation}provider: wework-local`
    }
    if (!model && trimmed.startsWith('model:')) {
      model = true
      return `${indentation}model: wework-selected`
    }
    return line
  })
  if (provider !== model) {
    throw new Error('Smart app exposes an incomplete provider/model pair')
  }
  if (!provider) {
    const existing = patched.join('\n').trim()
    const prefix = existing && existing !== '[]' ? `${existing}\n` : ''
    return `${prefix}${[
      '- id: agent-default-model',
      '  config:',
      '    provider: wework-local',
      '    model: wework-selected',
    ].join('\n')}\n`
  }
  return `${patched.join('\n').replace(/\n+$/, '')}\n`
}

async function writeModelSettings(dshHome: string, baseUrl: string): Promise<void> {
  await writeFile(
    join(dshHome, 'settings.yaml'),
    `llm-pi-ai:
  providers:
    wework-local:
      displayName: Wework
      apiKeyEnv: WEWORK_HARNESS_API_KEY
      api: anthropic-messages
      baseURL: ${baseUrl.replace(/\/+$/, '')}
      models:
        - id: wework-selected
          name: Wework selected model
`,
    { mode: 0o600 }
  )
}

function runtimeEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeRoot: string,
  dshHome: string,
  nodeCommand: string,
  options: PrepareWorkbenchDshOptions
): NodeJS.ProcessEnv {
  return {
    ...withRuntimePath(environment, runtimeRoot, nodeCommand),
    DSH_HOME: dshHome,
    ...(options.modelBaseUrl ? { WEWORK_HARNESS_API_KEY: 'wework-local-router' } : {}),
    ...(options.contextBaseUrl ? { WEWORK_HARNESS_CONTEXT_BASE_URL: options.contextBaseUrl } : {}),
    ...(options.contextToken ? { WEWORK_HARNESS_CONTEXT_TOKEN: options.contextToken } : {}),
  }
}

function withRuntimePath(
  environment: NodeJS.ProcessEnv,
  runtimeRoot: string,
  nodeCommand: string
): NodeJS.ProcessEnv {
  const pathEntries = [join(runtimeRoot, 'node_modules', '.bin')]
  if (isAbsolute(nodeCommand)) pathEntries.push(dirname(nodeCommand))
  if (environment.PATH) pathEntries.push(environment.PATH)
  return { ...environment, PATH: pathEntries.join(delimiter) }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(
        new Error(
          `DeepSeek Harness rejected Smart app packages (${code ?? 'unknown'}): ${stdout.trim()}${stdout.trim() && stderr.trim() ? '\n' : ''}${stderr.trim()}`
        )
      )
    })
  })
}

async function assertPluginDirectories(paths: string[]): Promise<void> {
  for (const path of paths) {
    await readFile(join(path, 'package.json'))
  }
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error('Smart app package contains a symbolic link')
    }
    await cp(join(source, entry.name), join(destination, entry.name), {
      recursive: true,
    })
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function safeName(value: string): string {
  const safe = value
    .trim()
    .replace(/[^0-9A-Za-z.-]/g, '-')
    .slice(0, 80)
  if (!safe) throw new Error('Smart app installation ID is invalid')
  return safe
}
