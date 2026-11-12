import { isAbsolute } from 'node:path'
import type { WorkbenchShortcutLaunch } from './workbench-shortcuts.js'

const PROFILE_ENVIRONMENT_KEYS = [
  'WEWORK_APP_IDENTIFIER',
  'WEGENT_WORKBENCH_HOME',
  'WEGENT_EXECUTOR_HOME',
  'WEGENT_CODEX_HOME',
  'WEGENT_CAPABILITIES_HOME',
  'WEGENT_CLAUDE_HOME',
  'WORKSPACE_ROOT',
  'WEGENT_WORKSPACE_ROOT',
  'LOCAL_WORKSPACE_ROOT',
  'WEGENT_EXECUTOR_PROJECTS_DIR',
  'WEWORK_BACKEND_URL',
  'WEGENT_BACKEND_URL',
  'VITE_WEGENT_BACKEND_URL',
  'WEWORK_SOCKET_URL',
  'WEGENT_SOCKET_URL',
  'VITE_WEGENT_SOCKET_URL',
  'VITE_WEWORK_RELEASE_CHANNEL',
  'VITE_WEWORK_RUNTIME_MODE',
] as const

const DEVELOPMENT_ENVIRONMENT_KEYS = [
  'WEWORK_DEV_TITLE',
  'WEWORK_DEV_WORKTREE',
  'WEWORK_DEV_BRANCH',
  'WEWORK_DEV_INSTANCE_ID',
  'WEWORK_DEV_INSTANCE_LABEL',
  'WEWORK_DEV_DOCK_TITLE',
  'WEWORK_DEV_EXECUTABLE_NAME',
  'WEWORK_INSTANCE_MODE',
  'WEWORK_DEVELOPMENT_ISOLATED',
  'WEWORK_EXECUTOR_PATH',
  'WEGENT_EXECUTOR_BINARY',
  'WEGENT_EXECUTOR_DEV_BUILD_ID',
  'WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT',
  'WEWORK_HARNESS_RUNTIME_ROOT',
  'WEWORK_HARNESS_RESOURCE_ROOT',
  'WEWORK_COMPONENT_RESOURCES_ROOT',
  'WEWORK_CORE_PLUGIN_ROOT',
  'WEWORK_CORE_PLUGINS_SHA256',
  'CODEX_BINARY_PATH',
  'DWS_BINARY_PATH',
  'VITE_WEWORK_DEV_TITLE',
  'VITE_WEWORK_DEV_WORKTREE',
  'VITE_WEWORK_DEV_BRANCH',
  'VITE_WEWORK_PARENT_TITLE',
  'VITE_WEWORK_PARENT_PROJECT',
  'VITE_WEWORK_PARENT_WORKSPACE',
] as const

/** Persist only the owning profile and, for source builds, its explicit runtime composition. */
export function workbenchShortcutLaunch(options: {
  command: string
  args: string[]
  environment: NodeJS.ProcessEnv
  userDataDirectory: string
  development: boolean
}): WorkbenchShortcutLaunch {
  if (!isAbsolute(options.command) || !isAbsolute(options.userDataDirectory))
    throw new Error('Workbench shortcut launch paths must be absolute')
  const keys = options.development
    ? [...PROFILE_ENVIRONMENT_KEYS, ...DEVELOPMENT_ENVIRONMENT_KEYS]
    : PROFILE_ENVIRONMENT_KEYS
  const environment: Record<string, string> = {}
  for (const key of keys) {
    const value = options.environment[key]
    if (typeof value === 'string' && value.length) environment[key] = value
  }
  environment.WEWORK_USER_DATA_DIR = options.userDataDirectory
  return { command: options.command, args: [...options.args], environment }
}
