import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { WeworkDesktopControlBridge } from '../host/wework-desktop-control-bridge.js'
import { createDesktopRendererStorage } from '../host/desktop-renderer-storage.js'
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
  const demand = { parent: true, child: true }
  const parent = await fixturePython(root, 'parent', pythonDownloads, async () => demand.parent)
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
  const childEnvironment = {
    WEWORK_PARENT_PYTHON_DOWNLOADS_URL: new URL(
      '/runtime/python/downloads',
      environment.WEWORK_PYTHON_RUNTIME_URL
    ).href,
    WEWORK_PARENT_PYTHON_DOWNLOADS_TOKEN: environment.WEWORK_PYTHON_RUNTIME_TOKEN,
  }
  const child = await fixturePython(
    root,
    'child',
    () =>
      fetchParentPythonRuntimeDownloads(
        childEnvironment,
        fetch,
        runtimeTarget.platform,
        runtimeTarget.arch
      ),
    async () => demand.child
  )
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
  Object.assign(development, { child: { exitCode: null }, session: { status: 'ready' } })
  const command = vi
    .spyOn(development as unknown as { command: (name: string) => Promise<void> }, 'command')
    .mockImplementation(name => childRuntime.handleCommand(name))
  const resumptions: Promise<unknown>[] = []
  let observeLogin!: () => void
  const loginStarted = new Promise<void>(resolve => (observeLogin = resolve))
  const resumeParent = parent.resumeAfterLogin.bind(parent)
  vi.spyOn(parent, 'resumeAfterLogin').mockImplementation(() => {
    observeLogin()
    const resumed = resumeParent()
    resumptions.push(resumed)
    return resumed
  })
  const resumeDevelopment = development.resumePythonAfterLogin.bind(development)
  vi.spyOn(development, 'resumePythonAfterLogin').mockImplementation(() => {
    const resumed = resumeDevelopment()
    resumptions.push(resumed)
    return resumed
  })
  const storage = createDesktopRendererStorage(join(root, 'parent'), {
    enabled: true,
    isShuttingDown: () => false,
    python: () => Promise.resolve(parent),
    development: () => development,
  })
  cleanup.push(() => storage.close())
  return {
    parent,
    child,
    development,
    command,
    demand,
    pythonDownloads,
    started,
    loginStarted,
    failOldRequest: () => rejectOldRequest(new PythonRuntimeLoginRequiredError()),
    login: async () => {
      await storage.update({
        clear: false,
        changes: {
          'wework.cloudConnection': JSON.stringify({
            apiBaseUrl: 'https://cloud.example/api',
            user: { id: 1 },
            credentialMode: 'desktop_refresh',
          }),
        },
      })
      await Promise.allSettled(resumptions.splice(0))
    },
  }
}

async function fixturePython(
  root: string,
  instance: string,
  resolveDownloads: () => Promise<{ uvUrl: string; pythonUrl: string }>,
  hasPluginDemand: () => Promise<boolean>
) {
  const directory = join(root, instance)
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
    resolveDownloads,
    hasPluginDemand,
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

test.each(
  (
    [
      ['before', 'installed'],
      ['after', 'installed'],
      ['before', 'error'],
      ['after', 'error'],
    ] as const
  ).flatMap(([order, recovery]) =>
    (['child', 'parent'] as const).map(target => [target, order, recovery] as const)
  )
)(
  'persisted login resumes %s demand %s login-required completion, ending in %s',
  async (target, order, recovery) => {
    const current = await fixture(recovery)
    const preparation = current[target].prewarm()
    await current.started
    if (order === 'after') {
      current.failOldRequest()
      await expect(preparation).resolves.toMatchObject({ state: 'notInstalled' })
    }
    const resumed = Promise.all([current.login(), current.login()])
    if (order === 'before') {
      await current.loginStarted
      current.failOldRequest()
    }
    await preparation
    await resumed
    expect(current.command).toHaveBeenCalledWith('python-login')
    expect(await current[target].status()).toMatchObject({ state: recovery })
    expect(current.pythonDownloads).toHaveBeenCalledTimes(2)
    expect(await current[target === 'child' ? 'parent' : 'child'].status()).toMatchObject({
      state: 'notInstalled',
    })
    await current.login()
    await current[target].prewarm()
    expect(current.pythonDownloads).toHaveBeenCalledTimes(2)
  }
)

test.each(
  (['parent', 'child'] as const).flatMap(target =>
    (['before', 'after'] as const).map(order => [target, order] as const)
  )
)(
  'persisted login does not restore removed %s demand %s login-required completion',
  async (target, order) => {
    const current = await fixture()
    const pending = current[target].prewarm()
    await current.started
    current.demand[target] = false
    if (order === 'after') {
      current.failOldRequest()
      await pending
    }
    const resumed = current.login()
    if (order === 'before') {
      await current.loginStarted
      current.failOldRequest()
    }
    await pending
    await resumed
    await current.login()
    expect(await current[target].status()).toMatchObject({ state: 'notInstalled' })
    expect(current.pythonDownloads).toHaveBeenCalledTimes(1)
    current.demand[target] = true
    await current.login()
    expect(await current[target].status()).toMatchObject({ state: 'installed' })
    expect(current.pythonDownloads).toHaveBeenCalledTimes(2)
  }
)

test.each(['parent', 'child'] as const)(
  'persisted login preserves explicit manual installation in %s without plugins',
  async target => {
    const current = await fixture()
    current.demand[target] = false
    const pending = current[target].ensure({ manual: true })
    const rejected = expect(pending).rejects.toBeInstanceOf(PythonRuntimeLoginRequiredError)
    await current.started
    current.failOldRequest()
    await rejected
    await current.login()
    expect(await current[target].status()).toMatchObject({ state: 'installed' })
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

test.each(['stopping', 'stopped'] as const)(
  'parent login does not start a %s development instance',
  async status => {
    const current = await fixture()
    Object.assign(current.development, {
      child: status === 'stopping' ? { exitCode: null } : null,
      session: { status },
    })
    await current.login()
    expect(current.command).not.toHaveBeenCalled()
    expect(current.pythonDownloads).not.toHaveBeenCalled()
  }
)
