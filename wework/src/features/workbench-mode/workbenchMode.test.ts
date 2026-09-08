import { describe, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { changeWorkbenchMode } from './workbenchMode'

function dependencies(
  overrides: Partial<{
    restartPlugins: () => Promise<void>
    updatePreferences: (patch: {
      workbenchMode: 'focus' | 'developer'
    }) => Promise<typeof defaultAppPreferences>
  }> = {}
) {
  return {
    restartPlugins: vi.fn().mockResolvedValue(undefined),
    updatePreferences: vi
      .fn()
      .mockImplementation(async patch => ({ ...defaultAppPreferences, ...patch })),
    ...overrides,
  }
}

describe('workbenchMode', () => {
  test('persists focus mode and restarts the plugin runtime', async () => {
    const actions = dependencies()

    const preferences = await changeWorkbenchMode('developer', 'focus', actions)

    expect(actions.updatePreferences).toHaveBeenCalledWith({ workbenchMode: 'focus' })
    expect(actions.restartPlugins).toHaveBeenCalledOnce()
    expect(preferences.workbenchMode).toBe('focus')
  })

  test('does not restart when the selected mode is unchanged', async () => {
    const actions = dependencies()

    await changeWorkbenchMode('developer', 'developer', actions)

    expect(actions.restartPlugins).not.toHaveBeenCalled()
  })

  test('does not restart when saving the preference fails', async () => {
    const actions = dependencies({
      updatePreferences: vi.fn().mockRejectedValue(new Error('save failed')),
    })

    await expect(changeWorkbenchMode('developer', 'focus', actions)).rejects.toThrow('save failed')

    expect(actions.restartPlugins).not.toHaveBeenCalled()
  })

  test('restores the previous preference when scheduling the restart fails', async () => {
    const actions = dependencies({
      restartPlugins: vi.fn().mockRejectedValue(new Error('restart failed')),
    })

    await expect(changeWorkbenchMode('developer', 'focus', actions)).rejects.toThrow(
      'restart failed'
    )
    expect(actions.updatePreferences.mock.calls).toEqual([
      [{ workbenchMode: 'focus' }],
      [{ workbenchMode: 'developer' }],
    ])
  })

  test('propagates both restart and preference rollback failures', async () => {
    const restartError = new Error('restart failed')
    const rollbackError = new Error('rollback failed')
    const actions = dependencies({
      restartPlugins: vi.fn().mockRejectedValue(restartError),
      updatePreferences: vi
        .fn()
        .mockResolvedValueOnce({ ...defaultAppPreferences, workbenchMode: 'focus' })
        .mockRejectedValueOnce(rollbackError),
    })

    const failure = await changeWorkbenchMode('developer', 'focus', actions).catch(
      error => error as AggregateError
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([restartError, rollbackError])
  })
})
