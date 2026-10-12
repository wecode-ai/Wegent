import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  applyBrandRuntimeEnvironment,
  type BrandRuntimeMetadata,
} from './brand-runtime-environment.js'
import { migrateWorkbenchHome } from './workbench-home-migration.js'
import { assertExecutorWorkbenchCompatibility } from './workbench-executor-schema.js'
import { assertCodexHomeCanMove } from './workbench-codex-migration.js'
import { executorMigrationLock } from './workbench-migration-lock.js'
import { migrateWorkbenchDataInWorker } from './workbench-data-worker.js'

interface WorkbenchEnvironmentOptions {
  environment: NodeJS.ProcessEnv
  metadata: BrandRuntimeMetadata
  homeDirectory: string
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

// Call before starting the managed executor, never while its Home is in use.
export async function prepareWorkbenchEnvironment(
  options: WorkbenchEnvironmentOptions
): Promise<NodeJS.ProcessEnv> {
  const { environment, metadata } = options
  const homeDirectory = resolveWorkbenchUserHome(options)
  const branded = applyBrandRuntimeEnvironment(environment, metadata, homeDirectory)

  const paths = resolveWorkbenchPaths(options)
  const defaultExecutorHome = metadata.weworkExecutorNamespace?.trim()
    ? join(homeDirectory, '.wework', 'apps', metadata.weworkExecutorNamespace.trim())
    : join(homeDirectory, '.wework')
  const executorHome = branded.WEGENT_EXECUTOR_HOME?.trim() || defaultExecutorHome
  if (resolve(executorHome) !== resolve(defaultExecutorHome)) return branded
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

  await assertExecutorWorkbenchCompatibility(branded)
  const acquireLock = executorMigrationLock(branded.WEWORK_EXECUTOR_PATH!)
  if (!environment.WEGENT_CODEX_HOME?.trim())
    await migrateWorkbenchHome({
      acquireLock,
      sourceHome: join(executorHome, 'codex'),
      targetHome: paths.codexHome,
      stateDirectory: join(paths.migrations, 'codex-home-v1'),
      initialize: true,
      beforeMove: home => assertCodexHomeCanMove(branded.WEWORK_EXECUTOR_PATH!, home),
    })
  if (!environment.WEGENT_CAPABILITIES_HOME?.trim()) {
    await migrateWorkbenchHome({
      acquireLock,
      sourceHome: join(executorHome, 'capabilities'),
      targetHome: paths.capabilities,
      stateDirectory: join(paths.migrations, 'capabilities-v1'),
      initialize: true,
    })
  }
  const customClaudeHome =
    environment.WEGENT_CLAUDE_HOME?.trim() || environment.CLAUDE_CONFIG_DIR?.trim()
  let claudeHome = customClaudeHome || paths.claudeHome
  if (!customClaudeHome) {
    // The user's ~/.claude is not owned by Wework and must never be relocated.
    await migrateWorkbenchHome({
      acquireLock,
      sourceHome: join(executorHome, 'claude'),
      targetHome: paths.claudeHome,
      stateDirectory: join(paths.migrations, 'claude-home-v1'),
      initialize: true,
      preserveExistingSource: true,
    })
    await migrateWorkbenchHome({
      acquireLock,
      sourceHome: join(executorHome, 'claude'),
      targetHome: paths.claudeHome,
      stateDirectory: join(paths.migrations, 'claude-home-v1'),
    })
    // Claude hashes the lexical CLAUDE_CONFIG_DIR for Keychain service identity.
    // Keep its lexical spelling while physically relocating the backing data.
    const legacyClaudeHome = join(executorHome, 'claude')
    const journal = JSON.parse(
      await readFile(
        join(paths.migrations, 'claude-home-v1', 'workbench-home-migration.json'),
        'utf8'
      )
    )
    if (journal.strategy === 'relocate-source') claudeHome = legacyClaudeHome
  }
  const lock = await acquireLock([executorHome, paths.desktop])
  try {
    lock.assertHeld()
    await migrateWorkbenchDataInWorker({
      source: executorHome,
      target: paths.desktop,
      state: paths.migrations,
    })
    lock.assertHeld()
  } finally {
    await lock.release()
  }
  return {
    ...branded,
    WEGENT_EXECUTOR_HOME: paths.desktop,
    WEGENT_WORKBENCH_HOME: paths.root,
    WEGENT_CODEX_HOME: environment.WEGENT_CODEX_HOME?.trim() || paths.codexHome,
    WEGENT_CAPABILITIES_HOME: environment.WEGENT_CAPABILITIES_HOME?.trim() || paths.capabilities,
    WEGENT_CLAUDE_HOME: claudeHome,
  }
}
