import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  applyBrandRuntimeEnvironment,
  type BrandRuntimeMetadata,
} from './brand-runtime-environment.js'
import { migrateWorkbenchHome } from './workbench-home-migration.js'
import { assertExecutorWorkbenchCompatibility } from './workbench-executor-schema.js'
import { assertCodexHomeCanMove } from './workbench-codex-migration.js'
import {
  executorMigrationLock,
  type WorkbenchMigrationLockAdapter,
} from './workbench-migration-lock.js'
import { migrateWorkbenchDataInWorker } from './workbench-data-worker.js'

interface WorkbenchEnvironmentOptions {
  environment: NodeJS.ProcessEnv
  metadata: BrandRuntimeMetadata
  homeDirectory: string
  validateExecutor?: (environment: NodeJS.ProcessEnv) => Promise<void>
}

export interface WorkbenchPaths {
  root: string
  shared: string
  agents: string
  desktop: string
  codexHome: string
  claudeHome: string
  capabilities: string
  migrations: string
}

function resolveWorkbenchUserHome(options: WorkbenchEnvironmentOptions): string {
  // macOS Electron getPath('home') ignores HOME, unlike the executor child.
  const home =
    options.environment.HOME?.trim() ||
    options.environment.USERPROFILE?.trim() ||
    options.homeDirectory
  if (!isAbsolute(home)) throw new Error('Workbench user Home must be an absolute path')
  return resolve(home)
}

export function resolveWorkbenchPaths(options: WorkbenchEnvironmentOptions): WorkbenchPaths {
  const configuredRoot = options.environment.WEGENT_WORKBENCH_HOME?.trim()
  if (configuredRoot && !isAbsolute(configuredRoot)) {
    throw new Error('WEGENT_WORKBENCH_HOME must be an absolute path')
  }
  const namespace = options.metadata.weworkExecutorNamespace?.trim() || 'default'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(namespace)) {
    throw new Error('Invalid Workbench application namespace')
  }
  const root = resolve(
    configuredRoot || join(resolveWorkbenchUserHome(options), '.wegent', 'workbench')
  )
  const desktop = join(root, 'wework', namespace)
  return {
    root,
    shared: join(root, 'shared'),
    agents: join(root, 'agents'),
    desktop,
    codexHome: join(desktop, 'codex'),
    claudeHome: join(desktop, 'claude'),
    capabilities: join(desktop, 'capabilities'),
    migrations: join(desktop, 'migrations'),
  }
}

function defaultExecutorHome(options: WorkbenchEnvironmentOptions): string {
  const home = resolveWorkbenchUserHome(options)
  const namespace = options.metadata.weworkExecutorNamespace?.trim()
  return namespace ? join(home, '.wework', 'apps', namespace) : join(home, '.wework')
}

/** Resolve the post-layout Home without opening or migrating any runtime data. */
export function resolveWorkbenchCodexHome(options: WorkbenchEnvironmentOptions): string {
  const explicit = options.environment.WEGENT_CODEX_HOME?.trim()
  if (explicit) return explicit
  const executorHome = options.environment.WEGENT_EXECUTOR_HOME?.trim()
  return executorHome && resolve(executorHome) !== resolve(defaultExecutorHome(options))
    ? join(executorHome, 'codex')
    : resolveWorkbenchPaths(options).codexHome
}

