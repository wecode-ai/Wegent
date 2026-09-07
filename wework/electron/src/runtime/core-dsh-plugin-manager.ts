import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { runtimeNodeArgs } from './electron-node-runtime.js'

const PROFILE_NAME = 'wework-core'
const STATE_FILE = '.wework-core-plugins.json'
const SNAPSHOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  STATE_FILE,
] as const

export const IMMUTABLE_CORE_DSH_PLUGINS = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@wegent/dsh-app-wework',
  '@wegent/dsh-electron-host',
  '@wegent/dsh-executor-runtime',
  '@wegent/dsh-terminal-runtime',
  '@wegent/dsh-plugin-runtime',
  '@wegent/dsh-wework-plugin-developer',
])

export interface CoreDshPlugin {
  name: string
  displayName: string
  description: string
  version: string
  requestedSpec: string
  enabled: boolean
  immutable: boolean
  homepage: string
  repository: string
  canUpdate: boolean
  canToggle: boolean
  canUninstall: boolean
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
  [key: string]: unknown
}

interface PluginState {
  version: 1
  order: string[]
  disabled: string[]
}

interface PackageManifest {
  name?: string
  displayName?: string
  description?: string
  version?: string
  homepage?: string
  repository?: string | { url?: string }
  wework?: {
    codexPlugin?: string
  }
  dsh?: {
    bundle?: {
      patch?: string
    }
  }
}

export interface CoreDshDevelopmentPlugin {
  name: string
  displayName: string
  description: string
  version: string
  sourceRoot: string
}

interface CommandResult {
  stdout: string
  stderr: string
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<CommandResult>

export interface CoreDshPluginManagerOptions {
  dshHome: string
  runtimeRoot: string
  dshEntry: string
  nodeCommand: string
  environment: NodeJS.ProcessEnv
  runCommand?: CommandRunner
}

export class CoreDshPluginManager {
  private readonly profileRoot: string
  private readonly runCommand: CommandRunner
  private operation: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: CoreDshPluginManagerOptions) {
    this.profileRoot = join(options.dshHome, 'profiles', PROFILE_NAME)
    this.runCommand = options.runCommand ?? runCommand
  }

  list(): Promise<CoreDshPlugin[]> {
    return this.serial(() => this.readInventory())
  }

  install(spec: string): Promise<CoreDshPlugin[]> {
    return this.mutate(async () => {
      validateSpec(spec)
      const before = await this.readManifest()
      const beforeNames = new Set(Object.keys(before.dependencies ?? {}))
      await this.runPnpm(['add', spec.trim()])
      const after = await this.readManifest()
      const added = Object.keys(after.dependencies ?? {}).filter(name => !beforeNames.has(name))
      if (added.length !== 1) {
        throw new Error(
          added.length === 0
            ? 'The requested DSH plugin is already installed'
            : 'Installing one DSH plugin added multiple direct dependencies'
        )
      }
      const [name] = added
      await this.requireBundle(name)
      const state = await this.readState(after)
      state.order = [...state.order.filter(item => item !== name), name]
      state.disabled = state.disabled.filter(item => item !== name)
      await this.writeState(state)
      await this.writeActiveBundles(after, state)
      await this.preflight()
    })
  }

  ensureDevelopmentPlugin(sourceRoot: string): Promise<CoreDshDevelopmentPlugin> {
    return this.serial(async () => {
      const source = await readDevelopmentPlugin(sourceRoot)
      const snapshot = await this.snapshot()
      try {
        await this.runPnpm(['add', `link:${source.sourceRoot}`])
        await this.requireBundle(source.name)
        const manifest = await this.readManifest()
        const state = await this.readState(manifest)
        state.order = [...state.order.filter(item => item !== source.name), source.name]
        state.disabled = state.disabled.filter(item => item !== source.name)
        await this.writeState(state)
        await this.writeActiveBundles(manifest, state)
        await this.writeDevelopmentPatch(source.sourceRoot)
        await this.preflight()
        return source
      } catch (error) {
        await this.restore(snapshot).catch(restoreError => {
          throw new Error(
            `${errorMessage(error)}\nProfile recovery failed: ${errorMessage(restoreError)}`
          )
        })
        throw error
      }
    })
  }

