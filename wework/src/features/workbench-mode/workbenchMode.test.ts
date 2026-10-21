import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { APP_PREFERENCES_CHANGED_EVENT } from '@/desktop/appPreferences'
import { changeWorkbenchMode } from './workbenchMode'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))

describe('workbenchMode', () => {
  beforeEach(() => {
    vi.mocked(invokeDesktopHost).mockReset()
  })

  test('uses one host transaction and publishes the persisted preferences', async () => {
    vi.mocked(invokeDesktopHost).mockResolvedValue({ workbenchMode: 'focus' })
    const changed = vi.fn()
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, changed)
    try {
      const preferences = await changeWorkbenchMode('focus')

      expect(invokeDesktopHost).toHaveBeenCalledExactlyOnceWith('runtime.changeWorkbenchMode', {
        mode: 'focus',
      })
      expect(preferences.workbenchMode).toBe('focus')
      expect(changed).toHaveBeenCalledOnce()
      expect(changed.mock.calls[0][0].detail).toEqual(preferences)
    } finally {
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, changed)
    }
  })

  test('does not roll back an accepted mode when a reload loses the response', async () => {
    vi.mocked(invokeDesktopHost).mockRejectedValue(new Error('response lost during reload'))

    await expect(changeWorkbenchMode('focus')).rejects.toThrow('response lost during reload')

    expect(invokeDesktopHost).toHaveBeenCalledExactlyOnceWith('runtime.changeWorkbenchMode', {
      mode: 'focus',
    })
  })
})
