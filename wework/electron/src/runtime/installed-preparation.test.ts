import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

const preparation = vi.hoisted(() => ({
  components: {
    coreDsh: '/components/core',
    weworkCorePlugins: '/components/plugins',
    bundledPlugins: '/components/bundled',
    executor: '/components/executor',
    codex: '/components/codex',
    dws: '/components/dws',
    contentSha256: {
      coreDsh: 'a'.repeat(64),
      weworkCorePlugins: 'b'.repeat(64),
      weworkAppStatic: 'c'.repeat(64),
      bundledPlugins: 'd'.repeat(64),
      executor: 'e'.repeat(64),
      codex: 'f'.repeat(64),
      dws: '1'.repeat(64),
    },
  },
  prepareStartup: vi.fn(),
  confirmStartup: vi.fn(),
  materialize: vi.fn(),
  prepareProfile: vi.fn(),
  atomicWrite: vi.fn(),
}))

vi.mock('./component-update-manager.js', () => ({
  ComponentUpdateManager: class {
    prepareStartup = preparation.prepareStartup
    confirmStartup = preparation.confirmStartup
  },
}))
vi.mock('./bundled-runtime-materializer.js', () => ({
  materializeBundledRuntimes: preparation.materialize,
}))
vi.mock('./core-dsh-runtime.js', () => ({
  prepareCoreDshRuntime: preparation.prepareProfile,
}))
vi.mock('./release-store.js', async importOriginal => {
  const original = await importOriginal<typeof import('./release-store.js')>()
  return { ...original, atomicReleaseWrite: preparation.atomicWrite }
})
vi.mock('./workbench-executor-schema.js', () => ({
  assertExecutorWorkbenchCompatibility: vi.fn(),
}))

const { isInstalledPreparationRequest } = await import('./installed-preparation-contract.mjs')
const { prepareInstalledEnvironment } = await import('./installed-preparation.js')
const { currentCoreProfile } = await import('./release-profile.js')
const {
  installedPreparationDirectory,
  installedPreparationMarkerFile,
  installedPreparationProfileRoot,
} = await import('./installed-preparation-state.js')
const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('identifies the installer-only preparation command', () => {
  expect(isInstalledPreparationRequest(['WeWork.exe', '--wework-prepare-installation'])).toBe(true)
  expect(isInstalledPreparationRequest(['WeWork.exe'])).toBe(false)
})

test('prepares the Core profile in an isolated version directory without confirming startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-installed-preparation-'))
  roots.push(root)
  const statusFile = join(root, 'logs', 'install-preparation.json')
  const activeProfile = join(root, 'releases', 'active', 'profile')
  const pointer = currentCoreProfile(root)
  await mkdir(activeProfile, { recursive: true })
  await writeFile(join(activeProfile, 'package.json'), '{"version":"active"}\n')
  await writeFile(join(activeProfile, 'plugin.js'), 'active plugin bytes\n')
  await mkdir(join(pointer, '..'), { recursive: true })
  await symlink(activeProfile, pointer, process.platform === 'win32' ? 'junction' : 'dir')
  const preparationDirectory = installedPreparationDirectory(root, '1.2.3')
  const profileRoot = installedPreparationProfileRoot(root, '1.2.3')
  preparation.prepareStartup.mockResolvedValue(preparation.components)
  preparation.materialize.mockResolvedValue(join(root, 'managed-runtimes', 'dsh'))
  preparation.prepareProfile.mockImplementation(async options => {
    const preparedProfile = join(options.dataDirectory, 'dsh-core', 'profiles', 'wework-core')
    await writeFile(join(preparedProfile, 'package.json'), '{"version":"prepared"}\n')
    await writeFile(join(preparedProfile, 'plugin.js'), 'prepared plugin bytes\n')
    return { dshHome: join(options.dataDirectory, 'dsh-core') }
  })
  preparation.atomicWrite.mockImplementation(async (path: string, value: string) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, value)
  })
  const progress = vi.fn()

  const result = await prepareInstalledEnvironment({
    resourcesRoot: join(root, 'resources'),
    dataDirectory: root,
    version: '1.2.3',
    updateBaseUrl: 'https://updates.example/wework-updater',
    environment: {},
    statusFile,
    onProgress: progress,
  })

  expect(preparation.prepareStartup).toHaveBeenCalledOnce()
  expect(preparation.materialize).toHaveBeenCalledWith(
    preparation.components.coreDsh,
    join(root, 'managed-runtimes', 'dsh'),
    ['core'],
    expect.any(Object)
  )
  expect(preparation.prepareProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimeRoot: join(root, 'managed-runtimes', 'dsh'),
      dataDirectory: preparationDirectory,
      environment: expect.objectContaining({
        WEWORK_CORE_PLUGIN_ROOT: preparation.components.weworkCorePlugins,
        WEWORK_CORE_PLUGINS_SHA256: preparation.components.contentSha256.weworkCorePlugins,
      }),
    })
  )
  expect(preparation.confirmStartup).not.toHaveBeenCalled()
  expect(await realpath(pointer)).toBe(await realpath(activeProfile))
  expect(await readFile(join(activeProfile, 'package.json'), 'utf8')).toBe('{"version":"active"}\n')
  expect(await readFile(join(activeProfile, 'plugin.js'), 'utf8')).toBe('active plugin bytes\n')
  expect(await readFile(join(profileRoot, 'plugin.js'), 'utf8')).toBe('prepared plugin bytes\n')
  expect(progress.mock.calls.map(([event]) => `${event.stage}:${event.phase}`)).toEqual([
    'components:started',
    'components:completed',
    'runtimes:started',
    'runtimes:completed',
    'profile-prepare:started',
    'profile-prepare:completed',
  ])
  expect(JSON.parse(await readFile(statusFile, 'utf8'))).toMatchObject({
    version: '1.2.3',
    preparationDirectory,
    profileRoot,
    runtimeRoot: join(root, 'managed-runtimes', 'dsh'),
    dshHome: join(preparationDirectory, 'dsh-core'),
    components: preparation.components,
  })
  expect(
    JSON.parse(await readFile(installedPreparationMarkerFile(root, '1.2.3'), 'utf8'))
  ).toMatchObject({
    version: '1.2.3',
    preparationDirectory,
    profileRoot,
    source: { kind: 'profile', resolvedPath: await realpath(activeProfile) },
  })
  expect(result.durationMs).toBeGreaterThanOrEqual(0)
})
