import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { prepareWorkbenchEnvironment, resolveWorkbenchPaths } from './workbench-environment.js'
import { assertExecutorWorkbenchCompatibility } from './workbench-executor-schema.js'
import { assertCodexHomeCanMove } from './workbench-codex-migration.js'

vi.mock('./workbench-codex-migration.js', () => ({ assertCodexHomeCanMove: vi.fn() }))

// Keep environment/path cases focused; the worker has separate real-thread coverage.
vi.mock('./workbench-data-worker.js', async () => {
  const { migrateWorkbenchExecutorData } = await import('./workbench-executor-data.js')
  return {
    migrateWorkbenchDataInWorker: async (paths: {
      source: string
      target: string
      state: string
    }) => migrateWorkbenchExecutorData(paths.source, paths.target, paths.state),
  }
})

vi.mock('./workbench-executor-schema.js', () => ({
  assertExecutorWorkbenchCompatibility: vi.fn(),
}))

vi.mock('./workbench-migration-lock.js', () => ({
  executorMigrationLock: () => async () => ({ assertHeld() {}, async release() {} }),
}))

beforeEach(() => {
  vi.mocked(assertExecutorWorkbenchCompatibility).mockReset().mockResolvedValue(undefined)
  vi.mocked(assertCodexHomeCanMove).mockReset().mockResolvedValue(undefined)
})

const temporaryDirectories: string[] = []
const metadata = { weworkExecutorNamespace: 'com.example.wework' }

async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'workbench-environment-'))
  temporaryDirectories.push(homeDirectory)
  const executorHome = join(homeDirectory, '.wework', 'apps', metadata.weworkExecutorNamespace)
  const root = join(homeDirectory, '.wegent', 'workbench')
  return { homeDirectory, executorHome, root }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

test('resolves a branded layout without sharing application Homes', async () => {
  const { homeDirectory, root } = await fixture()
  const desktop = join(root, 'wework', metadata.weworkExecutorNamespace)
  const paths = resolveWorkbenchPaths({ environment: {}, metadata, homeDirectory })
  expect(paths).toEqual({
    root,
    shared: join(root, 'shared'),
    agents: join(root, 'agents'),
    desktop,
    codexHome: join(desktop, 'codex'),
    claudeHome: join(desktop, 'claude'),
    capabilities: join(desktop, 'capabilities'),
    migrations: join(desktop, 'migrations'),
  })
  expect(
    resolveWorkbenchPaths({
      environment: {},
      metadata: { weworkExecutorNamespace: 'com.example.other' },
      homeDirectory,
    }).codexHome
  ).not.toBe(paths.codexHome)
})

test('requires an absolute override and a single safe application namespace', () => {
  expect(() =>
    resolveWorkbenchPaths({
      environment: { WEGENT_WORKBENCH_HOME: 'relative' },
      metadata,
      homeDirectory: '/users/test',
    })
  ).toThrow('absolute path')
  expect(() =>
    resolveWorkbenchPaths({
      environment: {},
      metadata: { weworkExecutorNamespace: '../other' },
      homeDirectory: '/users/test',
    })
  ).toThrow('namespace')
})

test('activates the default layout on first installation without moving workspace roots', async () => {
  const { homeDirectory, executorHome, root } = await fixture()
  const options = { environment: {}, metadata, homeDirectory }
  const paths = resolveWorkbenchPaths(options)
  const result = await prepareWorkbenchEnvironment(options)
  expect(result).toEqual({
    WEGENT_EXECUTOR_HOME: paths.desktop,
    WORKSPACE_ROOT: join(homeDirectory, '.wegent', 'workspace'),
    WEGENT_WORKBENCH_HOME: root,
    WEGENT_CODEX_HOME: paths.codexHome,
    WEGENT_CLAUDE_HOME: paths.claudeHome,
    WEGENT_CAPABILITIES_HOME: paths.capabilities,
  })
  expect((await lstat(paths.codexHome)).isDirectory()).toBe(true)
  expect((await lstat(join(executorHome, 'codex'))).isSymbolicLink()).toBe(true)
  expect(await prepareWorkbenchEnvironment(options)).toEqual(result)
})

