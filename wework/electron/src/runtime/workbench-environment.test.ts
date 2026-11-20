import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  prepareWorkbenchEnvironment,
  resolveWorkbenchCodexHome,
  resolveWorkbenchPaths,
  resolveWorkbenchUserData,
} from './workbench-environment.js'

const metadata = { weworkExecutorNamespace: 'com.example.wework' }
const temporaryDirectories: string[] = []

async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'workbench-environment-'))
  temporaryDirectories.push(homeDirectory)
  return {
    homeDirectory,
    executorHome: join(homeDirectory, '.wework', 'apps', metadata.weworkExecutorNamespace),
    root: join(homeDirectory, '.wegent', 'workbench'),
  }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

test('selects the current layout even when the old Home is a broken link', async () => {
  const { homeDirectory, executorHome, root } = await fixture()
  const broken = join(homeDirectory, 'disconnected-volume')
  await mkdir(join(executorHome, '..'), { recursive: true })
  await symlink(broken, executorHome, 'junction')
  const options = { environment: {}, metadata, homeDirectory }
  const desktop = join(root, 'wework', metadata.weworkExecutorNamespace)
  const result = prepareWorkbenchEnvironment(options)
  expect(result).toEqual({
    WEGENT_EXECUTOR_HOME: desktop,
    WEGENT_WORKBENCH_HOME: root,
    WORKSPACE_ROOT: join(homeDirectory, '.wegent', 'workspace'),
    WEGENT_CODEX_HOME: join(desktop, 'codex'),
    WEGENT_CLAUDE_HOME: join(desktop, 'claude'),
    WEGENT_CAPABILITIES_HOME: join(desktop, 'capabilities'),
  })
  expect(resolveWorkbenchCodexHome(options)).toBe(result.WEGENT_CODEX_HOME)
  expect(resolveWorkbenchUserData(options)).toBe(join(desktop, 'user-data'))
  expect(await readlink(executorHome)).toBe(broken)
  await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each(['HOME', 'USERPROFILE'])('honors %s and explicit data paths', async homeKey => {
  const { homeDirectory, executorHome, root } = await fixture()
  const options = {
    environment: {
      [homeKey]: homeDirectory,
      WEWORK_USER_DATA_DIR: join(homeDirectory, 'isolated-user-data'),
      WEGENT_EXECUTOR_HOME: executorHome,
    },
    metadata,
    homeDirectory: join(homeDirectory, 'system-home'),
  }
  expect(resolveWorkbenchPaths(options).root).toBe(root)
  expect(resolveWorkbenchUserData(options)).toBe(options.environment.WEWORK_USER_DATA_DIR)
  expect(resolveWorkbenchCodexHome(options)).toBe(join(executorHome, 'codex'))
  expect(prepareWorkbenchEnvironment(options)).toEqual(options.environment)
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

test('new workspace default preserves historical files and explicit roots', async () => {
  const { homeDirectory, executorHome } = await fixture()
  const oldWorkspace = join(executorHome, 'workspace')
  await mkdir(join(oldWorkspace, 'projects'), { recursive: true })
  const file = join(oldWorkspace, 'projects', 'keep.txt')
  await writeFile(file, 'old checkout')
  const before = await lstat(file)
  const environment = { WEGENT_CODEX_HOME: join(homeDirectory, 'synthetic-codex') }
  const result = prepareWorkbenchEnvironment({ environment, metadata, homeDirectory })
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
    const configured = prepareWorkbenchEnvironment({
      environment: override,
      metadata,
      homeDirectory,
    })
    expect(configured[key]).toBe(override[key])
    if (key !== 'WORKSPACE_ROOT') expect(configured.WORKSPACE_ROOT).toBeUndefined()
  }
})

test('explicit environment Home does not migrate a custom executor', async () => {
  const { homeDirectory, root } = await fixture()
  const environment = {
    HOME: homeDirectory,
    WEGENT_EXECUTOR_HOME: join(homeDirectory, 'custom-executor'),
  }
  const result = prepareWorkbenchEnvironment({
    environment,
    metadata,
    homeDirectory: join(homeDirectory, 'unrelated-system-home'),
  })
  expect(result).toEqual(environment)
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
      const result = prepareWorkbenchEnvironment({ environment, metadata, homeDirectory })
      expect(result).toMatchObject(environment)
      if (!override.WEGENT_CODEX_HOME) expect(result.WEGENT_CODEX_HOME).toBeUndefined()
    }
  }
)
