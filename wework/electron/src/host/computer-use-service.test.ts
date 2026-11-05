import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ComputerUseService } from './computer-use-service.js'

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  create: vi.fn(),
  currentPermissions: vi.fn(),
  listToolsJson: vi.fn(),
  shutdown: vi.fn(),
}))

vi.mock('@trycua/cua-driver', () => ({
  currentMacOsPermissionStatus: mocks.currentPermissions,
}))

vi.mock('./computer-use-driver-process.js', () => ({
  ComputerUseDriverProcess: { create: mocks.create },
}))

vi.mock('@trycua/cua-driver/electron', () => ({
  openMacOSScreenRecordingSettings: vi.fn(),
  requestMacOSPermissions: vi.fn(),
}))

const directories: string[] = []
const services: ComputerUseService[] = []

async function openBridge(timeoutMs = 90_000) {
  const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-cancellation-'))
  directories.push(executorHome)
  const service = new ComputerUseService(executorHome, 'darwin', timeoutMs)
  services.push(service)
  await service.setEnabled(true)
  const runtime = JSON.parse(
    await readFile(join(executorHome, 'runtime/computer-use-bridge.json'), 'utf8')
  ) as { address: string; token: string }
  const call = (body: Record<string, unknown>, signal?: AbortSignal) =>
    fetch(`http://${runtime.address}/computer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  return { service, call }
}

describe('ComputerUseService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.currentPermissions.mockReturnValue({ accessibility: true, screenRecording: true })
    mocks.listToolsJson.mockResolvedValue(
      JSON.stringify({
        tools: [
          {
            name: 'list_apps',
            description: 'List apps',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      })
    )
    mocks.callTool.mockResolvedValue({
      text: 'Apps listed',
      images: [],
      isError: false,
      degraded: false,
      rawJson: '{}',
    })
    mocks.create.mockReturnValue({
      callTool: mocks.callTool,
      listToolsJson: mocks.listToolsJson,
      shutdown: mocks.shutdown,
    })
  })

  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.stop()))
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  test('publishes CUA tools and calls them through the private bridge', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-'))
    directories.push(executorHome)
    const service = new ComputerUseService(executorHome, 'darwin')

    await expect(service.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: true,
    })
    const runtime = JSON.parse(
      await readFile(join(executorHome, 'runtime/computer-use-bridge.json'), 'utf8')
    ) as { address: string; token: string }
    const toolsResponse = await fetch(`http://${runtime.address}/computer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'listTools' }),
    })
    await expect(toolsResponse.json()).resolves.toMatchObject({
      ok: true,
      data: [{ name: 'list_apps' }],
    })

    const callResponse = await fetch(`http://${runtime.address}/computer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'callTool', name: 'list_apps', arguments: {} }),
    })
    await expect(callResponse.json()).resolves.toMatchObject({
      ok: true,
      data: { text: 'Apps listed' },
    })
    expect(mocks.callTool).toHaveBeenCalledWith(
      'list_apps',
      '{}',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )

    await service.stop()
    expect(mocks.shutdown).toHaveBeenCalledOnce()
  })

  test('starts automatically after macOS permissions become available', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-permissions-'))
    directories.push(executorHome)
    const service = new ComputerUseService(executorHome, 'darwin')
    mocks.currentPermissions.mockReturnValue({
      accessibility: false,
      screenRecording: true,
    })

    await expect(service.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
    })
    mocks.currentPermissions.mockReturnValue({
      accessibility: true,
      screenRecording: true,
    })

    await expect(service.status()).resolves.toMatchObject({
      enabled: true,
      running: true,
    })
    await service.stop()
  })

  test('removes a stale bridge record while waiting for macOS permissions', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-stale-'))
    directories.push(executorHome)
    const runtimePath = join(executorHome, 'runtime/computer-use-bridge.json')
    await mkdir(join(executorHome, 'runtime'))
    await writeFile(runtimePath, '{"address":"127.0.0.1:1","token":"stale"}\n')
    mocks.currentPermissions.mockReturnValue({
      accessibility: false,
      screenRecording: true,
    })
    const service = new ComputerUseService(executorHome, 'darwin')

    await expect(service.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
    })
    await expect(readFile(runtimePath, 'utf8')).rejects.toThrow()
  })

  test('shuts down a driver when publishing its bridge record fails', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-start-failure-'))
    directories.push(executorHome)
    const runtimePath = join(executorHome, 'runtime/computer-use-bridge.json')
    mocks.currentPermissions.mockImplementationOnce(() => {
      mkdirSync(runtimePath, { recursive: true })
      return { accessibility: true, screenRecording: true }
    })
    const service = new ComputerUseService(executorHome, 'darwin')

    await expect(service.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
      error: expect.any(String),
    })
    expect(mocks.shutdown).toHaveBeenCalledOnce()
  })

  test('keeps the active action visible until it is stopped', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-stop-'))
    directories.push(executorHome)
    const service = new ComputerUseService(executorHome, 'darwin')
    mocks.callTool.mockImplementation(
      (_name: string, _arguments: string, options: { signal: AbortSignal }): Promise<never> =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
    )
    await service.setEnabled(true)
    const runtime = JSON.parse(
      await readFile(join(executorHome, 'runtime/computer-use-bridge.json'), 'utf8')
    ) as { address: string; token: string }
    const headers = {
      authorization: `Bearer ${runtime.token}`,
      'content-type': 'application/json',
    }

    const actionResponse = fetch(`http://${runtime.address}/computer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'callTool', name: 'click', arguments: {} }),
    })
    await vi.waitFor(async () => {
      await expect(service.status()).resolves.toMatchObject({ currentTool: 'click' })
    })
    await fetch(`http://${runtime.address}/computer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'listTools' }),
    })
    await expect(service.status()).resolves.toMatchObject({ currentTool: 'click' })

    await service.stopCurrentAction()
    await expect(actionResponse.then(response => response.json())).resolves.toMatchObject({
      ok: false,
      error: 'Computer use action stopped by user',
    })
    await expect(service.status()).resolves.toMatchObject({ currentTool: null })
    await service.stop()
  })

  test('removes a crashed bridge and requires explicit re-enable without replaying actions', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-crash-'))
    directories.push(executorHome)
    const service = new ComputerUseService(executorHome, 'darwin')
    const runtimePath = join(executorHome, 'runtime/computer-use-bridge.json')
    await service.setEnabled(true)
    const onExit = mocks.create.mock.calls[0][0] as (error: Error) => void
    onExit(new Error('Computer use driver exited (5); action outcome is unknown'))

    await vi.waitFor(async () => {
      await expect(service.status()).resolves.toMatchObject({
        enabled: true,
        running: false,
        error: expect.stringContaining('action outcome is unknown'),
      })
      await expect(readFile(runtimePath, 'utf8')).rejects.toThrow()
    })
    await service.status()
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.callTool).not.toHaveBeenCalled()

    await expect(service.setEnabled(true)).resolves.toMatchObject({ running: true, error: null })
    expect(mocks.create).toHaveBeenCalledTimes(2)
    await service.stop()
  })

  test('ignores exit notifications belonging to a stopped generation', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-generation-'))
    directories.push(executorHome)
    const service = new ComputerUseService(executorHome, 'darwin')
    await service.setEnabled(true)
    const onExit = mocks.create.mock.calls[0][0] as (error: Error) => void
    await service.setEnabled(false)
    mocks.create.mockReturnValue({
      callTool: mocks.callTool,
      listToolsJson: mocks.listToolsJson,
      shutdown: mocks.shutdown,
    })
    await service.setEnabled(true)
    onExit(new Error('Old driver exited'))
    // Drain the service operation queue before checking the new generation.
    await service.setEnabled(true)
    await expect(service.status()).resolves.toMatchObject({ running: true, error: null })
    await service.stop()
  })

  test('handles a driver exit during creation before the driver is assigned', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-computer-use-early-exit-'))
    directories.push(executorHome)
    mocks.create.mockImplementationOnce((onExit: (error: Error) => void) => {
      const error = new Error('Driver exited before readiness')
      onExit(error)
      return Promise.reject(error)
    })
    const service = new ComputerUseService(executorHome, 'darwin')
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      running: false,
      error: 'Driver exited before readiness',
    })
    await expect(service.status()).resolves.toMatchObject({
      running: false,
      error: 'Driver exited before readiness',
    })
    expect(mocks.create).toHaveBeenCalledOnce()
    await service.stop()
  })

  test('times out the client but retains admission until the SDK call settles', async () => {
    let finish!: () => void
    let signal!: AbortSignal
    const pending = new Promise<void>(resolve => {
      finish = resolve
    })
    mocks.callTool.mockImplementationOnce(async (_name, _arguments, options) => {
      signal = options.signal
      await pending
      return { text: 'late result', images: [], isError: false }
    })
    const { service, call } = await openBridge(30)
    const response = await call({ action: 'callTool', name: 'start_session' })
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'Computer use start_session timed out after 30ms',
    })
    expect(signal.aborted).toBe(true)
    await expect(service.status()).resolves.toMatchObject({ currentTool: 'start_session' })
    await expect(
      call({ action: 'callTool', name: 'click' }).then(response => response.json())
    ).resolves.toMatchObject({ ok: false, error: 'Another computer use action is already running' })
    expect(mocks.callTool).toHaveBeenCalledOnce()
    finish()
    await vi.waitFor(async () => {
      await expect(service.status()).resolves.toMatchObject({ currentTool: null })
    })
    await expect(
      call({ action: 'callTool', name: 'list_apps' }).then(response => response.json())
    ).resolves.toMatchObject({ ok: true, data: { text: 'Apps listed' } })
  })

  test.each(['callTool', 'listTools'])(
    'cancels %s when the HTTP client disconnects',
    async action => {
      let signal!: AbortSignal
      const pending = (_name: unknown, _arguments: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal
        return new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      if (action === 'callTool') mocks.callTool.mockImplementationOnce(pending)
      else mocks.listToolsJson.mockImplementationOnce(options => pending(null, null, options))
      const { service, call } = await openBridge()
      const controller = new AbortController()
      const response = call({ action, name: 'list_apps' }, controller.signal)
      const rejected = expect(response).rejects.toThrow()
      await vi.waitFor(() => expect(signal).toBeDefined())
      controller.abort()
      await rejected
      await vi.waitFor(() => expect(signal.aborted).toBe(true))
      await vi.waitFor(async () => {
        await expect(service.status()).resolves.toMatchObject({ currentTool: null })
      })
      await expect(
        call({ action: 'listTools' }).then(response => response.json())
      ).resolves.toMatchObject({ ok: true })
    }
  )

  test('disabling computer use cancels pending tool discovery before shutting down', async () => {
    let signal!: AbortSignal
    mocks.listToolsJson.mockImplementationOnce(options => {
      signal = options.signal
      return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const { service, call } = await openBridge()
    const discovery = call({ action: 'listTools' }).then(response => response.json())
    await vi.waitFor(() => expect(signal).toBeDefined())
    await service.setEnabled(false)
    expect(signal.aborted).toBe(true)
    await expect(discovery).resolves.toMatchObject({
      ok: false,
      error: 'Computer use service stopped',
    })
    await expect(service.status()).resolves.toMatchObject({ enabled: false, running: false })
  })
})
