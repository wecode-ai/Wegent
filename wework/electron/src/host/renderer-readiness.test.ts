import { describe, expect, test, vi } from 'vitest'
import { waitForRendererSelector } from './renderer-readiness'

describe('waitForRendererSelector', () => {
  test('waits until the renderer mounts the requested surface', async () => {
    const executeJavaScript = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await waitForRendererSelector(
      {
        executeJavaScript,
        isDestroyed: () => false,
      },
      '[data-testid="workspace-tab-strip"]',
      1_000
    )

    expect(executeJavaScript).toHaveBeenCalledTimes(2)
    expect(executeJavaScript).toHaveBeenLastCalledWith(
      'Boolean(document.querySelector("[data-testid=\\"workspace-tab-strip\\"]"))'
    )
  })

  test('fails when the renderer is destroyed before mounting', async () => {
    await expect(
      waitForRendererSelector(
        {
          executeJavaScript: vi.fn().mockResolvedValue(false),
          isDestroyed: () => true,
        },
        '[data-testid="popout-workbench-page"]'
      )
    ).rejects.toThrow(
      'Renderer was destroyed before mounting [data-testid="popout-workbench-page"]'
    )
  })
})
