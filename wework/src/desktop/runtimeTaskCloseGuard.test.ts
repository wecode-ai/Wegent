import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import {
  closeMainWindowToTray,
  hasRunningRuntimeTasks,
  installRuntimeTaskCloseGuard,
  shouldPreventRuntimeTaskClose,
} from './runtimeTaskCloseGuard'

const desktopHostMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
  subscribeDesktopHostEvents: desktopHostMocks.subscribe,
}))

function runtimeWorkWithTasks(tasks: Array<{ running?: boolean }>): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 1, key: 'project-1', name: 'Project 1' },
        deviceWorkspaces: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/workspace',
            tasks: tasks.map((task, index) => ({
              taskId: `task-${index}`,
              workspacePath: '/workspace',
              title: `Task ${index}`,
              runtime: 'codex',
              ...task,
            })),
          },
        ],
      },
    ],
    chats: [],
    totalTasks: tasks.length,
  }
}

function lifecycleWithTasks(tasks: Array<{ running?: boolean }>) {
  const store = new RuntimeTaskLifecycleStore('close-guard-test')
  store.syncRuntimeWork(runtimeWorkWithTasks(tasks))
  return store.getSnapshot()
}

describe('runtime task close guard', () => {
  beforeEach(() => {
    desktopHostMocks.invoke.mockReset()
    desktopHostMocks.subscribe.mockReset()
  })

  test('detects running tasks across runtime work', () => {
    expect(hasRunningRuntimeTasks(lifecycleWithTasks([{ running: false }]))).toBe(false)
    expect(hasRunningRuntimeTasks(lifecycleWithTasks([{ running: true }]))).toBe(true)
  })

  test('does not prompt when no runtime task is running', () => {
    const confirmClose = vi.fn()

    expect(shouldPreventRuntimeTaskClose(lifecycleWithTasks([]), confirmClose)).toBe(false)
    expect(confirmClose).not.toHaveBeenCalled()
  })

  test('prevents close when running tasks exist and the user cancels', () => {
    const confirmClose = vi.fn().mockReturnValue(false)

    expect(
      shouldPreventRuntimeTaskClose(lifecycleWithTasks([{ running: true }]), confirmClose)
    ).toBe(true)
    expect(confirmClose).toHaveBeenCalledTimes(1)
  })

  test('does not prevent close decision when running tasks exist and the user confirms', () => {
    const confirmClose = vi.fn().mockReturnValue(true)

    expect(
      shouldPreventRuntimeTaskClose(lifecycleWithTasks([{ running: true }]), confirmClose)
    ).toBe(false)
    expect(confirmClose).toHaveBeenCalledTimes(1)
  })

  test('subscribes to close-to-tray requests from the Electron host', async () => {
    const onCloseToTrayHintRequest = vi.fn()
    const dispose = vi.fn()
    desktopHostMocks.subscribe.mockImplementation(handler => {
      handler({
        sequence: 1,
        type: 'window.close-to-tray-requested',
        payload: {},
      })
      return dispose
    })

    const unlisten = await installRuntimeTaskCloseGuard(onCloseToTrayHintRequest)

    expect(desktopHostMocks.subscribe).toHaveBeenCalledOnce()
    expect(onCloseToTrayHintRequest).toHaveBeenCalledOnce()
    unlisten()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('closes the main window to tray through the Electron host', async () => {
    desktopHostMocks.invoke.mockResolvedValue(undefined)

    await closeMainWindowToTray()

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('window.closeToTray')
  })
})
