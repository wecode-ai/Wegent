import { describe, expect, test, vi } from 'vitest'
import { restoreComputerUseAfterStartup } from './computer-use-startup.js'

describe('restoreComputerUseAfterStartup', () => {
  test('restores enabled computer use after startup', async () => {
    const setEnabled = vi.fn().mockResolvedValue(undefined)

    await restoreComputerUseAfterStartup({
      isShuttingDown: () => false,
      readPreferences: async () => ({ computerUseEnabled: true }),
      setEnabled,
    })

    expect(setEnabled).toHaveBeenCalledOnce()
    expect(setEnabled).toHaveBeenCalledWith(true)
  })

  test('does not initialize computer use when it is disabled', async () => {
    const setEnabled = vi.fn().mockResolvedValue(undefined)

    await restoreComputerUseAfterStartup({
      isShuttingDown: () => false,
      readPreferences: async () => ({ computerUseEnabled: false }),
      setEnabled,
    })

    expect(setEnabled).not.toHaveBeenCalled()
  })

  test('does not initialize computer use during shutdown', async () => {
    const setEnabled = vi.fn().mockResolvedValue(undefined)
    let shuttingDown = false

    await restoreComputerUseAfterStartup({
      isShuttingDown: () => shuttingDown,
      readPreferences: async () => {
        shuttingDown = true
        return { computerUseEnabled: true }
      },
      setEnabled,
    })

    expect(setEnabled).not.toHaveBeenCalled()
  })
})
