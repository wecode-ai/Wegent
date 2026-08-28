import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { sendSystemNotification } from './runtimeTaskSystemNotifications'

const runtime = vi.hoisted(() => ({
  electron: false,
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => runtime.electron,
}))

const invokeDesktopHostMock = vi.mocked(invokeDesktopHost)

describe('runtime task system notifications', () => {
  beforeEach(() => {
    runtime.electron = false
    invokeDesktopHostMock.mockReset()
  })

  test('uses the Electron notification capability', async () => {
    runtime.electron = true
    invokeDesktopHostMock.mockResolvedValue(undefined)

    await sendSystemNotification({
      title: 'Task completed',
      body: 'The local task has finished.',
    })

    expect(invokeDesktopHostMock).toHaveBeenCalledWith('notification.show', {
      title: 'Task completed',
      body: 'The local task has finished.',
    })
  })

  test('does nothing in a regular browser', async () => {
    await sendSystemNotification({ title: 'Title', body: 'Body' })

    expect(invokeDesktopHostMock).not.toHaveBeenCalled()
  })
})
