import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { WeworkDesktopControlBridge } from '../host/wework-desktop-control-bridge.js'
import { PluginDevelopmentChildRuntime } from './plugin-development-child-runtime.js'
import { PluginDevelopmentManager } from './plugin-development-manager.js'
import {
  fetchParentPythonRuntimeDownloads,
  PythonRuntimeLoginRequiredError,
} from './python-runtime-downloads.js'
import { PythonRuntimeManager } from './python-runtime.js'

const runtimeTarget = { platform: 'darwin', arch: 'arm64' } as const
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function fixture(recovery: 'installed' | 'error' = 'installed') {
  const root = await mkdtemp(join(tmpdir(), 'python-parent-login-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let requestStarted!: () => void
  const started = new Promise<void>(resolve => (requestStarted = resolve))
  let rejectOldRequest!: (error: Error) => void
  const oldRequest = new Promise<never>((_resolve, reject) => (rejectOldRequest = reject))
  const downloads = {
    uvUrl: 'https://github.com/astral-sh/uv/releases/download/0.9.5/uv-aarch64-apple-darwin.tar.gz',
    pythonUrl:
      'https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.12.12%2B20251014-aarch64-apple-darwin-install_only_stripped.tar.gz',
  }
  const pythonDownloads = vi
    .fn()
    .mockImplementationOnce(() => {
      requestStarted()
      return oldRequest
    })
    .mockImplementation(async () => {
      if (recovery === 'error') throw new Error('Parent configuration is unavailable')
      return downloads
    })
  const parent = new PythonRuntimeManager({
    dataDirectory: join(root, 'parent'),
    environment: {},
    ...runtimeTarget,
    resolveDownloads: pythonDownloads,
  })
  const bridge = new WeworkDesktopControlBridge({
    instanceId: 'parent-login',
    instanceKind: 'main',
    displayName: 'Parent login test',
    projectRoot: null,
    registryDirectory: join(root, 'registry'),
    window: () => null,
    ensurePython: () => parent.ensure(),
    pythonDownloads,
  })
  await bridge.start()
  cleanup.push(() => bridge.stop())
  const environment = bridge.environment()
  const child = await childPython(root, {
    WEWORK_PARENT_PYTHON_DOWNLOADS_URL: new URL(
      '/runtime/python/downloads',
      environment.WEWORK_PYTHON_RUNTIME_URL
    ).href,
    WEWORK_PARENT_PYTHON_DOWNLOADS_TOKEN: environment.WEWORK_PYTHON_RUNTIME_TOKEN,
  })
  const childRuntime = new PluginDevelopmentChildRuntime({
    sourceRoot: root,
    statePath: join(root, 'state.json'),
    focus: async () => {},
    openDevTools: () => {},
    restartCoreDsh: async () => {},
    resumePythonAfterLogin: async () => {
      await child.resumeAfterLogin()
    },
    requestStop: () => {},
    getCoreDshPid: () => null,
    isShuttingDown: () => false,
  })
  const development = new PluginDevelopmentManager({
    command: process.execPath,
    args: [],
    environment: {},
    userDataDirectory: root,
  })
  // Replace only the native second-instance transport; command handling and downloads stay real.
  Object.assign(development, { child: { exitCode: null }, session: {} })
  const command = vi
    .spyOn(development as unknown as { command: (name: string) => Promise<void> }, 'command')
    .mockImplementation(name => childRuntime.handleCommand(name))
  return {
    parent,
    child,
    development,
    command,
    pythonDownloads,
    started,
    failOldRequest: () => rejectOldRequest(new PythonRuntimeLoginRequiredError()),
    login: () => Promise.all([parent.resumeAfterLogin(), development.resumePythonAfterLogin()]),
  }
}

async function childPython(root: string, environment: NodeJS.ProcessEnv) {
  const directory = join(root, 'child')
  const runtimeRoot = join(directory, 'managed-runtimes', 'python')
  const runtimeBin = join(runtimeRoot, 'bin')
  const pythonPath = join(runtimeBin, 'python3')
  const uvPath = join(runtimeRoot, 'bootstrap', 'uv-0.9.5', 'uv')
  await mkdir(join(runtimeRoot, 'bootstrap', 'uv-0.9.5'), { recursive: true })
  await mkdir(runtimeBin, { recursive: true })
  await writeFile(uvPath, 'cached uv fixture')
  return new PythonRuntimeManager({
    dataDirectory: directory,
    environment: {},
    ...runtimeTarget,
    resolveDownloads: () =>
      fetchParentPythonRuntimeDownloads(
        environment,
        fetch,
        runtimeTarget.platform,
        runtimeTarget.arch
      ),
    fetch: vi.fn(),
    fileSha256: async () => 'd54989c0037e115f53c34a5658c2cc0ff5c44e35b5635ed9a5463b9caa364f81',
    runFile: async file => {
      if (file === uvPath) {
        await writeFile(pythonPath, 'installed launcher fixture')
        return { stdout: '', stderr: '' }
      }
      if (file === pythonPath) return { stdout: 'Python 3.12.12', stderr: '' }
      throw new Error(`Unexpected command: ${file}`)
    },
  })
}

test.each([
  ['before', 'installed'],
  ['after', 'installed'],
  ['before', 'error'],
  ['after', 'error'],
] as const)(
  'forwards parent login %s child login-required completion, with recovery ending in %s',
  async (order, recovery) => {
    const current = await fixture(recovery)
    const preparation = current.child.prewarm()
    await current.started
    if (order === 'after') {
      current.failOldRequest()
      await expect(preparation).resolves.toMatchObject({ state: 'notInstalled' })
    }
    const resumed = Promise.all([current.login(), current.login()])
    if (order === 'before') current.failOldRequest()
    await preparation
    await resumed
    expect(current.command).toHaveBeenCalledWith('python-login')
    expect(await current.child.status()).toMatchObject({ state: recovery })
    expect(current.pythonDownloads).toHaveBeenCalledTimes(2)
    expect(await current.parent.status()).toMatchObject({ state: 'notInstalled' })
    await current.login()
    await current.child.prewarm()
    expect(current.pythonDownloads).toHaveBeenCalledTimes(2)
  }
)

test('parent login does not create Python demand in either instance', async () => {
  const current = await fixture()
  await current.login()
  expect(current.pythonDownloads).not.toHaveBeenCalled()
  expect(await current.child.status()).toMatchObject({ state: 'notInstalled' })
  expect(await current.parent.status()).toMatchObject({ state: 'notInstalled' })
})

test.each([
  ['linux', 'x64'],
  ['win32', 'x64'],
  ['darwin', 'x64'],
] as const)('keeps the fixture target consistent on a %s-%s host', async (platform, arch) => {
  // Only host metadata changes; the fixture's interpreter and files stay simulated.
  vi.stubGlobal('process', { ...process, platform, arch })
  const current = await fixture()
  const preparation = current.child.prewarm()
  await current.started
  current.failOldRequest()
  await preparation
  await current.login()
  expect(await current.child.status()).toMatchObject({ state: 'installed' })
  expect(current.pythonDownloads).toHaveBeenCalledTimes(2)
})

test('parent login does not start a stopped development instance', async () => {
  const current = await fixture()
  Object.assign(current.development, { child: null })
  await current.login()
  expect(current.command).not.toHaveBeenCalled()
  expect(current.pythonDownloads).not.toHaveBeenCalled()
})