// Call before starting the managed executor, never while its Home is in use.
export async function prepareWorkbenchEnvironment(
  options: WorkbenchEnvironmentOptions
): Promise<NodeJS.ProcessEnv> {
  const { environment, metadata } = options
  const homeDirectory = resolveWorkbenchUserHome(options)
  const branded = applyBrandRuntimeEnvironment(environment, metadata, homeDirectory)

  const paths = resolveWorkbenchPaths(options)
  const defaultHome = defaultExecutorHome(options)
  const executorHome = branded.WEGENT_EXECUTOR_HOME?.trim() || defaultHome
  if (resolve(executorHome) !== resolve(defaultHome)) return branded
  if (
    ![
      'WORKSPACE_ROOT',
      'WEGENT_WORKSPACE_ROOT',
      'LOCAL_WORKSPACE_ROOT',
      'WEGENT_EXECUTOR_PROJECTS_DIR',
    ].some(key => environment[key]?.trim())
  ) {
    branded.WORKSPACE_ROOT = join(homeDirectory, '.wegent', 'workspace')
  }

  await (options.validateExecutor ?? assertExecutorWorkbenchCompatibility)(branded)
  const executorCommand = branded.WEWORK_EXECUTOR_PATH!
  const codexSourceHome = join(executorHome, 'codex')
  const codexStateDirectory = join(paths.migrations, 'codex-home-v1')
  const capabilitiesSourceHome = join(executorHome, 'capabilities')
  const capabilitiesStateDirectory = join(paths.migrations, 'capabilities-v1')
  const customClaudeHome =
    environment.WEGENT_CLAUDE_HOME?.trim() || environment.CLAUDE_CONFIG_DIR?.trim()
  let claudeHome = customClaudeHome || paths.claudeHome
  const claudeSourceHome = join(executorHome, 'claude')
  const claudeStateDirectory = join(paths.migrations, 'claude-home-v1')

  // One native lock process covers every migration in this startup. Individual
  // migrations receive a non-owning lease so their transaction semantics remain local.
  const lockResources = [executorHome, paths.desktop]
  if (!environment.WEGENT_CODEX_HOME?.trim()) {
    lockResources.push(codexSourceHome, paths.codexHome, codexStateDirectory)
  }
  if (!environment.WEGENT_CAPABILITIES_HOME?.trim()) {
    lockResources.push(capabilitiesSourceHome, paths.capabilities, capabilitiesStateDirectory)
  }
  if (!customClaudeHome) {
    lockResources.push(claudeSourceHome, paths.claudeHome, claudeStateDirectory)
  }
  const migrationLock = await executorMigrationLock(executorCommand)(lockResources)
  const acquireLock: WorkbenchMigrationLockAdapter = async () => ({
    assertHeld: () => migrationLock.assertHeld(),
    release: async () => undefined,
  })
  try {
    if (!environment.WEGENT_CODEX_HOME?.trim()) {
      await migrateWorkbenchHome({
        acquireLock,
        sourceHome: codexSourceHome,
        targetHome: paths.codexHome,
        stateDirectory: codexStateDirectory,
        initialize: true,
        beforeMove: home => assertCodexHomeCanMove(executorCommand, home),
      })
    }
    if (!environment.WEGENT_CAPABILITIES_HOME?.trim()) {
      await migrateWorkbenchHome({
        acquireLock,
        sourceHome: capabilitiesSourceHome,
        targetHome: paths.capabilities,
        stateDirectory: capabilitiesStateDirectory,
        initialize: true,
      })
    }
    if (!customClaudeHome) {
      // The user's ~/.claude is not owned by Wework and must never be relocated.
      await migrateWorkbenchHome({
        acquireLock,
        sourceHome: claudeSourceHome,
        targetHome: paths.claudeHome,
        stateDirectory: claudeStateDirectory,
        initialize: true,
        preserveExistingSource: true,
      })
      await migrateWorkbenchHome({
        acquireLock,
        sourceHome: claudeSourceHome,
        targetHome: paths.claudeHome,
        stateDirectory: claudeStateDirectory,
      })
      // Claude hashes the lexical CLAUDE_CONFIG_DIR for Keychain service identity.
      // Keep its lexical spelling while physically relocating the backing data.
      const journal = JSON.parse(
        await readFile(join(claudeStateDirectory, 'workbench-home-migration.json'), 'utf8')
      )
      if (journal.strategy === 'relocate-source') claudeHome = claudeSourceHome
    }
    migrationLock.assertHeld()
    await migrateWorkbenchDataInWorker({
      source: executorHome,
      target: paths.desktop,
      state: paths.migrations,
    })
    migrationLock.assertHeld()
  } finally {
    await migrationLock.release()
  }
  return {
    ...branded,
    WEGENT_EXECUTOR_HOME: paths.desktop,
    WEGENT_WORKBENCH_HOME: paths.root,
    WEGENT_CODEX_HOME: resolveWorkbenchCodexHome(options),
    WEGENT_CAPABILITIES_HOME: environment.WEGENT_CAPABILITIES_HOME?.trim() || paths.capabilities,
    WEGENT_CLAUDE_HOME: claudeHome,
  }
}
