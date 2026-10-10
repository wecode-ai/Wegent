import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface DevelopmentIsolationOptions {
  packaged: boolean
  packageRoot: string
  appData: string
  homeDirectory: string
}

// Clear parent execution identity as well as paths; a dev app must own its IPC.
const INHERITED_KEYS = [
  'WEGENT_AUTH_TOKEN',
  'WEGENT_RUNTIME_INSTANCE_ID',
  'WEGENT_TASK_ID',
  'WEGENT_TASK_WORKSPACE',
  'WEGENT_APP_LIFECYCLE_FD',
  'WEWORK_SHARED_EXECUTOR_HOME',
  'WEWORK_EXECUTOR_ARGS',
  'WEWORK_EXECUTOR_SIDECAR',
  'WEWORK_EXECUTOR_ENDPOINT',
  'WEWORK_EXECUTOR_TOKEN',
  'WEWORK_NODE_PATH',
  'WEWORK_NODE_RUNTIME_KIND',
  'WEWORK_RUNTIME_BIN',
  'WEGENT_EXECUTOR_LOG_FILE',
]

export function isolateDevelopmentEnvironment(
  environment: NodeJS.ProcessEnv,
  options: DevelopmentIsolationOptions
): void {
  // Dedicated verification and plugin runners already own their lifecycle/fixtures.
  if (
    options.packaged ||
    (environment.VITE_WEWORK_E2E === 'true' && environment.WEWORK_E2E_CONTROL_URL) ||
    environment.WEWORK_INSTANCE_MODE === 'core-dsh-plugin-development'
  )
    return

  const id = createHash('sha256')
    .update(resolve(options.packageRoot, '..', '..'))
    .digest('hex')
    .slice(0, 16)
  const base = join(options.appData, 'io.wecode.wework.dev')
  const legacy = join(base, id.slice(0, 12))
  const userData = resolve(
    environment.WEWORK_USER_DATA_DIR?.trim() || (existsSync(legacy) ? legacy : join(base, id))
  )
  assertContained(base, userData)
  const runtime = join(userData, 'runtime-data')
  const developmentRoot = join(options.homeDirectory, '.wegent', 'development')
  const workbench = join(developmentRoot, 'workbench')
  const desktop = join(workbench, 'wework', 'default')
  const executor = desktop
  const codex = join(desktop, 'codex')
  const claude = join(desktop, 'claude')
  const workspace = join(developmentRoot, 'workspace')
  const paths = {
    WEWORK_USER_DATA_DIR: userData,
    WEGENT_EXECUTOR_HOME: executor,
    WEGENT_WORKBENCH_HOME: workbench,
    WEGENT_CODEX_HOME: codex,
    CODEX_HOME: codex,
    CODEX_SQLITE_HOME: codex,
    WEGENT_CLAUDE_HOME: claude,
    CLAUDE_CONFIG_DIR: claude,
    WEGENT_CAPABILITIES_HOME: join(desktop, 'capabilities'),
    LOCAL_WORKSPACE_ROOT: workspace,
    WORKSPACE_ROOT: join(workspace, 'projects'),
    WEGENT_EXECUTOR_PROJECTS_DIR: join(workspace, 'projects'),
    WEGENT_EXECUTOR_LOG_DIR: join(runtime, 'logs'),
    WEWORK_APP_CONFIG_DIR: join(runtime, 'app-config'),
    WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: join(runtime, 'desktop-control'),
  }
  for (const path of Object.values(paths)) {
    if (path === userData || path.startsWith(`${userData}${sep}`)) assertContained(base, path)
    else assertContained(developmentRoot, path)
  }
  // Native Codex auth is deliberately shared; configuration and task data are not.
  const auth = join(codex, 'auth.json')
  const nativeAuth = resolve(options.homeDirectory, '.codex', 'auth.json')
  let nativeAuthLink = false
  try {
    nativeAuthLink =
      lstatSync(auth).isSymbolicLink() && resolve(codex, readlinkSync(auth)) === nativeAuth
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!nativeAuthLink) assertContained(developmentRoot, auth)
  assertContained(developmentRoot, join(codex, 'config.toml'))
  assertContained(developmentRoot, join(claude, '.credentials.json'))
  for (const key of Object.keys(environment)) {
    if (
      INHERITED_KEYS.includes(key) ||
      key.startsWith('WEGENT_APP_IPC_') ||
      key.startsWith('WEGENT_EXECUTOR_APP_IPC_')
    )
      delete environment[key]
  }
  Object.assign(environment, paths, {
    WEWORK_DEVELOPMENT_ISOLATED: '1',
    WEWORK_APP_IDENTIFIER: environment.WEWORK_APP_IDENTIFIER?.startsWith('io.wecode.wework.dev.')
      ? environment.WEWORK_APP_IDENTIFIER
      : `io.wecode.wework.dev.${id.slice(0, 12)}`,
    DEVICE_ID: `wework-dev-${id}`,
    DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
    DEVICE_SESSION_GATEWAY_PORT: '0',
  })
}

function assertContained(base: string, path: string): void {
  const suffix = relative(resolve(base), resolve(path))
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('Development data must remain inside the development app data directory')
  }
  const canonicalBase = canonicalPath(base)
  const canonicalTarget = canonicalPath(path)
  const canonicalSuffix = relative(canonicalBase, canonicalTarget)
  if (
    !canonicalSuffix ||
    canonicalSuffix === '..' ||
    canonicalSuffix.startsWith(`..${sep}`) ||
    isAbsolute(canonicalSuffix)
  ) {
    throw new Error('Development data path links outside the development app data directory')
  }
  // The base itself must not be redirected to a release data directory.
  if (canonicalBase !== join(canonicalPath(dirname(base)), relative(dirname(base), base))) {
    throw new Error('Development app data directory must not be a symbolic link')
  }
}

function canonicalPath(path: string): string {
  try {
    lstatSync(path)
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A dangling symlink must fail closed instead of being treated as a new path.
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Error('Dangling development data link', { cause: error })
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
    }
    const parent = dirname(path)
    if (parent === path) throw error
    return join(canonicalPath(parent), relative(parent, path))
  }
}