  update(name: string): Promise<CoreDshPlugin[]> {
    return this.mutate(async () => {
      validateMutableName(name)
      const manifest = await this.readManifest()
      if (!manifest.dependencies?.[name]) throw new Error(`${name} is not installed`)
      await this.runPnpm(['update', name])
      await this.requireBundle(name)
      await this.preflight()
    })
  }

  setEnabled(name: string, enabled: boolean): Promise<CoreDshPlugin[]> {
    return this.mutate(async () => {
      validateMutableName(name)
      const manifest = await this.readManifest()
      if (!manifest.dependencies?.[name]) throw new Error(`${name} is not installed`)
      await this.requireBundle(name)
      const state = await this.readState(manifest)
      if (!state.order.includes(name)) state.order.push(name)
      state.disabled = enabled
        ? state.disabled.filter(item => item !== name)
        : [...new Set([...state.disabled, name])]
      await this.writeState(state)
      await this.writeActiveBundles(manifest, state)
      await this.preflight()
    })
  }

  uninstall(name: string): Promise<CoreDshPlugin[]> {
    return this.mutate(async () => {
      validateMutableName(name)
      const manifest = await this.readManifest()
      if (!manifest.dependencies?.[name]) throw new Error(`${name} is not installed`)
      await this.runPnpm(['remove', name])
      const next = await this.readManifest()
      const state = await this.readState(next)
      state.order = state.order.filter(item => item !== name)
      state.disabled = state.disabled.filter(item => item !== name)
      await this.writeState(state)
      await this.writeActiveBundles(next, state)
      await this.preflight()
    })
  }

