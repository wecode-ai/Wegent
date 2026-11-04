import { isAbsolute, relative, resolve, sep } from 'node:path'

const PARENT_EXECUTION_KEYS = [
  'DEVICE_ID',
  'WEGENT_AUTH_TOKEN',
  'WEGENT_RUNTIME_AUTH_TOKEN',
  'WEGENT_RUNTIME_INSTANCE_ID',
  'WEGENT_TASK_ID',
  'WEGENT_TASK_WORKSPACE',
  'WEGENT_APP_LIFECYCLE_FD',
  'WEGENT_WORKSPACE_ROOT',
  'WEGENT_EXECUTOR_PROJECTS_DIR',
  'LOCAL_WORKSPACE_ROOT',
  'WEWORK_SHARED_EXECUTOR_HOME',
  'WEWORK_EXECUTOR_ENDPOINT',
  'WEWORK_EXECUTOR_TOKEN',
] as const

const PARENT_EXECUTION_PREFIXES = [
  'WEGENT_APP_IPC_',
  'WEGENT_EXECUTOR_APP_IPC_',
  'WEWORK_EMBEDDED_BROWSER_BRIDGE_',
] as const

const INSTALLATION_PATH_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'WEGENT_BUNDLED_HOOKS_DIR',
  'WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR',
  'WEGENT_CAPABILITIES_HOME',
  'WEGENT_CLAUDE_HOME',
  'WEGENT_CODEX_HOME',
  'WEGENT_EXECUTOR_HOME',
  'WEGENT_EXECUTOR_LOG_DIR',
  'WEGENT_EXECUTOR_LOG_FILE',
  'WEGENT_WORKBENCH_HOME',
  'WEWORK_APP_CONFIG_DIR',
  'WEWORK_CORE_PLUGIN_ROOT',
  'WEWORK_DESKTOP_CONTROL_REGISTRY_DIR',
  'WEWORK_EXECUTOR_PATH',
  'WEWORK_EXECUTOR_SIDECAR',
  'WEWORK_HARNESS_RESOURCE_ROOT',
  'WEWORK_HARNESS_RUNTIME_ROOT',
  'WEWORK_NODE_PATH',
  'WEWORK_RUNTIME_BIN',
  'WEWORK_USER_DATA_DIR',
])

export interface DesktopEnvironmentIsolationOptions {
  homeDirectory: string
  namespace: string
}

/**
 * Drops runtime state inherited from an already-running Wework process.
 *
 * A packaged app launched from another Wework window (for example a shell
 * inside the production app) must keep its own device identity, executor IPC,
 * cloud endpoints, and workbench homes instead of attaching to the parent.
 * Explicit cloud endpoints are launch configuration, not executor state, so
 * they remain available to the new application.
 */
export function isolateInheritedDesktopEnvironment(
  environment: NodeJS.ProcessEnv,
  options: DesktopEnvironmentIsolationOptions
): void {
  const installationRoot = resolve(options.homeDirectory, '.wegent', 'workbench', 'wework')
  for (const key of Object.keys(environment)) {
    if (
      PARENT_EXECUTION_KEYS.includes(key as (typeof PARENT_EXECUTION_KEYS)[number]) ||
      PARENT_EXECUTION_PREFIXES.some(prefix => key.startsWith(prefix))
    ) {
      delete environment[key]
      continue
    }
    if (!INSTALLATION_PATH_KEYS.has(key)) continue
    const value = environment[key]?.trim()
    if (value && belongsToForeignInstallation(value, installationRoot, options.namespace)) {
      delete environment[key]
    }
  }
}

function belongsToForeignInstallation(
  value: string,
  installationRoot: string,
  namespace: string
): boolean {
  if (!isAbsolute(value)) return false
  const suffix = relative(installationRoot, resolve(value))
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    return false
  }
  const [owner] = suffix.split(sep)
  return Boolean(owner) && owner !== namespace
}
