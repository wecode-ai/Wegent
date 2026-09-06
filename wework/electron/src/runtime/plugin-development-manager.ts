import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  validateCoreDshDevelopmentPlugin,
  type CoreDshDevelopmentPlugin,
} from './core-dsh-plugin-manager.js'
import { RotatingLog } from './rotating-log.js'
import { terminateProcessTree } from './runtime-supervisor.js'

export type PluginDevelopmentStatus =
  | 'validating'
  | 'starting'
  | 'ready'
  | 'reloading'
  | 'error'
  | 'stopping'
  | 'stopped'

export interface PluginDevelopmentError {
  stage: string
  message: string
  timestamp: string
}

export interface PluginDevelopmentSession extends CoreDshDevelopmentPlugin {
  id: string
  status: PluginDevelopmentStatus
  electronPid: number | null
  coreDshPid: number | null
  hmrGeneration: number
  startedAt: string
  updatedAt: string
  hmrUpdatedAt: string | null
  lastError: PluginDevelopmentError | null
  userDataDirectory: string
  logDirectory: string
}

export interface PluginDevelopmentProjectClassification {
  sourceRoot: string
  kind: 'standard' | 'wework-core-dsh-plugin'
  revision: string
  plugin: CoreDshDevelopmentPlugin | null
}

export interface InitializedPluginDevelopmentProject extends CoreDshDevelopmentPlugin {
  kind: 'wework-core-dsh-plugin'
}

interface ChildState {
  status?: PluginDevelopmentStatus
  coreDshPid?: number | null
  hmrGeneration?: number
  updatedAt?: string
  hmrUpdatedAt?: string | null
  lastError?: PluginDevelopmentError | null
}

const INHERITED_ELECTRON_SWITCHES = [
  'no-sandbox',
  'disable-gpu',
  'in-process-gpu',
  'disable-dev-shm-usage',
] as const
const PLUGIN_DEVELOPMENT_APPEARANCE_MODES = new Set(['light', 'dark', 'system'])
const PLUGIN_DEVELOPMENT_LANGUAGES = new Set(['system', 'zh-CN', 'en'])

export interface PluginDevelopmentManagerOptions {
  command: string
  args: string[]
  environment: NodeJS.ProcessEnv
  userDataDirectory: string
  watch?: typeof watch
  onStateChanged?: (session: PluginDevelopmentSession) => void
  onProjectClassificationChanged?: (classification: PluginDevelopmentProjectClassification) => void
}

export function pluginDevelopmentElectronArguments(hasSwitch: (name: string) => boolean): string[] {
  return INHERITED_ELECTRON_SWITCHES.filter(hasSwitch).map(name => `--${name}`)
}