  private serial<Result>(action: () => Promise<Result>): Promise<Result> {
    const next = this.operation.then(action, action)
    this.operation = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private mutate(action: () => Promise<void>): Promise<CoreDshPlugin[]> {
    return this.serial(async () => {
      const snapshot = await this.snapshot()
      try {
        await action()
        return await this.readInventory()
      } catch (error) {
        await this.restore(snapshot).catch(restoreError => {
          throw new Error(
            `${errorMessage(error)}\nProfile recovery failed: ${errorMessage(restoreError)}`
          )
        })
        throw error
      }
    })
  }

  private async readInventory(): Promise<CoreDshPlugin[]> {
    const manifest = await this.readManifest()
    const state = await this.readState(manifest)
    const active = new Set(manifest.dsh?.profile?.bundles ?? [])
    const names = [
      ...new Set([
        ...(manifest.dsh?.profile?.bundles ?? []),
        ...Object.keys(manifest.dependencies ?? {}),
        ...state.order,
      ]),
    ]
    const plugins = await Promise.all(
      names.map(async name => {
        const installed = await this.readPackage(name)
        if (!installed) return null
        const immutable = IMMUTABLE_CORE_DSH_PLUGINS.has(name)
        if (!immutable && !installed.dsh?.bundle?.patch) return null
        const requestedSpec = manifest.dependencies?.[name] ?? ''
        return {
          name,
          displayName: installed.displayName || installed.name || name,
          description: installed.description || '',
          version: installed.version || '',
          requestedSpec,
          enabled: active.has(name),
          immutable,
          homepage: installed.homepage || '',
          repository: repositoryUrl(installed.repository),
          canUpdate: !immutable && Boolean(requestedSpec),
          canToggle: !immutable && Boolean(installed.dsh?.bundle?.patch),
          canUninstall: !immutable && Boolean(requestedSpec),
        } satisfies CoreDshPlugin
      })
    )
    return plugins
      .filter((plugin): plugin is CoreDshPlugin => plugin !== null)
      .sort((left, right) => {
        if (left.immutable !== right.immutable) return left.immutable ? 1 : -1
        return left.displayName.localeCompare(right.displayName)
      })
  }

  private async readState(manifest: ProfileManifest): Promise<PluginState> {
    const stored = await readJson(join(this.profileRoot, STATE_FILE))
    const dependencies = await this.bundleDependencies(manifest)
    const activeOrder = (manifest.dsh?.profile?.bundles ?? []).filter(
      name => !IMMUTABLE_CORE_DSH_PLUGINS.has(name)
    )
    const order = validStringArray(stored?.order)
      ? [...stored.order.filter(name => dependencies.includes(name))]
      : []
    for (const name of [...activeOrder, ...dependencies]) {
      if (!order.includes(name)) order.push(name)
    }
    const disabled = validStringArray(stored?.disabled)
      ? stored.disabled.filter(name => dependencies.includes(name))
      : dependencies.filter(name => !activeOrder.includes(name))
    return { version: 1, order, disabled }
  }

  private async bundleDependencies(manifest: ProfileManifest): Promise<string[]> {
    const names = Object.keys(manifest.dependencies ?? {}).filter(
      name => !IMMUTABLE_CORE_DSH_PLUGINS.has(name)
    )
    const inspected = await Promise.all(
      names.map(async name => ({
        name,
        bundle: Boolean((await this.readPackage(name))?.dsh?.bundle?.patch),
      }))
    )
    return inspected.filter(item => item.bundle).map(item => item.name)
  }

  private async writeActiveBundles(manifest: ProfileManifest, state: PluginState): Promise<void> {
    const current = manifest.dsh?.profile?.bundles ?? []
    const builtIns = current.filter(name => IMMUTABLE_CORE_DSH_PLUGINS.has(name))
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
    const disabled = new Set(state.disabled)
    const enabledUsers = state.order.filter(name => dependencies.has(name) && !disabled.has(name))
    manifest.dsh = {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...builtIns, ...enabledUsers],
      },
    }
    await writeJson(join(this.profileRoot, 'package.json'), manifest)
  }

  private writeState(state: PluginState): Promise<void> {
    return writeJson(join(this.profileRoot, STATE_FILE), state)
  }

  private async requireBundle(name: string): Promise<void> {
    const manifest = await this.readPackage(name)
    const patch = manifest?.dsh?.bundle?.patch
    if (!manifest || typeof patch !== 'string' || !patch.trim()) {
      throw new Error(`${name} does not declare dsh.bundle.patch`)
    }
    await access(join(this.packageRoot(name), patch))
  }

  private readManifest(): Promise<ProfileManifest> {
    return readRequiredJson(join(this.profileRoot, 'package.json'))
  }

  private async readPackage(name: string): Promise<PackageManifest | null> {
    const profilePackage = await readJson(join(this.packageRoot(name), 'package.json'))
    if (profilePackage) return profilePackage as PackageManifest
    return (await readJson(
      join(this.options.runtimeRoot, 'node_modules', ...name.split('/'), 'package.json')
    )) as PackageManifest | null
  }

  private packageRoot(name: string): string {
    return join(this.profileRoot, 'node_modules', ...name.split('/'))
  }

  private async runPnpm(args: string[]): Promise<void> {
    const command = this.options.nodeCommand
    const pnpmEntry = join(this.options.runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    try {
      await this.runCommand(
        command,
        runtimeNodeArgs(this.options.environment, [pnpmEntry, ...args]),
        this.pnpmCommandOptions()
      )
    } catch (error) {
      const matcher = parseBlockedBuildMatcher(commandOutput(error))
      if (!matcher) throw commandError('pnpm', error)
      await allowBuild(this.profileRoot, matcher)
      await this.runCommand(
        command,
        runtimeNodeArgs(this.options.environment, [pnpmEntry, ...args]),
        this.pnpmCommandOptions()
      ).catch(reason => {
        throw commandError('pnpm', reason)
      })
    }
  }

  private async preflight(): Promise<void> {
    await this.runCommand(
      this.options.nodeCommand,
      runtimeNodeArgs(this.options.environment, [
        this.options.dshEntry,
        '--profile',
        PROFILE_NAME,
        '--dump-config',
      ]),
      this.preflightCommandOptions()
    ).catch(error => {
      throw commandError('DSH profile validation', error)
    })
  }

  private async writeDevelopmentPatch(sourceRoot: string): Promise<void> {
    const patch = [
      '- id: hmr',
      '  disabled: false',
      '  config:',
      '    root:',
      `      - ${JSON.stringify(sourceRoot)}`,
      '    ignored:',
      "      - '**/node_modules'",
      "      - '**/.git'",
      '    debounce: 100',
      '',
    ].join('\n')
    await writeFile(join(this.profileRoot, 'cordis.patch.yml'), patch, { mode: 0o600 })
  }

  private pnpmCommandOptions(): { cwd: string; env: NodeJS.ProcessEnv } {
    return this.commandOptions(this.profileRoot)
  }

  private preflightCommandOptions(): { cwd: string; env: NodeJS.ProcessEnv } {
    return this.commandOptions(this.options.runtimeRoot)
  }

  private commandOptions(cwd: string): { cwd: string; env: NodeJS.ProcessEnv } {
    return {
      cwd,
      env: {
        ...this.options.environment,
        DSH_HOME: this.options.dshHome,
      },
    }
  }

  private async snapshot(): Promise<Map<string, Buffer | null>> {
    const snapshot = new Map<string, Buffer | null>()
    for (const name of SNAPSHOT_FILES) {
      snapshot.set(name, await readBuffer(join(this.profileRoot, name)))
    }
    return snapshot
  }

  private async restore(snapshot: Map<string, Buffer | null>): Promise<void> {
    await mkdir(this.profileRoot, { recursive: true, mode: 0o700 })
    for (const [name, content] of snapshot) {
      const path = join(this.profileRoot, name)
      if (content === null) await rm(path, { force: true })
      else await writeFile(path, content, { mode: 0o600 })
    }
    if (snapshot.get('pnpm-lock.yaml')) {
      await this.runPnpm(['install', '--frozen-lockfile'])
    }
  }
}

