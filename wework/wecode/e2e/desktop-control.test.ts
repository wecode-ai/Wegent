import { beforeEach, describe, expect, test, vi } from 'vitest'

import { desktopControlExtension } from '@wecode/extensions/desktop-control'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn(),
  evalEmbeddedBrowserJson: vi.fn(),
  openEmbeddedBrowser: vi.fn(),
  relabelEmbeddedBrowser: vi.fn(),
  setEmbeddedBrowserBounds: vi.fn(),
}))
vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

describe('desktopControlExtension', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValue({ connected: true })
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
