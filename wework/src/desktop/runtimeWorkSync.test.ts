import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import {
  installMainRuntimeWorkChangedListener,
  notifyMainRuntimeWorkChanged,
  RUNTIME_WORK_CHANGED_EVENT,
} from './runtimeWorkSync'

vi.mock('@/lib/runtime-environment', () => ({
  getDesktopWindowLabel: vi.fn(),
}))

const getDesktopWindowLabelMock = vi.mocked(getDesktopWindowLabel)

describe('runtimeWorkSync', () => {
  beforeEach(() => {
    localStorage.clear()
    getDesktopWindowLabelMock.mockReset()
  })

  test('notifies the main window through storage from a popout window', async () => {
    getDesktopWindowLabelMock.mockReturnValue('popout-window')

    await notifyMainRuntimeWorkChanged({ deviceId: 'local-device', taskId: 'task-1' })

    expect(localStorage.getItem(RUNTIME_WORK_CHANGED_EVENT)).toBe(
      JSON.stringify({ deviceId: 'local-device', taskId: 'task-1' })
    )
  })

  test('does not notify when the change originates from the main window', async () => {
    getDesktopWindowLabelMock.mockReturnValue('main')

    await notifyMainRuntimeWorkChanged({ deviceId: 'local-device', taskId: 'task-1' })

    expect(localStorage.getItem(RUNTIME_WORK_CHANGED_EVENT)).toBeNull()
  })

  test('refreshes runtime work when the main window receives the storage event', async () => {
    getDesktopWindowLabelMock.mockReturnValue('main')
    const refreshRuntimeWork = vi.fn().mockResolvedValue(undefined)

    const dispose = await installMainRuntimeWorkChangedListener(refreshRuntimeWork)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: RUNTIME_WORK_CHANGED_EVENT,
        newValue: JSON.stringify({ deviceId: 'local-device', taskId: 'task-1' }),
      })
    )

    await vi.waitFor(() => expect(refreshRuntimeWork).toHaveBeenCalledOnce())
    dispose?.()
  })

  test('does not install the refresh listener in a popout window', () => {
    getDesktopWindowLabelMock.mockReturnValue('popout-window')

    expect(installMainRuntimeWorkChangedListener(vi.fn())).toBeNull()
  })
})
