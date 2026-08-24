import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import {
  closeMainWindowToTray,
  hasRunningRuntimeTasks,
  installRuntimeTaskCloseGuard,
  shouldPreventRuntimeTaskClose,
} from './runtimeTaskCloseGuard'

const desktopInvokeMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopInvokeMock,
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
    desktopInvokeMock.mockReset()
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

  test('polls the Electron host for close-to-tray requests', async () => {
    vi.useFakeTimers()
    const onCloseToTrayHintRequest = vi.fn()
    desktopInvokeMock.mockResolvedValueOnce({ requested: true, revision: 3 })

    const dispose = await installRuntimeTaskCloseGuard(onCloseToTrayHintRequest)
    await vi.runOnlyPendingTimersAsync()

    expect(desktopInvokeMock).toHaveBeenCalledWith('window.closeRequestState', { after: 0 })
    expect(onCloseToTrayHintRequest).toHaveBeenCalledOnce()
    dispose()
    vi.useRealTimers()
  })

  test('closes the main window to tray through the Electron host', async () => {
    desktopInvokeMock.mockResolvedValue(undefined)

    await closeMainWindowToTray()

    expect(desktopInvokeMock).toHaveBeenCalledWith('window.closeToTray')
  })
})