export async function seedPluginDevelopmentPreferences(
  parentUserDataDirectory: string,
  childUserDataDirectory: string
): Promise<void> {
  let preferences: unknown
  try {
    preferences = JSON.parse(
      await readFile(join(parentUserDataDirectory, 'app-preferences.json'), 'utf8')
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!preferences || typeof preferences !== 'object') return

  const source = preferences as Record<string, unknown>
  const inherited: Record<string, unknown> = {}
  if (
    typeof source.appearanceMode === 'string' &&
    PLUGIN_DEVELOPMENT_APPEARANCE_MODES.has(source.appearanceMode)
  ) {
    inherited.appearanceMode = source.appearanceMode
  }
  if (typeof source.language === 'string' && PLUGIN_DEVELOPMENT_LANGUAGES.has(source.language)) {
    inherited.language = source.language
  }
  if (typeof source.telemetryConsentAsked === 'boolean') {
    inherited.telemetryConsentAsked = source.telemetryConsentAsked
  }
  if (typeof source.telemetryEnabled === 'boolean') {
    inherited.telemetryEnabled = source.telemetryEnabled
  }

  await mkdir(childUserDataDirectory, { recursive: true, mode: 0o700 })
  await writeFile(
    join(childUserDataDirectory, 'app-preferences.json'),
    `${JSON.stringify(inherited, null, 2)}\n`,
    { mode: 0o600 }
  )
}

export class PluginDevelopmentManager {
  private child: ChildProcessWithoutNullStreams | null = null
  private session: PluginDevelopmentSession | null = null
  private statePoll: NodeJS.Timeout | null = null
  private statePollGeneration = 0
  private classificationWatcher: FSWatcher | null = null
  private classificationMarkerWatcher: FSWatcher | null = null
  private classificationRefresh: NodeJS.Timeout | null = null
  private observedProjectRoot: string | null = null
  private readonly classifications = new Map<
    string,
    Promise<PluginDevelopmentProjectClassification>
  >()

  constructor(private readonly options: PluginDevelopmentManagerOptions) {}

  async validate(sourceRoot: string): Promise<CoreDshDevelopmentPlugin> {
    return validateCoreDshDevelopmentPlugin(sourceRoot)
  }

  classify(sourceRoot: string): Promise<PluginDevelopmentProjectClassification> {
    const root = resolve(sourceRoot.trim())
    const cached = this.classifications.get(root)
    if (cached) return cached
    const classification = classifyPluginDevelopmentProject(root).catch(error => {
      this.classifications.delete(root)
      throw error
    })
    this.classifications.set(root, classification)
    return classification
  }

  async observe(sourceRoot: string | null): Promise<PluginDevelopmentProjectClassification | null> {
    const root = sourceRoot?.trim() ? resolve(sourceRoot) : null
    if (root === this.observedProjectRoot) return root ? this.classify(root) : null
    this.classificationWatcher?.close()
    this.classificationWatcher = null
    this.classificationMarkerWatcher?.close()
    this.classificationMarkerWatcher = null
    if (this.classificationRefresh) {
      clearTimeout(this.classificationRefresh)
      this.classificationRefresh = null
    }
    this.observedProjectRoot = root
    if (!root) return null
    const classification = await this.classify(root)
    this.classificationWatcher = (this.options.watch ?? watch)(
      root,
      { persistent: false },
      (_event, filename) => {
        const relativePath = String(filename ?? '')
        if (
          relativePath &&
          relativePath !== 'package.json' &&
          relativePath !== '.wework' &&
          !relativePath.endsWith('.yml') &&
          !relativePath.endsWith('.yaml') &&
          !relativePath.startsWith(`.wework${process.platform === 'win32' ? '\\' : '/'}`)
        ) {
          return
        }
        this.scheduleClassificationRefresh(root)
      }
    )
    this.watchClassificationMarkerDirectory(root)
    return classification
  }

  async initialize(sourceRoot: string): Promise<InitializedPluginDevelopmentProject> {
    const root = resolve(sourceRoot.trim())
    if (!sourceRoot.trim()) throw new Error('Select a plugin directory')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const entries = await readdir(root)
    if (entries.length > 0) {
      throw new Error('The selected plugin directory must be empty')
    }
    const slug = pluginSlug(root)
    const packageName = `@wework/${slug}`
    await mkdir(join(root, '.wework'), { recursive: true, mode: 0o700 })
    await writeFiles(root, {
      '.wework/plugin-development.json': `${JSON.stringify(
        { schemaVersion: 1, kind: 'wework-core-dsh-plugin' },
        null,
        2
      )}\n`,
      'package.json': `${JSON.stringify(
        {
          name: packageName,
          displayName: slug,
          description: 'Wework Core DSH plugin',
          version: '0.1.0',
          type: 'module',
          main: './index.js',
          exports: {
            '.': './index.js',
            './client': './client.js',
            './package.json': './package.json',
          },
          dsh: {
            bundle: { patch: './cordis.patch.yml' },
            client: {
              inject: ['@deepseek-ai/dsh-client-runtime', '@wegent/dsh-app-wework'],
              platform: 'web',
            },
          },
          peerDependencies: {
            '@deepseek-ai/cordis': '^4.0.1',
            '@deepseek-ai/dsh-client-runtime': '0.1.1-rc.2',
          },
          files: ['client.js', 'cordis.patch.yml', 'index.js'],
          scripts: { test: 'node --test' },
        },
        null,
        2
      )}\n`,
      'cordis.patch.yml': `- insert:\n    - id: ${slug}\n      name: '${packageName}'\n`,
      'index.js': [
        `export const name = ${JSON.stringify(slug)}`,
        'export function apply() {}',
        '',
      ].join('\n'),
      'client.js': [
        'window.__ModuleLoader__.load({',
        `  id: ${JSON.stringify(packageName)},`,
        '  factory: () => ({',
        "    inject: ['slots', 'wework'],",
        '    apply() {},',
        '  }),',
        '})',
        '',
      ].join('\n'),
    })
    this.classifications.delete(root)
    const plugin = await this.validate(root)
    await this.classify(root)
    return { ...plugin, kind: 'wework-core-dsh-plugin' }
  }

  async list(): Promise<PluginDevelopmentSession[]> {
    await this.refreshChildState()
    return this.session ? [this.session] : []
  }

  async start(sourceRoot: string): Promise<PluginDevelopmentSession> {
    const plugin = await this.validate(sourceRoot)
    if (
      this.session?.sourceRoot === plugin.sourceRoot &&
      this.isRunning() &&
      this.session.status !== 'error' &&
      this.session.status !== 'stopped'
    ) {
      await this.command('focus')
      return this.session
    }
    await this.stop()

    const id = pluginDevelopmentId(plugin.sourceRoot)
    const root = join(this.options.userDataDirectory, 'plugin-development', id)
    const userDataDirectory = join(root, 'user-data')
    const logDirectory = join(root, 'logs')
    const statePath = join(root, 'state.json')
    await mkdir(logDirectory, { recursive: true, mode: 0o700 })
    await seedPluginDevelopmentPreferences(this.options.userDataDirectory, userDataDirectory)
    await rm(statePath, { force: true })
    const environment = pluginDevelopmentEnvironment(
      this.options.environment,
      plugin,
      id,
      userDataDirectory,
      statePath
    )
    const log = new RotatingLog({ path: join(logDirectory, 'wework-plugin-development.log') })
    const child = spawn(
      this.options.command,
      [...this.options.args, '--wework-plugin-development'],
      {
        detached: process.platform !== 'win32',
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    )
    child.stdin.end()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => void log.write('stdout', String(value)))
    child.stderr.on('data', value => void log.write('stderr', String(value)))
    this.child = child
    const startedAt = new Date().toISOString()
    this.session = {
      ...plugin,
      id,
      status: 'starting',
      electronPid: child.pid ?? null,
      coreDshPid: null,
      hmrGeneration: 0,
      startedAt,
      updatedAt: startedAt,
      hmrUpdatedAt: null,
      lastError: null,
      userDataDirectory,
      logDirectory,
    }
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      const expected = this.session?.status === 'stopping'
      this.child = null
      this.stopPolling()
      this.updateSession({
        status: expected || code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error',
        electronPid: null,
        coreDshPid: null,
        ...(expected || code === 0 || signal === 'SIGTERM'
          ? { lastError: null }
          : {
              lastError: {
                stage: 'process',
                message: `Development Wework exited with ${
                  signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
                }`,
                timestamp: new Date().toISOString(),
              },
            }),
      })
      void log.flush()
    })
    child.once('error', error => {
      if (this.child !== child) return
      this.updateSession({
        status: 'error',
        lastError: {
          stage: 'process',
          message: error.message,
          timestamp: new Date().toISOString(),
        },
      })
    })
    this.startPolling()
    this.publish()
    return this.session
  }

  async focus(): Promise<void> {
    await this.command('focus')
  }

  async restartCoreDsh(): Promise<void> {
    await this.command('restart-core-dsh')
  }

  async openDevTools(): Promise<void> {
    await this.command('open-devtools')
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.updateSession({ status: 'stopping' })
    await this.command('stop').catch(() => {})
    await terminateProcessTree(child, 5_000).catch(() => {})
    if (this.child === child) this.child = null
    this.stopPolling()
    this.updateSession({
      status: 'stopped',
      electronPid: null,
      coreDshPid: null,
      lastError: null,
    })
  }

  async deleteData(): Promise<void> {
    const directory = this.session?.userDataDirectory
      ? resolve(this.session.userDataDirectory, '..')
      : null
    await this.stop()
    if (directory) {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    }
    this.session = null
  }

  private async command(name: string): Promise<void> {
    if (!this.session || !this.isRunning()) {
      throw new Error('Wework plugin development instance is not running')
    }
    const environment = pluginDevelopmentEnvironment(
      this.options.environment,
      this.session,
      this.session.id,
      this.session.userDataDirectory,
      join(resolve(this.session.userDataDirectory, '..'), 'state.json')
    )
    const command = spawn(
      this.options.command,
      [...this.options.args, '--wework-plugin-development-command', name],
      {
        env: environment,
        stdio: 'ignore',
        windowsHide: true,
      }
    )
    command.unref()
  }

  private isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null)
  }

  private startPolling(): void {
    this.stopPolling()
    const generation = this.statePollGeneration
    this.statePoll = setInterval(() => void this.refreshChildState(generation), 250)
    this.statePoll.unref()
  }

  private stopPolling(): void {
    this.statePollGeneration += 1
    if (this.statePoll) clearInterval(this.statePoll)
    this.statePoll = null
  }

  private async refreshChildState(generation = this.statePollGeneration): Promise<void> {
    if (!this.session || !this.isRunning()) return
    const statePath = join(resolve(this.session.userDataDirectory, '..'), 'state.json')
    let state: ChildState
    try {
      state = JSON.parse(await readFile(statePath, 'utf8')) as ChildState
    } catch {
      return
    }
    if (generation !== this.statePollGeneration || !this.isRunning()) return
    this.updateSession({
      status: state.status ?? this.session.status,
      coreDshPid: state.coreDshPid ?? null,
      hmrGeneration: state.hmrGeneration ?? this.session.hmrGeneration,
      updatedAt: state.updatedAt ?? this.session.updatedAt,
      hmrUpdatedAt: state.hmrUpdatedAt ?? this.session.hmrUpdatedAt,
      lastError: state.lastError ?? null,
    })
  }

  private updateSession(patch: Partial<PluginDevelopmentSession>): void {
    if (!this.session) return
    const next = { ...this.session, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.session)) return
    this.session = next
    this.publish()
  }

  private publish(): void {
    if (this.session) this.options.onStateChanged?.(this.session)
  }

  private watchClassificationMarkerDirectory(root: string): void {
    this.classificationMarkerWatcher?.close()
    this.classificationMarkerWatcher = null
    try {
      this.classificationMarkerWatcher = (this.options.watch ?? watch)(
        join(root, '.wework'),
        { persistent: false },
        (_event, filename) => {
          if (String(filename ?? '') === 'plugin-development.json') {
            this.scheduleClassificationRefresh(root)
          }
        }
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private scheduleClassificationRefresh(root: string): void {
    if (this.classificationRefresh) clearTimeout(this.classificationRefresh)
    this.classificationRefresh = setTimeout(() => {
      this.classificationRefresh = null
      this.classifications.delete(root)
      void this.classify(root).then(next => {
        this.watchClassificationMarkerDirectory(root)
        this.options.onProjectClassificationChanged?.(next)
      })
    }, 120)
    this.classificationRefresh.unref()
  }
}

async function classifyPluginDevelopmentProject(
  root: string
): Promise<PluginDevelopmentProjectClassification> {
  const markerPath = join(root, '.wework', 'plugin-development.json')
  const packagePath = join(root, 'package.json')
  const markerStat = await safeStat(markerPath)
  const packageStat = await safeStat(packagePath)
  const revision = [markerStat, packageStat]
    .map(value => (value ? `${value.mtimeMs}:${value.size}` : 'missing'))
    .join(':')
  if (!markerStat || !packageStat) {
    return { sourceRoot: root, kind: 'standard', revision, plugin: null }
  }
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      kind?: unknown
      schemaVersion?: unknown
    }
    if (marker.kind !== 'wework-core-dsh-plugin' || marker.schemaVersion !== 1) {
      return { sourceRoot: root, kind: 'standard', revision, plugin: null }
    }
    const plugin = await validateCoreDshDevelopmentPlugin(root)
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    const patchPath = resolve(root, manifest.dsh?.bundle?.patch ?? '')
    const patchStat = await safeStat(patchPath)
    return {
      sourceRoot: root,
      kind: 'wework-core-dsh-plugin',
      revision: `${revision}:${patchStat ? `${patchStat.mtimeMs}:${patchStat.size}` : 'missing'}`,
      plugin,
    }
  } catch {
    return { sourceRoot: root, kind: 'standard', revision, plugin: null }
  }
}

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath)
    await access(path).then(
      () => {
        throw new Error(`Refusing to overwrite ${relativePath}`)
      },
      () => undefined
    )
    await writeFile(path, contents, { mode: 0o600 })
  }
}