test('new workspace default preserves historical files and explicit roots', async () => {
  const { homeDirectory, executorHome } = await fixture()
  const oldWorkspace = join(executorHome, 'workspace')
  await mkdir(join(oldWorkspace, 'projects'), { recursive: true })
  const file = join(oldWorkspace, 'projects', 'keep.txt')
  await writeFile(file, 'old checkout')
  const before = await lstat(file)
  const environment = { WEGENT_CODEX_HOME: join(homeDirectory, 'synthetic-codex') }
  const result = await prepareWorkbenchEnvironment({ environment, metadata, homeDirectory })
  expect(result.WORKSPACE_ROOT).toBe(join(homeDirectory, '.wegent', 'workspace'))
  expect(await readFile(file, 'utf8')).toBe('old checkout')
  expect((await lstat(file)).ino).toBe(before.ino)
  for (const key of [
    'WORKSPACE_ROOT',
    'WEGENT_WORKSPACE_ROOT',
    'LOCAL_WORKSPACE_ROOT',
    'WEGENT_EXECUTOR_PROJECTS_DIR',
  ]) {
    const override = { ...environment, [key]: join(homeDirectory, 'custom') }
    const configured = await prepareWorkbenchEnvironment({
      environment: override,
      metadata,
      homeDirectory,
    })
    expect(configured[key]).toBe(override[key])
    if (key !== 'WORKSPACE_ROOT') expect(configured.WORKSPACE_ROOT).toBeUndefined()
  }
})

test('default upgrade physically relocates Codex and retains the old entry', async () => {
  const { homeDirectory, executorHome } = await fixture()
  const oldHome = join(executorHome, 'codex')
  await mkdir(oldHome, { recursive: true })
  const before = await lstat(oldHome)
  const result = await prepareWorkbenchEnvironment({ environment: {}, metadata, homeDirectory })
  expect((await lstat(oldHome)).isSymbolicLink()).toBe(true)
  expect((await lstat(result.WEGENT_CODEX_HOME!)).ino).toBe(before.ino)
  expect((await lstat(result.WEGENT_CODEX_HOME!)).isDirectory()).toBe(true)
  expect(await realpath(oldHome)).toBe(await realpath(result.WEGENT_CODEX_HOME!))
  expect(assertCodexHomeCanMove).toHaveBeenCalledOnce()
})