export async function validateCoreDshDevelopmentPlugin(
  sourceRoot: string
): Promise<CoreDshDevelopmentPlugin> {
  return readDevelopmentPlugin(sourceRoot)
}

export function parseBlockedBuildMatcher(output: string): string | null {
  if (!output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) return null
  const matches = [...output.matchAll(/^\s{2}("[^"]+"|'[^']+'|[^:\n]+):\s*(?:true|false)\s*$/gm)]
  const raw = matches.at(-1)?.[1]?.trim()
  return raw ? raw.replace(/^(['"])(.*)\1$/, '$2') : null
}

async function allowBuild(profileRoot: string, matcher: string): Promise<void> {
  const path = join(profileRoot, 'pnpm-workspace.yaml')
  let workspace = await readFile(path, 'utf8')
  if (workspace.includes(`${JSON.stringify(matcher)}: true`)) return
  if (!/^allowBuilds:\s*$/m.test(workspace)) {
    workspace = `${workspace.trimEnd()}\n\nallowBuilds:\n`
  }
  workspace = workspace.replace(
    /^allowBuilds:\s*$/m,
    `allowBuilds:\n  ${JSON.stringify(matcher)}: true`
  )
  await writeFile(path, `${workspace.trimEnd()}\n`, { mode: 0o600 })
}

function validateSpec(spec: string): void {
  const value = spec.trim()
  if (
    typeof spec !== 'string' ||
    !value ||
    spec.length > 2048 ||
    value.startsWith('-') ||
    /^(?:\.{1,2}(?:[\\/]|$)|(?:file|link):\.{1,2}(?:[\\/]|$))/.test(value) ||
    /[\r\n\0]/.test(spec)
  ) {
    throw new Error('Enter a valid DSH plugin package, Git URL, or absolute local directory')
  }
}

function validateMutableName(name: string): void {
  if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) {
    throw new Error('Invalid DSH plugin name')
  }
  if (IMMUTABLE_CORE_DSH_PLUGINS.has(name)) {
    throw new Error(`${name} is a built-in Core DSH plugin`)
  }
}

async function readDevelopmentPlugin(sourceRoot: string): Promise<CoreDshDevelopmentPlugin> {
  const input = sourceRoot.trim()
  if (!input || !isAbsolute(input)) {
    throw new Error('Wework plugin development requires an absolute source directory')
  }
  const root = resolve(input)
  const manifest = (await readRequiredJson(join(root, 'package.json'))) as PackageManifest
  const name = manifest.name?.trim() ?? ''
  validateMutableName(name)
  const patch = manifest.dsh?.bundle?.patch?.trim()
  if (!patch) throw new Error(`${name} does not declare dsh.bundle.patch`)
  const patchPath = resolve(root, patch)
  if (relative(root, patchPath).startsWith('..') || isAbsolute(relative(root, patchPath))) {
    throw new Error(`${name} declares a dsh.bundle.patch outside the plugin directory`)
  }
  if (!(await stat(patchPath)).isFile()) {
    throw new Error(`${name} declares a dsh.bundle.patch that is not a file`)
  }
  await validateNestedCodexPlugin(root, manifest)
  return {
    name,
    displayName: manifest.displayName?.trim() || name,
    description: manifest.description?.trim() || '',
    version: manifest.version?.trim() || '',
    sourceRoot: root,
  }
}

async function validateNestedCodexPlugin(root: string, manifest: PackageManifest): Promise<void> {
  const declaredPath = manifest.wework?.codexPlugin?.trim()
  if (!declaredPath) return
  const codexPluginRoot = resolve(root, declaredPath)
  const nestedPath = relative(root, codexPluginRoot)
  if (nestedPath.startsWith('..') || isAbsolute(nestedPath)) {
    throw new Error(`${manifest.name} declares wework.codexPlugin outside the plugin directory`)
  }
  const codexManifest = (await readRequiredJson(
    join(codexPluginRoot, '.codex-plugin', 'plugin.json')
  )) as { name?: unknown }
  if (typeof codexManifest.name !== 'string' || !codexManifest.name.trim()) {
    throw new Error(`${manifest.name} has an invalid nested Codex plugin manifest`)
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function readRequiredJson<Value>(path: string): Promise<Value> {
  const value = await readJson(path)
  if (!value) throw new Error(`Required Core DSH profile file is unavailable: ${path}`)
  return value as Value
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function repositoryUrl(value: PackageManifest['repository']): string {
  if (typeof value === 'string') return value
  return typeof value?.url === 'string' ? value.url : ''
}

async function readBuffer(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

function commandOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const detail = error as { stdout?: string; stderr?: string }
  return `${detail.stdout ?? ''}\n${detail.stderr ?? ''}`
}

function commandError(stage: string, error: unknown): Error {
  const output = redactDiagnostics(commandOutput(error).trim())
  return new Error(
    output ? `${stage} failed\n${output.slice(-8_000)}` : `${stage} failed: ${errorMessage(error)}`
  )
}

function redactDiagnostics(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/((?:token|password|authorization|_authToken)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
    }, 120_000)
    timeout.unref()
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', error => {
      clearTimeout(timeout)
      reject(Object.assign(error, { stdout, stderr }))
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolve({ stdout, stderr })
      else
        reject(Object.assign(new Error(`${command} exited with code ${code}`), { stdout, stderr }))
    })
  })
}
