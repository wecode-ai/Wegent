import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { isolateDevelopmentEnvironment } from './development-isolation.js'
import { prepareManagedExecutorEnvironment } from './managed-executor-runtime.js'
import { prepareWorkbenchEnvironment } from './workbench-environment.js'
import { isEffectivePackagedApplication } from '../host/application-packaging-mode.js'

describe('development data isolation', () => {
  let fixture: string
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'wework-development-isolation-'))
  })
  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  function options(worktree = 'first') {
    return {
      packaged: false,
      packageRoot: join(fixture, worktree, 'wework', 'electron'),
      appData: join(fixture, 'app-data'),
      homeDirectory: join(fixture, 'home'),
    }
  }

  test('overrides inherited release paths and clears parent execution identity', () => {
    const release = join(fixture, 'release')
    const environment: NodeJS.ProcessEnv = {
      WEGENT_EXECUTOR_HOME: release,
      WEGENT_WORKBENCH_HOME: release,
      WEGENT_CODEX_HOME: release,
      CODEX_HOME: release,
      CODEX_SQLITE_HOME: release,
      WEGENT_CLAUDE_HOME: release,
      CLAUDE_CONFIG_DIR: release,
      WEGENT_CAPABILITIES_HOME: release,
      LOCAL_WORKSPACE_ROOT: release,
      WORKSPACE_ROOT: release,
      WEGENT_EXECUTOR_PROJECTS_DIR: release,
      WEGENT_EXECUTOR_LOG_DIR: release,
      WEWORK_APP_CONFIG_DIR: release,
      WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: release,
      WEWORK_EXECUTOR_ENDPOINT: 'parent-endpoint',
      WEWORK_EXECUTOR_TOKEN: 'synthetic',
      WEGENT_APP_IPC_TOKEN: 'synthetic',
      WEGENT_EXECUTOR_APP_IPC_SOCKET: 'parent-socket',
      WEGENT_EXECUTOR_LOG_FILE: join(release, 'executor.log'),
      WEGENT_AUTH_TOKEN: 'synthetic',
      WEGENT_TASK_ID: 'parent-task',
      DEVICE_ID: 'release-device',
      WEWORK_APP_IDENTIFIER: 'com.example.release',
    }
    isolateDevelopmentEnvironment(environment, options())
    expect(Object.values(environment)).not.toContain(release)
    expect(environment.WEGENT_WORKBENCH_HOME).toBe(
      join(fixture, 'home', '.wegent', 'development', 'workbench')
    )
    expect(environment.CODEX_HOME).toBe(environment.WEGENT_CODEX_HOME)
    expect(environment.DEVICE_ID).toMatch(/^wework-dev-/)
    expect(environment.WEWORK_APP_IDENTIFIER).toMatch(/^io\.wecode\.wework\.dev\./)
    for (const key of [
      'WEGENT_APP_IPC_TOKEN',
      'WEWORK_EXECUTOR_ENDPOINT',
      'WEWORK_EXECUTOR_TOKEN',
      'WEGENT_EXECUTOR_APP_IPC_SOCKET',
      'WEGENT_EXECUTOR_LOG_FILE',
      'WEGENT_AUTH_TOKEN',
      'WEGENT_TASK_ID',
    ]) {
      expect(environment[key]).toBeUndefined()
    }
  })

  test('shares development history while separating worktree window state', () => {
    const first: NodeJS.ProcessEnv = {}
    const repeated: NodeJS.ProcessEnv = {}
    const second: NodeJS.ProcessEnv = {}
    isolateDevelopmentEnvironment(first, options())
    isolateDevelopmentEnvironment(repeated, options())
    isolateDevelopmentEnvironment(second, options('second'))
    expect(repeated).toEqual(first)
    expect(second).not.toEqual(first)
    expect(second.WEGENT_EXECUTOR_HOME).toBe(first.WEGENT_EXECUTOR_HOME)
    expect(second.CODEX_HOME).toBe(first.CODEX_HOME)
    expect(second.WEWORK_USER_DATA_DIR).not.toBe(first.WEWORK_USER_DATA_DIR)
    expect(second.WEGENT_EXECUTOR_LOG_DIR).not.toBe(first.WEGENT_EXECUTOR_LOG_DIR)
  })

  test('shares native Codex authentication without migrating release data, including after restart', async () => {
    const home = join(fixture, 'home')
    const auth = join(home, '.codex', 'auth.json')
    await mkdir(dirname(auth), { recursive: true })
    await writeFile(auth, 'synthetic-auth')
    const environment: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: dirname(auth) }
    isolateDevelopmentEnvironment(environment, options())
    const prepared = await prepareWorkbenchEnvironment({
      environment,
      homeDirectory: home,
      metadata: { weworkExecutorNamespace: 'release' },
    })
    expect(prepared.WEGENT_CODEX_HOME).toBe(environment.WEGENT_CODEX_HOME)
    const managed = prepareManagedExecutorEnvironment({
      environment: prepared,
      dataDirectory: environment.WEWORK_USER_DATA_DIR!,
    })
    const target = join(managed.CODEX_HOME!, 'auth.json')
    expect(await readFile(target, 'utf8')).toBe('synthetic-auth')
    if (process.platform !== 'win32') {
      expect((await lstat(target)).isSymbolicLink()).toBe(true)
      expect(await readlink(target)).toBe(auth)
    }
    isolateDevelopmentEnvironment(environment, options())
    prepareManagedExecutorEnvironment({
      environment,
      dataDirectory: environment.WEWORK_USER_DATA_DIR!,
    })
    expect(await readFile(target, 'utf8')).toBe('synthetic-auth')
    expect(await readFile(auth, 'utf8')).toBe('synthetic-auth')
    await expect(readFile(join(home, '.wework', 'codex', 'auth.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('preserves existing development auth rather than replacing it with native credentials', async () => {
    const home = options().homeDirectory
    const environment: NodeJS.ProcessEnv = { HOME: home }
    isolateDevelopmentEnvironment(environment, options())
    const target = join(environment.CODEX_HOME!, 'auth.json')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, 'synthetic-development-auth')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex/auth.json'), 'synthetic-native-auth')
    prepareManagedExecutorEnvironment({
      environment,
      dataDirectory: environment.WEWORK_USER_DATA_DIR!,
    })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('synthetic-development-auth')
    expect(await readFile(join(home, '.codex/auth.json'), 'utf8')).toBe('synthetic-native-auth')
  })

  test('missing native auth does not prevent startup or create a dangling link', async () => {
    const environment: NodeJS.ProcessEnv = { HOME: options().homeDirectory }
    isolateDevelopmentEnvironment(environment, options())
    prepareManagedExecutorEnvironment({
      environment,
      dataDirectory: environment.WEWORK_USER_DATA_DIR!,
    })
    await expect(lstat(join(environment.CODEX_HOME!, 'auth.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('retains the expected native-auth link if native login is temporarily absent', async () => {
    const environment: NodeJS.ProcessEnv = { HOME: options().homeDirectory }
    isolateDevelopmentEnvironment(environment, options())
    const target = join(environment.CODEX_HOME!, 'auth.json')
    const native = join(options().homeDirectory, '.codex/auth.json')
    await mkdir(dirname(target), { recursive: true })
    await symlink(native, target)
    isolateDevelopmentEnvironment(environment, options())
    prepareManagedExecutorEnvironment({
      environment,
      dataDirectory: environment.WEWORK_USER_DATA_DIR!,
    })
    expect(await readlink(target)).toBe(native)
  })

  test('rejects a custom data directory outside the development namespace', () => {
    expect(() =>
      isolateDevelopmentEnvironment({ WEWORK_USER_DATA_DIR: join(fixture, 'release') }, options())
    ).toThrow('Development data must remain inside')
  })

  test.each(['runtime-data', 'auth.json', 'base', 'dangling'])(
    'rejects %s links to release data',
    async kind => {
      const environment: NodeJS.ProcessEnv = {}
      isolateDevelopmentEnvironment(environment, options())
      const release = join(fixture, 'release')
      await mkdir(release, { recursive: true })
      const link =
        kind === 'base'
          ? join(options().appData, 'io.wecode.wework.dev')
          : kind === 'auth.json'
            ? join(environment.CODEX_HOME!, 'auth.json')
            : join(environment.WEWORK_USER_DATA_DIR!, 'runtime-data')
      await mkdir(dirname(link), { recursive: true })
      await symlink(kind === 'dangling' ? join(release, 'missing') : release, link, 'junction')
      expect(() => isolateDevelopmentEnvironment(environment, options())).toThrow()
    }
  )

  test('does not alter packaged app paths', () => {
    const environment = { WEGENT_EXECUTOR_HOME: join(fixture, 'release') }
    const original = { ...environment }
    isolateDevelopmentEnvironment(environment, { ...options(), packaged: true })
    expect(environment).toEqual(original)
  })

  test('isolates renamed macOS development bundles before migration checks', async () => {
    const home = join(fixture, 'home')
    const legacyHome = join(home, '.wework', 'apps', 'release')
    const auth = join(legacyHome, 'codex', 'auth.json')
    await mkdir(dirname(auth), { recursive: true })
    await writeFile(auth, 'synthetic-release-auth')
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      WEWORK_APP_HOT_RELOAD: '1',
      WEGENT_EXECUTOR_HOME: legacyHome,
      WEWORK_EXECUTOR_PATH: join(fixture, 'missing-dev-wrapper'),
    }
    isolateDevelopmentEnvironment(environment, {
      ...options(),
      packaged: isEffectivePackagedApplication(true, environment),
    })
    const prepared = await prepareWorkbenchEnvironment({
      environment,
      homeDirectory: home,
      metadata: { weworkExecutorNamespace: 'release' },
    })
    expect(prepared.WEWORK_DEVELOPMENT_ISOLATED).toBe('1')
    expect(prepared.WEGENT_EXECUTOR_HOME).not.toBe(legacyHome)
    expect(prepared.WEGENT_WORKBENCH_HOME).toBe(
      join(fixture, 'home', '.wegent', 'development', 'workbench')
    )
    expect(await readFile(auth, 'utf8')).toBe('synthetic-release-auth')
  })

  test('preserves explicitly controlled verification fixtures', () => {
    const environment = {
      VITE_WEWORK_E2E: 'true',
      WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:12345',
      WEGENT_EXECUTOR_HOME: join(fixture, 'verification'),
    }
    const original = { ...environment }
    isolateDevelopmentEnvironment(environment, options())
    expect(environment).toEqual(original)
  })

  test('enforces isolation before main resolves app identity or user data', async () => {
    const source = await readFile(new URL('../main.ts', import.meta.url), 'utf8')
    const guard = source.indexOf('isolateDevelopmentEnvironment(process.env,')
    expect(guard).toBeGreaterThan(-1)
    expect(source.indexOf('const packagedApplication =')).toBeLessThan(guard)
    expect(source.slice(guard, source.indexOf('})', guard))).toContain(
      'packaged: packagedApplication'
    )
    expect(guard).toBeLessThan(source.indexOf('const applicationId ='))
    expect(guard).toBeLessThan(source.indexOf("app.setPath('userData'"))
  })
})
