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
      address: {
        deviceId: 'device-1',
        taskId: 'task-1',
      },
    })

    expect(invokeDesktopHostMock).toHaveBeenCalledWith('notification.show', {
      title: 'Task completed',
      body: 'The local task has finished.',
      url: 'wework://tasks/device-1/task-1',
    })
  })

  test('preserves a project notification destination', async () => {
    runtime.electron = true
    invokeDesktopHostMock.mockResolvedValue(undefined)

    await sendSystemNotification({
      title: 'Assigned',
      body: 'A project task was assigned.',
      url: 'wework://boards/12/issues/gitlab%3A12%2Fissue%233',
    })

    expect(invokeDesktopHostMock).toHaveBeenCalledWith('notification.show', {
      title: 'Assigned',
      body: 'A project task was assigned.',
      url: 'wework://boards/12/issues/gitlab%3A12%2Fissue%233',
    })
  })

  test('keeps notifications without a destination non-clickable', async () => {
    runtime.electron = true
    invokeDesktopHostMock.mockResolvedValue(undefined)

    await sendSystemNotification({
      title: 'Assigned',
      body: 'A project task was assigned.',
    })

    expect(invokeDesktopHostMock).toHaveBeenCalledWith('notification.show', {
      title: 'Assigned',
      body: 'A project task was assigned.',
    })
  })

  test('does nothing in a regular browser', async () => {
    await sendSystemNotification({ title: 'Title', body: 'Body' })

    expect(invokeDesktopHostMock).not.toHaveBeenCalled()
  })
})