test.each(['HOME', 'USERPROFILE'])(
  'uses explicit %s instead of Electron system Home for default upgrade detection',
  async homeKey => {
    const { homeDirectory, executorHome, root } = await fixture()
    const systemHome = join(homeDirectory, 'unrelated-system-home')
    const sourceHome = join(executorHome, 'codex')
    await mkdir(sourceHome, { recursive: true })
    const source = await lstat(sourceHome)
    const options = {
      environment: { [homeKey]: homeDirectory, WEGENT_EXECUTOR_HOME: executorHome },
      metadata,
      homeDirectory: systemHome,
    }
    const targetHome = join(root, 'wework', metadata.weworkExecutorNamespace, 'codex')
    expect(resolveWorkbenchPaths(options).codexHome).toBe(targetHome)
    const result = await prepareWorkbenchEnvironment(options)
    expect(result.WEGENT_CODEX_HOME).toBe(targetHome)
    expect(result.WEGENT_WORKBENCH_HOME).toBe(root)
    expect((await lstat(targetHome)).isDirectory()).toBe(true)
    expect(await realpath(targetHome)).toBe(await realpath(sourceHome))
    expect((await lstat(targetHome)).ino).toBe(source.ino)
    await expect(lstat(systemHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await prepareWorkbenchEnvironment(options)).toEqual(result)
  }
)

test('explicit environment Home does not migrate a custom executor', async () => {
  const { homeDirectory, root } = await fixture()
  const environment = {
    HOME: homeDirectory,
    WEGENT_EXECUTOR_HOME: join(homeDirectory, 'custom-executor'),
  }
  const result = await prepareWorkbenchEnvironment({
    environment,
    metadata,
    homeDirectory: join(homeDirectory, 'unrelated-system-home'),
  })
  expect(result).toEqual(environment)
  expect(assertExecutorWorkbenchCompatibility).not.toHaveBeenCalled()
  await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each([false, true])(
  'preserves explicit Home and executor overrides (custom root: %s)',
  async customRoot => {
    const { homeDirectory, root } = await fixture()
    for (const override of [
      { WEGENT_CODEX_HOME: join(homeDirectory, 'custom-codex') },
      { WEGENT_EXECUTOR_HOME: join(homeDirectory, 'isolated-executor') },
    ]) {
      const environment = { ...(customRoot ? { WEGENT_WORKBENCH_HOME: root } : {}), ...override }
      const result = await prepareWorkbenchEnvironment({ environment, metadata, homeDirectory })
      expect(result).toMatchObject(environment)
      if (!override.WEGENT_CODEX_HOME) expect(result.WEGENT_CODEX_HOME).toBeUndefined()
    }
  }
)

test('migrates managed Homes and capabilities while leaving workspace and native Claude alone', async () => {
  const { homeDirectory, executorHome, root } = await fixture()
  const oldHome = join(executorHome, 'codex')
  const attachment = join(executorHome, 'workspace', 'attachments', 'example.txt')
  await mkdir(oldHome, { recursive: true })
  await mkdir(join(executorHome, 'workspace', 'attachments'), { recursive: true })
  await writeFile(join(oldHome, 'config.toml'), 'model = "test-model"\n')
  await writeFile(attachment, 'unchanged attachment')
  await mkdir(join(executorHome, 'capabilities', 'store', 'skill'), { recursive: true })
  await writeFile(join(executorHome, 'capabilities', 'store', 'skill', 'SKILL.md'), 'skill')
  await symlink('../capabilities/store/skill', join(oldHome, 'external-skill'), 'dir')
  await mkdir(join(homeDirectory, '.claude'), { recursive: true })
  await writeFile(join(homeDirectory, '.claude', 'settings.json'), '{"untouched":true}')
  const options = { environment: { WEGENT_WORKBENCH_HOME: root }, metadata, homeDirectory }
  const result = await prepareWorkbenchEnvironment(options)
  expect(result.WEGENT_EXECUTOR_HOME).toBe(resolveWorkbenchPaths(options).desktop)
  expect(result.WEGENT_CODEX_HOME).toBe(resolveWorkbenchPaths(options).codexHome)
  expect(await realpath(oldHome)).toBe(await realpath(result.WEGENT_CODEX_HOME!))
  expect(await readFile(join(result.WEGENT_CODEX_HOME!, 'config.toml'), 'utf8')).toContain(
    'test-model'
  )
  expect(await readFile(attachment, 'utf8')).toBe('unchanged attachment')
  expect(result.WEGENT_CAPABILITIES_HOME).toBe(resolveWorkbenchPaths(options).capabilities)
  expect(result.WEGENT_CLAUDE_HOME).toBe(resolveWorkbenchPaths(options).claudeHome)
  expect(
    await readFile(join(result.WEGENT_CODEX_HOME!, 'external-skill', 'SKILL.md'), 'utf8')
  ).toBe('skill')
  expect(await readFile(join(homeDirectory, '.claude', 'settings.json'), 'utf8')).toBe(
    '{"untouched":true}'
  )
  expect(await realpath(join(executorHome, 'claude'))).toBe(
    await realpath(result.WEGENT_CLAUDE_HOME!)
  )
  expect(await prepareWorkbenchEnvironment(options)).toEqual(result)
})

test('new installations keep bridges so older applications see newly created data', async () => {
  const { homeDirectory, executorHome, root } = await fixture()
  const options = { environment: { WEGENT_WORKBENCH_HOME: root }, metadata, homeDirectory }
  const result = await prepareWorkbenchEnvironment(options)
  await writeFile(join(result.WEGENT_CODEX_HOME!, 'new-session'), 'conversation')
  expect(await readFile(join(executorHome, 'codex', 'new-session'), 'utf8')).toBe('conversation')
  expect(await prepareWorkbenchEnvironment(options)).toEqual(result)
})

test('preserves explicit Claude and capability overrides independently', async () => {
  const { homeDirectory, root } = await fixture()
  const environment = {
    WEGENT_WORKBENCH_HOME: root,
    CLAUDE_CONFIG_DIR: join(homeDirectory, 'custom-claude'),
    WEGENT_CAPABILITIES_HOME: join(homeDirectory, 'custom-capabilities'),
  }
  const result = await prepareWorkbenchEnvironment({ environment, metadata, homeDirectory })
  expect(result.WEGENT_CLAUDE_HOME).toBe(environment.CLAUDE_CONFIG_DIR)
  expect(result.WEGENT_CAPABILITIES_HOME).toBe(environment.WEGENT_CAPABILITIES_HOME)
})

test('relocates Claude backing data while preserving its lexical credential identity', async () => {
  const { homeDirectory, executorHome, root } = await fixture()
  const claudeHome = join(executorHome, 'claude')
  await mkdir(claudeHome, { recursive: true })
  await writeFile(join(claudeHome, 'settings.json'), '{}')
  const options = { environment: { WEGENT_WORKBENCH_HOME: root }, metadata, homeDirectory }
  const result = await prepareWorkbenchEnvironment(options)
  expect(result.WEGENT_CLAUDE_HOME).toBe(claudeHome)
  expect((await lstat(claudeHome)).isSymbolicLink()).toBe(true)
  expect((await lstat(resolveWorkbenchPaths(options).claudeHome)).isDirectory()).toBe(true)
  expect(await realpath(resolveWorkbenchPaths(options).claudeHome)).toBe(await realpath(claudeHome))
  expect(await prepareWorkbenchEnvironment(options)).toEqual(result)
})

test('a migration conflict aborts before returning an environment for startup', async () => {
  const { homeDirectory, executorHome, root } = await fixture()
  const options = { environment: { WEGENT_WORKBENCH_HOME: root }, metadata, homeDirectory }
  const oldHome = join(executorHome, 'codex')
  const target = resolveWorkbenchPaths(options).codexHome
  await mkdir(oldHome, { recursive: true })
  await mkdir(target, { recursive: true })
  await writeFile(join(oldHome, 'keep.txt'), 'old')
  await writeFile(join(target, 'keep.txt'), 'new')
  await expect(prepareWorkbenchEnvironment(options)).rejects.toThrow()
  expect(await readFile(join(oldHome, 'keep.txt'), 'utf8')).toBe('old')
  expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('new')
})

test('schema rejection happens before any Home or journal is initialized', async () => {
  const { homeDirectory, executorHome, root } = await fixture()
  const oldHome = join(executorHome, 'codex')
  await mkdir(oldHome, { recursive: true })
  await writeFile(join(oldHome, 'session-marker'), 'keep')
  const before = await lstat(oldHome)
  vi.mocked(assertExecutorWorkbenchCompatibility).mockRejectedValue(
    new Error('incompatible schema')
  )
  await expect(
    prepareWorkbenchEnvironment({ environment: {}, metadata, homeDirectory })
  ).rejects.toThrow('incompatible schema')
  expect((await lstat(oldHome)).ino).toBe(before.ino)
  expect(await readFile(join(oldHome, 'session-marker'), 'utf8')).toBe('keep')
  await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(join(executorHome, 'capabilities'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('credential preflight rejection keeps Codex and its authentication link in place', async () => {
  const { homeDirectory, executorHome } = await fixture()
  const oldHome = join(executorHome, 'codex')
  const auth = join(homeDirectory, '.codex', 'auth.json')
  await mkdir(join(homeDirectory, '.codex'), { recursive: true })
  await writeFile(auth, 'synthetic-auth')
  await mkdir(oldHome, { recursive: true })
  await symlink(auth, join(oldHome, 'auth.json'))
  vi.mocked(assertCodexHomeCanMove).mockRejectedValue(new Error('credential store blocked'))
  const options = { environment: {}, metadata, homeDirectory }
  await expect(prepareWorkbenchEnvironment(options)).rejects.toThrow('credential store blocked')
  expect((await lstat(oldHome)).isDirectory()).toBe(true)
  expect(await realpath(join(oldHome, 'auth.json'))).toBe(await realpath(auth))
  await expect(lstat(resolveWorkbenchPaths(options).codexHome)).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test('relocates an auth symlink without copying or changing native authentication', async () => {
  const { homeDirectory, executorHome } = await fixture()
  const oldHome = join(executorHome, 'codex')
  const auth = join(homeDirectory, '.codex', 'auth.json')
  await mkdir(join(homeDirectory, '.codex'), { recursive: true })
  await writeFile(auth, 'synthetic-auth', { mode: 0o600 })
  await mkdir(oldHome, { recursive: true })
  await symlink('../../../../.codex/auth.json', join(oldHome, 'auth.json'))
  const before = await lstat(auth)
  const options = { environment: {}, metadata, homeDirectory }
  const result = await prepareWorkbenchEnvironment(options)
  const newAuth = join(result.WEGENT_CODEX_HOME!, 'auth.json')
  expect((await lstat(newAuth)).isSymbolicLink()).toBe(true)
  expect(await realpath(newAuth)).toBe(await realpath(auth))
  expect((await lstat(auth)).ino).toBe(before.ino)
  expect((await lstat(auth)).mode).toBe(before.mode)
  expect(await readFile(newAuth, 'utf8')).toBe('synthetic-auth')
  await prepareWorkbenchEnvironment(options)
  expect(assertCodexHomeCanMove).toHaveBeenCalledOnce()
})