function pluginSlug(root: string): string {
  const name = root
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return name?.slice(0, 64).replace(/-+$/g, '') || 'wework-plugin'
}

export function pluginDevelopmentId(sourceRoot: string): string {
  return createHash('sha256').update(resolve(sourceRoot)).digest('hex').slice(0, 16)
}

export function pluginDevelopmentEnvironment(
  base: NodeJS.ProcessEnv,
  plugin: CoreDshDevelopmentPlugin,
  id: string,
  userDataDirectory: string,
  statePath: string
): NodeJS.ProcessEnv {
  const e2eControlUrl = base.WEWORK_E2E_CONTROL_URL?.trim()
  const e2eControlToken = base.WEWORK_E2E_CONTROL_TOKEN?.trim()
  const e2eEnabled = base.WEWORK_PLUGIN_DEVELOPMENT_E2E === '1' && Boolean(e2eControlUrl)
  const environment = { ...base }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.CODEX_HOME
  delete environment.WEGENT_CODEX_HOME
  delete environment.WEGENT_EXECUTOR_LOG_DIR
  delete environment.WEWORK_NODE_PATH
  delete environment.WEWORK_NODE_RUNTIME_KIND
  delete environment.WEWORK_RUNTIME_BIN
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith('WEWORK_E2E_') ||
      key.startsWith('VITE_WEWORK_E2E_') ||
      key.startsWith('VITE_WEWORK_DESKTOP_E2E_')
    ) {
      delete environment[key]
    }
  }
  return {
    ...environment,
    WEWORK_INSTANCE_MODE: 'core-dsh-plugin-development',
    ...(e2eEnabled
      ? {
          WEWORK_E2E_CONTROL_URL: e2eControlUrl,
          ...(e2eControlToken ? { WEWORK_E2E_CONTROL_TOKEN: e2eControlToken } : {}),
          WEWORK_PLUGIN_DEVELOPMENT_E2E: '1',
          WEWORK_PLUGIN_DEVELOPMENT_E2E_WINDOW_LABEL: `plugin-development-${id}`,
        }
      : {}),
    WEWORK_PLUGIN_DEVELOPMENT_ROOT: plugin.sourceRoot,
    WEWORK_PLUGIN_DEVELOPMENT_STATE_PATH: statePath,
    WEWORK_PLUGIN_DEVELOPMENT_TITLE: plugin.displayName,
    WEWORK_APP_IDENTIFIER: `io.wecode.wework.plugin-dev.p${id}`,
    WEWORK_DEV_DOCK_TITLE: `Wework Plugin Development · ${id.slice(0, 4)}`,
    WEWORK_DEV_INSTANCE_LABEL: id,
    WEWORK_DEV_TITLE: `Wework Plugin Development — ${plugin.displayName}`,
    WEWORK_DEV_WORKTREE: plugin.sourceRoot,
    WEWORK_USER_DATA_DIR: userDataDirectory,
    WEGENT_EXECUTOR_HOME: join(userDataDirectory, 'executor-home'),
    WEGENT_EXECUTOR_LOG_DIR: join(userDataDirectory, 'executor-logs'),
  }
}
