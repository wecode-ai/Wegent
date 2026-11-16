import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { findCompatibleSystemPython } from './python-runtime-selection.js'
import { PythonRuntimeManager } from './python-runtime.js'

const resolveDownloads = async () => ({
  uvUrl: 'https://github.com/astral-sh/uv/releases/download/0.9.5/uv-aarch64-apple-darwin.tar.gz',
  pythonUrl:
    'https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.12.12%2B20251014-aarch64-apple-darwin-install_only_stripped.tar.gz',
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(
  python: unknown = { systemFallback: { version: '3.12', dependencies: [] } }
) {
  const root = await mkdtemp(join(tmpdir(), 'wework-python-selection-'))
  roots.push(root)
  const plugin = join(root, 'plugin')
  const bin = join(root, 'system-bin')
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
  await mkdir(bin)
  const path = join(bin, process.platform === 'win32' ? 'python.exe' : 'python')
  await writeFile(path, 'unit test executable candidate')
  await writeFile(
    join(plugin, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test', runtimeRequirements: { python } })
  )
  return { root, plugin, bin, path: await realpath(path) }
}

test.each([
  undefined,
  { version: '3.12', dependencies: [] },
  { systemFallback: { version: '3.12' } },
  { systemFallback: { version: '3.12', dependencies: ['requests'] } },
  { systemFallback: { version: '>=3.10', dependencies: [] } },
])('requires an explicit, verifiable compatibility declaration: %j', async python => {
  const { root, plugin, bin } = await fixture(python === undefined ? null : python)
  const probe = vi.fn()
  expect(
    await findCompatibleSystemPython(
      plugin,
      join(root, 'managed'),
      { PATH: bin },
      process.platform,
      probe
    )
  ).toBeNull()
  expect(probe).not.toHaveBeenCalled()
})

test('probes isolated Python without inheriting credentials or project import settings', async () => {
  const { root, plugin, bin, path } = await fixture()
  const probe = vi.fn(async () => ({
    stdout: JSON.stringify({ path, version: '3.12.8' }),
    stderr: '',
  }))
  const environment = {
    PATH: bin,
    PYTHONHOME: 'wrong-home',
    PYTHONPATH: 'project',
    AUTH_TOKEN: 'private-token',
  }
  expect(
    await findCompatibleSystemPython(
      plugin,
      join(root, 'managed'),
      environment,
      process.platform,
      probe
    )
  ).toEqual({ path, source: 'system', version: '3.12.8' })
  expect(probe.mock.calls[0][1].slice(0, 4)).toEqual(['-I', '-S', '-B', '-c'])
  expect(probe.mock.calls[0][2].env).toEqual({ PATH: bin })
  expect(probe.mock.calls[0][2].cwd).toBe(tmpdir())
  expect(environment.PYTHONHOME).toBe('wrong-home')
})

test('rejects an incompatible Python and excludes the managed runtime from local candidates', async () => {
  const { plugin, bin, path } = await fixture()
  const probe = vi.fn(async () => ({
    stdout: JSON.stringify({ path, version: '3.11.8' }),
    stderr: '',
  }))
  expect(
    await findCompatibleSystemPython(plugin, bin, { PATH: bin }, process.platform, probe)
  ).toBeNull()
  expect(probe).not.toHaveBeenCalled()
  expect(
    await findCompatibleSystemPython(
      plugin,
      join(bin, 'other'),
      { PATH: bin },
      process.platform,
      probe
    )
  ).toBeNull()
})

test('temporary execution shares one installation and a failed prewarm never loops', async () => {
  const { root, plugin, bin, path } = await fixture()
  let rejectDownload!: (error: Error) => void
  const fetch = vi.fn(
    () =>
      new Promise<Response>((_resolve, reject) => {
        rejectDownload = reject
      })
  )
  const probe = vi.fn(async () => {
    return { stdout: JSON.stringify({ path, version: '3.12.8' }), stderr: '' }
  })
  const environment = { PATH: bin, PYTHONHOME: 'ordinary-home' }
  const manager = new PythonRuntimeManager({
    resolveDownloads,
    dataDirectory: root,
    environment,
    runFile: probe,
    fetch,
  })
  const selected = await Promise.all([
    manager.resolvePluginPython(plugin, true),
    manager.resolvePluginPython(plugin, true),
  ])
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  expect(selected.map(item => item.source)).toEqual(['system', 'system'])
  expect((await manager.resolvePluginPython(plugin, true, false)).source).toBe('system')
  expect(fetch).toHaveBeenCalledOnce()
  expect(await manager.status()).toMatchObject({
    state: 'downloading',
    temporaryPythonVersion: '3.12.8',
  })
  expect(manager.environment().PATH).toBe(bin)
  expect(manager.environment().PYTHONHOME).toBe('ordinary-home')
  rejectDownload(new Error('offline'))
  await vi.waitFor(async () => expect(await manager.status()).toMatchObject({ state: 'error' }))
  expect((await manager.prewarm()).state).toBe('error')
  expect(fetch).toHaveBeenCalledOnce()
  fetch.mockRejectedValueOnce(new Error('still offline'))
  await expect(manager.ensure()).rejects.toThrow('still offline')
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('a ready managed interpreter is preferred without probing the system or downloading', async () => {
  const { root, plugin, bin } = await fixture()
  const managed = join(
    root,
    'managed-runtimes',
    'python',
    'bin',
    process.platform === 'win32' ? 'python.exe' : 'python3'
  )
  await mkdir(join(root, 'managed-runtimes', 'python', 'bin'), { recursive: true })
  await writeFile(managed, 'managed test launcher')
  const probe = vi.fn(async () => ({ stdout: 'Python 3.12.12', stderr: '' }))
  const fetch = vi.fn()
  const manager = new PythonRuntimeManager({
    resolveDownloads,
    dataDirectory: root,
    environment: { PATH: bin },
    runFile: probe,
    fetch,
  })
  expect(await manager.resolvePluginPython(plugin, true)).toEqual({
    path: managed,
    source: 'managed',
    version: '3.12.12',
  })
  expect(probe).toHaveBeenCalledOnce()
  expect(probe.mock.calls[0][0]).toBe(managed)
  expect(fetch).not.toHaveBeenCalled()
})

test('selection after an authorization claim cannot start or wait for a new installation', async () => {
  const { root, plugin, bin } = await fixture()
  const fetch = vi.fn()
  const probe = vi.fn()
  const manager = new PythonRuntimeManager({
    resolveDownloads,
    dataDirectory: root,
    environment: { PATH: bin },
    runFile: probe,
    fetch,
  })
  await expect(manager.resolvePluginPython(plugin, true, false)).rejects.toThrow('not ready')
  expect(fetch).not.toHaveBeenCalled()
  expect(probe).not.toHaveBeenCalled()
})

test('managed readiness does not wait for an unfinished local Python probe', async () => {
  const { root, plugin, bin, path } = await fixture()
  let finishProbe!: () => void
  const probe = vi.fn(
    () =>
      new Promise<{ stdout: string; stderr: string }>(resolve => {
        finishProbe = () =>
          resolve({ stdout: JSON.stringify({ path, version: '3.12.8' }), stderr: '' })
      })
  )
  const manager = new PythonRuntimeManager({
    resolveDownloads,
    dataDirectory: root,
    environment: { PATH: bin },
    runFile: probe,
  })
  const ready = {
    ...(await manager.status()),
    state: 'installed' as const,
    version: '3.12.12',
  }
  let finishInstall!: () => void
  vi.spyOn(manager, 'ensure').mockImplementation(
    () =>
      new Promise(resolve => {
        finishInstall = () => resolve(ready)
      })
  )
  const selected = manager.resolvePluginPython(plugin, true)
  await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
  finishInstall()
  await expect(selected).resolves.toEqual({
    path: ready.path,
    version: ready.version,
    source: 'managed',
  })
  finishProbe()
})
