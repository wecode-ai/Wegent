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
  CuaDriver: { create: mocks.create },
  currentMacOsPermissionStatus: mocks.currentPermissions,
}))

vi.mock('@trycua/cua-driver/electron', () => ({
  openMacOSScreenRecordingSettings: vi.fn(),
  requestMacOSPermissions: vi.fn(),
}))

const directories: string[] = []

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
      uniffiDestroy: vi.fn(),
    })
  })

  afterEach(async () => {
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
      error: 'aborted',
    })
    await expect(service.status()).resolves.toMatchObject({ currentTool: null })
    await service.stop()
  })
})
