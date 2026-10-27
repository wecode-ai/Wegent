import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WeworkDesktopControlBridge } from './wework-desktop-control-bridge.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WeworkDesktopControlBridge', () => {
  test('waits for Python readiness with a token that cannot control the desktop', async () => {
    const registryDirectory = await mkdtemp(join(tmpdir(), 'wework-control-python-'))
    directories.push(registryDirectory)
    let complete!: (status: unknown) => void
    const ensurePython = vi.fn(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const bridge = new WeworkDesktopControlBridge({
      instanceId: 'python-test',
      instanceKind: 'main',
      displayName: 'Wework',
      projectRoot: null,
      registryDirectory,
      window: () => null,
      ensurePython,
    })
    await bridge.start()
    const environment = bridge.environment()
    const endpoint = environment.WEWORK_PYTHON_RUNTIME_URL!
    const headers = { Authorization: `Bearer ${environment.WEWORK_PYTHON_RUNTIME_TOKEN}` }
    try {
      const unauthorized = await fetch(endpoint, { method: 'POST' })
      expect(unauthorized.status).toBe(401)
      expect(ensurePython).not.toHaveBeenCalled()

      const desktop = await fetch(new URL('/status', endpoint), { headers })
      expect(desktop.status).toBe(401)

      let settled = false
      const pending = fetch(endpoint, { method: 'POST', headers })
        .then(response => response.json())
        .then(result => {
          settled = true
          return result
        })
      await vi.waitFor(() => expect(ensurePython).toHaveBeenCalledOnce())
      expect(settled).toBe(false)
      complete({ state: 'installed', version: '3.12.12' })
      await expect(pending).resolves.toEqual({
        ok: true,
        data: { state: 'installed', version: '3.12.12' },
      })

      ensurePython.mockRejectedValueOnce(new Error('Python download failed'))
      const failure = await fetch(endpoint, { method: 'POST', headers }).then(response =>
        response.json()
      )
      expect(failure).toEqual({ ok: false, error: 'Python download failed' })
    } finally {
      await bridge.stop()
    }
    expect(bridge.environment()).toEqual({})
  })

  test('closes pending Python requests during shutdown', async () => {
    const registryDirectory = await mkdtemp(join(tmpdir(), 'wework-control-python-stop-'))
    directories.push(registryDirectory)
    const ensurePython = vi.fn(() => new Promise(() => undefined))
    const bridge = new WeworkDesktopControlBridge({
      instanceId: 'python-stop-test',
      instanceKind: 'main',
      displayName: 'Wework',
      projectRoot: null,
      registryDirectory,
      window: () => null,
      ensurePython,
    })
    await bridge.start()
    const environment = bridge.environment()
    const pending = fetch(environment.WEWORK_PYTHON_RUNTIME_URL!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.WEWORK_PYTHON_RUNTIME_TOKEN}` },
    }).catch(() => null)
    await vi.waitFor(() => expect(ensurePython).toHaveBeenCalledOnce())
    await bridge.stop()
    await expect(pending).resolves.toBeNull()
  })

  test('registers an authenticated generic desktop instance and removes it on stop', async () => {
    const registryDirectory = await mkdtemp(join(tmpdir(), 'wework-control-'))
    directories.push(registryDirectory)
    const executeJavaScript = vi.fn(async code => ({
      ok: true,
      inspected: code.includes('__WEWORK_INSPECT_OPTIONS__') === false,
    }))
    const bridge = new WeworkDesktopControlBridge({
      instanceId: 'plugin-development-example',
      instanceKind: 'core-dsh-plugin-development',
      displayName: 'Example',
      projectRoot: '/workspace/example',
      registryDirectory,
      window: () =>
        ({
          focus: vi.fn(),
          isFocused: () => false,
          isMinimized: () => false,
          isVisible: () => true,
          restore: vi.fn(),
          show: vi.fn(),
          webContents: {
            capturePage: vi.fn(async () => ({
              isEmpty: () => false,
              toDataURL: () => 'data:image/png;base64,AA==',
            })),
            debugger: {
              attach: vi.fn(),
              detach: vi.fn(),
              isAttached: vi.fn(() => false),
              sendCommand: vi.fn(),
            },
            executeJavaScript,
            getTitle: () => 'Wework',
            getURL: () => 'http://127.0.0.1/workbench',
            isDestroyed: () => false,
          },
        }) as never,
    })

    await bridge.start()
    const [filename] = await readdir(registryDirectory)
    const record = JSON.parse(await readFile(join(registryDirectory, filename), 'utf8'))
    const headers = { Authorization: `Bearer ${record.token}` }

    const status = await fetch(`http://${record.address}/status`, { headers }).then(response =>
      response.json()
    )
    expect(status).toMatchObject({
      ok: true,
      data: {
        instanceId: 'plugin-development-example',
        projectRoot: '/workspace/example',
        ready: true,
      },
    })

    const inspect = await fetch(`http://${record.address}/desktop`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'inspect' }),
    }).then(response => response.json())
    expect(inspect).toMatchObject({ ok: true, data: { ok: true, inspected: true } })
    expect(executeJavaScript).toHaveBeenCalledOnce()

    await bridge.stop()
    await expect(readdir(registryDirectory)).resolves.toEqual([])
  })

  test('falls back to CDP when Electron capturePage fails with UnknownVizError', async () => {
    const registryDirectory = await mkdtemp(join(tmpdir(), 'wework-control-screenshot-'))
    directories.push(registryDirectory)
    let debuggerAttached = false
    const debuggerSession = {
      attach: vi.fn(() => {
        debuggerAttached = true
      }),
      detach: vi.fn(() => {
        debuggerAttached = false
      }),
      isAttached: vi.fn(() => debuggerAttached),
      sendCommand: vi.fn().mockResolvedValue({ data: 'Q0RQ' }),
    }
    const bridge = new WeworkDesktopControlBridge({
      instanceId: 'plugin-development-example',
      instanceKind: 'core-dsh-plugin-development',
      displayName: 'Example',
      projectRoot: '/workspace/example',
      registryDirectory,
      window: () =>
        ({
          focus: vi.fn(),
          isFocused: () => false,
          isMinimized: () => false,
          isVisible: () => true,
          restore: vi.fn(),
          show: vi.fn(),
          webContents: {
            capturePage: vi.fn().mockRejectedValue(new Error('wework: UnknownVizError')),
            debugger: debuggerSession,
            executeJavaScript: vi.fn(),
            getTitle: () => 'Wework',
            getURL: () => 'http://127.0.0.1/workbench',
            isDestroyed: () => false,
          },
        }) as never,
    })

    await bridge.start()
    const [filename] = await readdir(registryDirectory)
    const record = JSON.parse(await readFile(join(registryDirectory, filename), 'utf8'))
    const screenshot = await fetch(`http://${record.address}/desktop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${record.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'screenshot' }),
    }).then(response => response.json())

    expect(screenshot).toEqual({
      ok: true,
      data: { ok: true, dataUrl: 'data:image/png;base64,Q0RQ' },
    })
    expect(debuggerSession.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      captureBeyondViewport: false,
      format: 'png',
      fromSurface: true,
    })
    expect(debuggerSession.detach).toHaveBeenCalledOnce()
    await bridge.stop()
  })

  test('exposes only fixed Smart App verification actions', async () => {
    const registryDirectory = await mkdtemp(join(tmpdir(), 'wework-control-smart-app-'))
    directories.push(registryDirectory)
    const inspectProject = vi.fn().mockResolvedValue({ status: 'passed' })
    const verifyProject = vi.fn().mockResolvedValue({ status: 'passed' })
    const packProject = vi.fn().mockResolvedValue({ archivePath: '/workspace/app.zip' })
    const bridge = new WeworkDesktopControlBridge({
      instanceId: 'main',
      instanceKind: 'main',
      displayName: 'Wework',
      projectRoot: null,
      registryDirectory,
      window: () => null,
      smartApps: () => ({ inspectProject, verifyProject, packProject }),
    })
    await bridge.start()
    const [filename] = await readdir(registryDirectory)
    const record = JSON.parse(await readFile(join(registryDirectory, filename), 'utf8'))
    const headers = {
      Authorization: `Bearer ${record.token}`,
      'content-type': 'application/json',
    }

    const inspect = await fetch(`http://${record.address}/smart-app`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'inspect', projectRoot: '/workspace/app' }),
    }).then(response => response.json())
    expect(inspect).toEqual({ ok: true, data: { status: 'passed' } })
    expect(inspectProject).toHaveBeenCalledWith('/workspace/app')

    const packed = await fetch(`http://${record.address}/smart-app`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'pack',
        projectRoot: '/workspace/app',
        outputPath: '/workspace/app.zip',
      }),
    }).then(response => response.json())
    expect(packed).toEqual({ ok: true, data: { archivePath: '/workspace/app.zip' } })
    expect(packProject).toHaveBeenCalledWith('/workspace/app', '/workspace/app.zip')

    const arbitrary = await fetch(`http://${record.address}/smart-app`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'run',
        projectRoot: '/workspace/app',
        command: 'node',
        argv: ['malicious.js'],
      }),
    }).then(response => response.json())
    expect(arbitrary).toMatchObject({ ok: false, error: expect.stringContaining('request') })
    expect(verifyProject).not.toHaveBeenCalled()

    await bridge.stop()
  })
})
