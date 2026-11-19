import { isAbsolute, join, resolve } from 'node:path'

import {
  applyBrandRuntimeEnvironment,
  type BrandRuntimeMetadata,
} from './brand-runtime-environment.js'

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
  }
}

export function resolveWorkbenchUserData(options: WorkbenchEnvironmentOptions): string {
  return resolve(
    options.environment.WEWORK_USER_DATA_DIR?.trim() ||
      join(resolveWorkbenchPaths(options).desktop, 'user-data')
  )
}

export function resolveWorkbenchCodexHome(options: WorkbenchEnvironmentOptions): string {
  const { environment } = options
  const executorHome = environment.WEGENT_EXECUTOR_HOME?.trim()
  return (
    environment.WEGENT_CODEX_HOME?.trim() ||
    (executorHome ? join(executorHome, 'codex') : resolveWorkbenchPaths(options).codexHome)
  )
}

export function prepareWorkbenchEnvironment(
  options: WorkbenchEnvironmentOptions
): NodeJS.ProcessEnv {
  const { environment, metadata } = options
  const branded = applyBrandRuntimeEnvironment(environment, metadata)
  if (environment.WEGENT_EXECUTOR_HOME?.trim()) return branded

  const paths = resolveWorkbenchPaths(options)
  if (
    ![
      'WORKSPACE_ROOT',
      'WEGENT_WORKSPACE_ROOT',
      'LOCAL_WORKSPACE_ROOT',
      'WEGENT_EXECUTOR_PROJECTS_DIR',
    ].some(key => environment[key]?.trim())
  ) {
    branded.WORKSPACE_ROOT = join(resolveWorkbenchUserHome(options), '.wegent', 'workspace')
  }
  return {
    ...branded,
    WEGENT_EXECUTOR_HOME: paths.desktop,
    WEGENT_WORKBENCH_HOME: paths.root,
    WEGENT_CODEX_HOME: resolveWorkbenchCodexHome(options),
    WEGENT_CAPABILITIES_HOME: environment.WEGENT_CAPABILITIES_HOME?.trim() || paths.capabilities,
    WEGENT_CLAUDE_HOME:
      environment.WEGENT_CLAUDE_HOME?.trim() ||
      environment.CLAUDE_CONFIG_DIR?.trim() ||
      paths.claudeHome,
  }
}
