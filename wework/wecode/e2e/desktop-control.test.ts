import { beforeEach, describe, expect, test, vi } from 'vitest'

import { desktopControlExtension } from '@wecode/extensions/desktop-control'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn(),
  evalEmbeddedBrowserJson: vi.fn(),
  openEmbeddedBrowser: vi.fn(),
  relabelEmbeddedBrowser: vi.fn(),
  setEmbeddedBrowserBounds: vi.fn(),
}))
const cloudDesktopMocks = vi.hoisted(() => ({
  openCloudDesktop: vi.fn(),
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)
vi.mock('@wecode/features/vnc/openCloudDesktop', () => cloudDesktopMocks)

describe('desktopControlExtension', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValue({ connected: true })
    cloudDesktopMocks.openCloudDesktop.mockResolvedValue(true)
  })

  test('closes the embedded browser selected by label', async () => {
    await expect(
      desktopControlExtension.execute({
        action: 'closeEmbeddedBrowser',
        id: 'command-1',
        selector: 'workspace-browser',
      })
    ).resolves.toEqual({ handled: true, value: '' })

    expect(embeddedBrowserMocks.closeEmbeddedBrowser).toHaveBeenCalledWith('workspace-browser')
  })

  test('evaluates embedded browser JSON and serializes the result', async () => {
    await expect(
      desktopControlExtension.execute({
        action: 'evalEmbeddedBrowserJson',
        id: 'command-2',
        selector: 'workspace-browser',
        value: 'document.documentElement.dataset.vncConnected',
      })
    ).resolves.toEqual({ handled: true, value: '{"connected":true}' })

    expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).toHaveBeenCalledWith(
      'document.documentElement.dataset.vncConnected',
      'workspace-browser'
    )
  })

  test('prepares the embedded browser relabel regression fixture', async () => {
    await expect(
      desktopControlExtension.execute({
        action: 'prepareEmbeddedBrowserRelabelRegression',
        id: 'command-3',
        selector: '',
      })
    ).resolves.toEqual({ handled: true, value: '' })

    const bounds = { x: 0, y: 0, width: 1, height: 1 }
    expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
      'https://example.com/',
      bounds,
      'workspace-browser'
    )
    expect(embeddedBrowserMocks.relabelEmbeddedBrowser).toHaveBeenCalledWith(
      'workspace-browser',
      'workspace-browser-regression-owner'
    )
    expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
      bounds,
      false,
      'workspace-browser-regression-owner'
    )
  })

  test('opens the cloud desktop in the embedded browser for desktop E2E', async () => {
    await expect(
      desktopControlExtension.execute({
        action: 'openEmbeddedCloudDesktop',
        id: 'command-4',
        selector: '',
        value: JSON.stringify({
          apiBaseUrl: 'http://127.0.0.1:43123/api',
          deviceId: 'cloud-device-1',
          socketBaseUrl: 'http://127.0.0.1:43123',
          token: 'cloud-token',
        }),
      })
    ).resolves.toEqual({ handled: true, value: '' })

    expect(cloudDesktopMocks.openCloudDesktop).toHaveBeenCalledWith({
      connection: {
        apiBaseUrl: 'http://127.0.0.1:43123/api',
        isConnected: true,
        socketBaseUrl: 'http://127.0.0.1:43123',
        token: 'cloud-token',
      },
      deviceId: 'cloud-device-1',
      isCurrent: expect.any(Function),
      target: 'embedded',
    })
  })

  test('does not claim a shared desktop control command', async () => {
    await expect(
      desktopControlExtension.execute({
        action: 'click',
        id: 'command-5',
        selector: '#target',
      })
    ).resolves.toEqual({ handled: false })
  })
})
