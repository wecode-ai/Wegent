import { beforeEach, describe, expect, test, vi } from 'vitest'

import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import { getVncConfig } from './api'
import { openCloudDesktop } from './openCloudDesktop'
import { buildVncPageUrl, prepareVncSession } from './session'
import { openSystemBrowserIfCurrent } from './systemBrowser'

vi.mock('@/lib/embedded-browser', () => ({ requestEmbeddedBrowserOpen: vi.fn() }))
vi.mock('./api', () => ({ getVncConfig: vi.fn() }))
vi.mock('./session', () => ({
  buildVncPageUrl: vi.fn(),
  prepareVncSession: vi.fn(),
}))
vi.mock('./systemBrowser', () => ({ openSystemBrowserIfCurrent: vi.fn() }))

const connection = {
  apiBaseUrl: 'https://cloud.example.com/api',
  isConnected: true,
  socketBaseUrl: 'https://cloud.example.com',
  token: 'cloud-token',
}

describe('openCloudDesktop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVncConfig).mockResolvedValue({
      sandbox_id: 'sandbox-1',
      signature: 'signature',
      wss_url: 'wss://cloud.example.com/vnc',
    })
    vi.mocked(prepareVncSession).mockResolvedValue('session-1')
    vi.mocked(buildVncPageUrl).mockResolvedValue(
      'http://127.0.0.1:43123/vnc.html?sessionId=session-1&sandboxId=sandbox-1'
    )
    vi.mocked(openSystemBrowserIfCurrent).mockResolvedValue(true)
    vi.mocked(requestEmbeddedBrowserOpen).mockReturnValue(true)
  })

  test('opens a loopback viewer with the system browser when status has no VNC URL', async () => {
    await expect(
      openCloudDesktop({
        connection,
        deviceId: 'device/1',
        isCurrent: () => true,
        target: 'system',
      })
    ).resolves.toBe(true)

    expect(getVncConfig).toHaveBeenCalledWith(connection, 'device/1')
    expect(prepareVncSession).toHaveBeenCalledWith({
      deviceId: 'device/1',
      socketBaseUrl: 'https://cloud.example.com',
      token: 'cloud-token',
    })
    expect(buildVncPageUrl).toHaveBeenCalledWith({
      sandboxId: 'sandbox-1',
      sessionId: 'session-1',
    })
    expect(openSystemBrowserIfCurrent).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/vnc.html?sessionId=session-1&sandboxId=sandbox-1',
      expect.any(Function)
    )
    expect(requestEmbeddedBrowserOpen).not.toHaveBeenCalled()
  })

  test('does not report an error when the system-browser request becomes stale', async () => {
    const isCurrent = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    vi.mocked(openSystemBrowserIfCurrent).mockImplementationOnce(async (_value, current) => {
      expect(current()).toBe(false)
      return false
    })

    await expect(
      openCloudDesktop({
        connection,
        deviceId: 'device-1',
        isCurrent,
        target: 'system',
      })
    ).resolves.toBe(false)

    expect(openSystemBrowserIfCurrent).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/vnc.html?sessionId=session-1&sandboxId=sandbox-1',
      isCurrent
    )
  })

  test('opens a credential-free loopback page in the built-in browser', async () => {
    await expect(
      openCloudDesktop({
        connection,
        deviceId: 'device/1',
        isCurrent: () => true,
        target: 'embedded',
      })
    ).resolves.toBe(true)

    expect(getVncConfig).toHaveBeenCalledWith(connection, 'device/1')
    expect(prepareVncSession).toHaveBeenCalledWith({
      deviceId: 'device/1',
      socketBaseUrl: 'https://cloud.example.com',
      token: 'cloud-token',
    })
    expect(buildVncPageUrl).toHaveBeenCalledWith({
      sandboxId: 'sandbox-1',
      sessionId: 'session-1',
    })
    const pageUrl = vi.mocked(requestEmbeddedBrowserOpen).mock.calls[0][0]
    expect(pageUrl).not.toContain('cloud-token')
    expect(pageUrl).not.toContain('wss://')
    expect(requestEmbeddedBrowserOpen).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/vnc.html?sessionId=session-1&sandboxId=sandbox-1'
    )
    expect(openSystemBrowserIfCurrent).not.toHaveBeenCalled()
  })

  test('drops a stale request after configuration without preparing a session', async () => {
    await expect(
      openCloudDesktop({
        connection,
        deviceId: 'device-1',
        isCurrent: () => false,
        target: 'embedded',
      })
    ).resolves.toBe(false)

    expect(prepareVncSession).not.toHaveBeenCalled()
    expect(requestEmbeddedBrowserOpen).not.toHaveBeenCalled()
  })

  test('drops a stale request after session preparation without opening a page', async () => {
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)

    await expect(
      openCloudDesktop({ connection, deviceId: 'device-1', isCurrent, target: 'embedded' })
    ).resolves.toBe(false)

    expect(prepareVncSession).toHaveBeenCalledOnce()
    expect(buildVncPageUrl).not.toHaveBeenCalled()
    expect(requestEmbeddedBrowserOpen).not.toHaveBeenCalled()
  })

  test('drops a stale embedded request after resolving the loopback viewer', async () => {
    const isCurrent = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    await expect(
      openCloudDesktop({ connection, deviceId: 'device-1', isCurrent, target: 'embedded' })
    ).resolves.toBe(false)

    expect(buildVncPageUrl).toHaveBeenCalledOnce()
    expect(requestEmbeddedBrowserOpen).not.toHaveBeenCalled()
  })

  test('rejects an incomplete connection before requesting configuration', async () => {
    await expect(
      openCloudDesktop({
        connection: { apiBaseUrl: '/api', isConnected: true, token: 'token' },
        deviceId: 'device-1',
        isCurrent: () => true,
        target: 'embedded',
      })
    ).rejects.toThrow('Cloud connection is required')
    expect(getVncConfig).not.toHaveBeenCalled()
  })

  test('preserves configuration and session preparation failures', async () => {
    const configError = new Error('configuration failed')
    vi.mocked(getVncConfig).mockRejectedValueOnce(configError)
    await expect(
      openCloudDesktop({
        connection,
        deviceId: 'device-1',
        isCurrent: () => true,
        target: 'embedded',
      })
    ).rejects.toBe(configError)

    const sessionError = new Error('session failed')
    vi.mocked(prepareVncSession).mockRejectedValueOnce(sessionError)
    await expect(
      openCloudDesktop({
        connection,
        deviceId: 'device-1',
        isCurrent: () => true,
        target: 'embedded',
      })
    ).rejects.toBe(sessionError)
  })

  test('rejects a missing sandbox ID before preparing a session', async () => {
    vi.mocked(getVncConfig).mockResolvedValueOnce({
      sandbox_id: '',
      signature: 'signature',
      wss_url: 'wss://cloud.example.com/vnc',
    })

    await expect(
      openCloudDesktop({
        connection,
        deviceId: 'device-1',
        isCurrent: () => true,
        target: 'embedded',
      })
    ).rejects.toThrow('Desktop sandbox ID is missing')
    expect(prepareVncSession).not.toHaveBeenCalled()
  })

  test('rejects when the built-in browser refuses the local page', async () => {
    vi.mocked(requestEmbeddedBrowserOpen).mockReturnValueOnce(false)

    await expect(
      openCloudDesktop({
        connection,
        deviceId: 'device-1',
        isCurrent: () => true,
        target: 'embedded',
      })
    ).rejects.toThrow('Built-in browser is unavailable')
  })
})
